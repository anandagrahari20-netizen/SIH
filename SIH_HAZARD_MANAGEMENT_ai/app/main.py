from fastapi import FastAPI, HTTPException, UploadFile, File, Request, Response
from fastapi.middleware.cors import CORSMiddleware

import requests
from app.schemas import (
    AllocationResponse,
    AnalyzeRequest,
    AnalyzeResponse,
    Confidence,
    HelplineTurnRequest,
    HelplineTurnResponse,
    Incident,
    IncidentUpdate,
    Resource,
    ResourceBulkRequest,
    ResourceBulkResponse,
    ResourceCreate,
    ResourceUpdate,
)

import hashlib
import json
import os
import tempfile
import time
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import credentials, firestore

# Initialize Firebase connection.
# The service account key is a SECRET and is NOT in this repo. Credentials are
# resolved in this order:
#   1. env var  FIREBASE_SERVICE_ACCOUNT_JSON  (the JSON, one line)  — Render
#   2. a local file firebase-service-account.json  (git-ignored)     — local dev
#        generate it: Firebase console -> Project settings -> Service accounts
#                     -> Generate new private key
#   3. Application Default Credentials                               — Firebase
#        Cloud Functions / Cloud Run: the platform injects a runtime service
#        account, so no key file is needed. Detected via the K_SERVICE /
#        FUNCTION_TARGET / GOOGLE_CLOUD_PROJECT env vars it also injects.
if not firebase_admin._apps:
    _sa_raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    _sa_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_PATH", "firebase-service-account.json")
    if _sa_raw:
        firebase_admin.initialize_app(credentials.Certificate(json.loads(_sa_raw)))
    elif os.path.exists(_sa_path):
        firebase_admin.initialize_app(credentials.Certificate(_sa_path))
    elif (
        os.environ.get("K_SERVICE")
        or os.environ.get("FUNCTION_TARGET")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
    ):
        firebase_admin.initialize_app()
    else:
        raise RuntimeError(
            "No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON, or place a "
            "firebase-service-account.json next to the app (see "
            "firebase-service-account.example.json)."
        )
db = firestore.client()

from app.analyzer import extract_facts
from app.transcription import transcribe_audio
from app.severity import calculate_severity_features
from app.priority import calculate_priority
from app.aggregation import aggregate_incidents
from app.language import normalize_hindi_script
from app.resource_allocator import run_allocation, _same_district
from app.helpline import handle_turn as helpline_handle_turn

app = FastAPI(
    title="SIH Citizen Intelligence API",
    description="AI-assisted disaster citizen message analysis",
    version="1.0.0",
)

# The dashboard (SIH_HAZARD_MANAGEMENT) is a static site that can be
# opened directly from disk or served from any local port during
# development, so its origin isn't fixed. This is a prototype/
# hackathon deployment with no cookie-based auth (no credentials are
# sent), so a permissive origin policy is the pragmatic choice here.
# Tighten allow_origins to the real deployed dashboard origin(s) once
# this ships beyond local development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory incident store.
# This will later be replaced by a database.
incidents = {}

# In-memory resource store.
# This will later be replaced by a database.
resources = {}

def generate_incident_id() -> str:
    return f"INC-{len(incidents) + 1:03d}"

def generate_resource_id() -> str:
    return f"RES-{len(resources) + 1:03d}"

@app.get("/")
def root():
    return {
        "status": "online",
        "service": "SIH Citizen Intelligence API",
    }

def calculate_confidence(facts):
    return Confidence(
        needs=1.0 if facts.needs else 0.0,
        people_count=1.0 if facts.people_count is not None else 0.0,
        trapped=1.0 if facts.trapped is not None else 0.0,
        injured=1.0 if facts.injured is not None else 0.0,
    )

@app.post("/analyze", response_model=AnalyzeResponse)
def analyze_citizen_message(request: AnalyzeRequest):

    # --------------------------------------------------------
    # 1. AI / NLP EXTRACTION
    # --------------------------------------------------------
    facts = extract_facts(request.text)

    # --------------------------------------------------------
    # 2. DETERMINISTIC SEVERITY FEATURES
    # --------------------------------------------------------
    severity_features = calculate_severity_features(facts)

    # --------------------------------------------------------
    # 3. DETERMINISTIC PRIORITY ASSESSMENT
    # --------------------------------------------------------
    priority = calculate_priority(
        facts,
        severity_features,
    )

    # --------------------------------------------------------
    # 4. CONFIDENCE
    # --------------------------------------------------------
    confidence = calculate_confidence(facts)

    # --------------------------------------------------------
    # 5. FINAL API RESPONSE
    # --------------------------------------------------------
    return AnalyzeResponse(
        request_id=request.request_id,
        language=request.language,
        facts=facts,
        severity_features=severity_features,
        priority=priority,
        confidence=confidence,
    )

@app.post("/helpline/turn", response_model=HelplineTurnResponse)
def helpline_turn(request: HelplineTurnRequest):
    """
    One turn of the AI emergency helpline conversation.

    The LLM (Ollama -> Groq -> Gemini -> scripted fallback) produces the
    spoken reply; the severity/priority in the response come from the
    same deterministic pipeline as /analyze, computed over everything the
    caller has said so far.

    When the conversation reaches `done`, the backend itself files a
    fully GEO-TAGGED emergency report from the call: the caller's live
    coordinates + district, everything the analyzer extracted from the
    whole transcript (needs, headcount, trapped, injured, vulnerable
    people, environmental conditions) and the computed priority. The
    incident lands in Firestore, so the dashboard's dispatch board and
    the allocator pick it up with no extra call from the phone.
    """
    result = helpline_handle_turn(
        language=request.language,
        history=[m.model_dump() for m in request.history],
        user_text=request.user_text,
    )

    incident_id = None
    incident_filed = False

    if result.get("done") and request.file_incident:
        try:
            incident_id, incident_filed = _file_helpline_incident(
                request, result
            )
        except Exception as exc:
            # A failed write must never break the call — the phone
            # still has its own Firestore fallback path.
            print(f"[helpline] incident filing failed: {exc}")

    return HelplineTurnResponse(
        **result,
        incident_id=incident_id,
        incident_filed=incident_filed,
    )


def _file_helpline_incident(
    request: HelplineTurnRequest,
    result: dict,
) -> tuple[str, bool]:
    """
    Turn a completed helpline call into a geo-tagged Incident.

    Everything useful the AI pulled out of the conversation is carried
    across, so the control room sees a structured report rather than a
    raw transcript.
    """

    facts = result["facts"]
    severity_features = result["severity_features"]
    priority = result["priority"]

    incident_id = generate_incident_id()

    caller = request.caller_name or "Caller"
    where = request.district or facts.location_mentioned or "unknown location"

    summary = (
        f"AI helpline call from {caller} near {where}. "
        f"{result.get('transcript', '').strip()}"
    ).strip()

    incident = Incident(
        incident_id=incident_id,
        request_id=request.session_id or incident_id,
        created_at=datetime.now(timezone.utc).isoformat(),
        latitude=request.latitude,
        longitude=request.longitude,
        state=request.state,
        district=request.district,
        text=summary,
        source="kavach_helpline",
        transcript=result.get("transcript", ""),
        caller_name=request.caller_name,
        caller_mobile=request.caller_mobile,
        facts=facts,
        severity_features=severity_features,
        priority=priority,
        confidence=calculate_confidence(facts),
    )

    incidents[incident_id] = incident

    payload = incident.model_dump()
    payload["language"] = request.language

    db.collection("incidents").document(incident_id).set(payload)

    return incident_id, True

@app.post("/voice-analyze")
async def analyze_voice(
    audio: UploadFile = File(...)
):
    """
    Analyze a citizen voice recording.

    Pipeline:
    Audio -> Whisper -> Hindi/Roman Hindi normalization
    -> NLP extraction -> severity -> priority
    """
    suffix = os.path.splitext(
        audio.filename or ""
    )[1]

    if not suffix:
        suffix = ".wav"

    temp_path = None

    try:
        # ----------------------------------------------------
        # 1. SAVE AUDIO
        # ----------------------------------------------------
        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=suffix,
        ) as temp_file:
            temp_path = temp_file.name
            content = await audio.read()
            temp_file.write(content)

        # ----------------------------------------------------
        # 2. WHISPER TRANSCRIPTION (optional dependency)
        # ----------------------------------------------------
        try:
            transcription = transcribe_audio(temp_path)
        except RuntimeError as exc:
            raise HTTPException(status_code=501, detail=str(exc))
        transcript = transcription["text"]

        if not transcript:
            raise HTTPException(
                status_code=400,
                detail="Could not transcribe audio",
            )

        # ----------------------------------------------------
        # 3. DEVANAGARI -> ROMAN HINDI
        # ----------------------------------------------------
        normalized_text = normalize_hindi_script(
            transcript
        )

        # ----------------------------------------------------
        # 4. EXISTING NLP PIPELINE
        # ----------------------------------------------------
        facts = extract_facts(
            normalized_text
        )

        # ----------------------------------------------------
        # 5. SEVERITY
        # ----------------------------------------------------
        severity_features = (
            calculate_severity_features(
                facts
            )
        )

        # ----------------------------------------------------
        # 6. PRIORITY
        # ----------------------------------------------------
        priority = calculate_priority(
            facts,
            severity_features,
        )

        # ----------------------------------------------------
        # 7. RESPONSE
        # ----------------------------------------------------
        return {
            "transcription": {
                "text": transcript,
                "normalized_text": normalized_text,
                "detected_language": (
                    transcription[
                        "detected_language"
                    ]
                ),
                "language_probability": (
                    transcription[
                        "language_probability"
                    ]
                ),
            },
            "facts": facts,
            "severity_features": severity_features,
            "priority": priority,
        }

    finally:
        # ----------------------------------------------------
        # 8. CLEAN TEMP FILE
        # ----------------------------------------------------
        if temp_path and os.path.exists(
            temp_path
        ):
            os.remove(temp_path)

@app.post("/incidents", response_model=Incident)
def create_incident(request: AnalyzeRequest):

    # --------------------------------------------------------
    # 1. AI / NLP EXTRACTION
    # --------------------------------------------------------
    facts = extract_facts(request.text)

    # --------------------------------------------------------
    # 2. DETERMINISTIC SEVERITY FEATURES
    # --------------------------------------------------------
    severity_features = calculate_severity_features(facts)

    # --------------------------------------------------------
    # 3. DETERMINISTIC PRIORITY ASSESSMENT
    # --------------------------------------------------------
    priority = calculate_priority(
        facts,
        severity_features,
    )

    # --------------------------------------------------------
    # 4. CONFIDENCE
    # --------------------------------------------------------
    confidence = calculate_confidence(facts)

    # --------------------------------------------------------
    # 5. CREATE INCIDENT
    # --------------------------------------------------------
    incident_id = generate_incident_id()

    incident = Incident(
        incident_id=incident_id,
        request_id=request.request_id,
        created_at=request.timestamp or "",
        latitude=request.latitude,
        longitude=request.longitude,
        # Carried through so allocation can hard-partition by district.
        state=request.state,
        district=request.district,
        # The citizen's own words — this is the description the
        # dispatch board shows the operator.
        text=request.text,
        source=request.source,
        facts=facts,
        severity_features=severity_features,
        priority=priority,
        confidence=confidence,
    )

    # --------------------------------------------------------
    # 6. STORE INCIDENT
    # --------------------------------------------------------
    incidents[incident_id] = incident

    # Push to live Firebase Firestore
    doc_ref = db.collection("incidents").document(incident_id)
    doc_ref.set(incident.model_dump())

    return incident

@app.get("/incidents", response_model=list[Incident])
def get_incidents(district: str | None = None):
    # Read through to Firestore so the list survives a cold start and
    # includes incidents the Kavach app wrote directly.
    return _load_incidents(district)

@app.get("/incidents/aggregation")
def get_incident_aggregation(district: str | None = None):
    """
    Cluster related incidents into area-level demand hotspots.

    Each entry carries a centroid + `report_count`, which the dashboard
    draws as a complaint-density dot whose radius grows with the number
    of reports coming from that spot.

    Reads through to Firestore (see _load_incidents) so the result is
    correct after a cold start and includes incidents the Kavach app
    wrote directly.
    """
    return aggregate_incidents(_load_incidents(district))

@app.get("/incidents/{incident_id}", response_model=Incident)
def get_incident(incident_id: str):
    if incident_id not in incidents:
        raise HTTPException(
            status_code=404,
            detail="Incident not found",
        )
    return incidents[incident_id]

@app.patch("/incidents/{incident_id}", response_model=Incident)
def update_incident(
    incident_id: str,
    update: IncidentUpdate,
):

    # --------------------------------------------------------
    # 1. CHECK INCIDENT EXISTS
    # --------------------------------------------------------
    if incident_id not in incidents:
        raise HTTPException(
            status_code=404,
            detail="Incident not found",
        )

    incident = incidents[incident_id]

    # --------------------------------------------------------
    # 2. UPDATE STATUS
    # --------------------------------------------------------
    if update.status is not None:
        current_status = incident.status
        new_status = update.status

        allowed_transitions = {
            "UNASSIGNED": ["ASSIGNED"],
            "ASSIGNED": ["IN_PROGRESS"],
            "IN_PROGRESS": ["RESOLVED"],
            "RESOLVED": [],
        }

        if new_status != current_status:
            if new_status not in allowed_transitions[current_status]:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Invalid status transition: "
                        f"{current_status} -> {new_status}"
                    ),
                )

            incident.status = new_status

    # --------------------------------------------------------
    # 3. UPDATE ASSIGNED TEAM
    # --------------------------------------------------------
    if update.assigned_team is not None:
        incident.assigned_team = update.assigned_team

    # --------------------------------------------------------
    # 4. UPDATE ASSIGNED RESOURCE
    # --------------------------------------------------------
    if update.assigned_resource is not None:
        incident.assigned_resource = update.assigned_resource

    # --------------------------------------------------------
    # 5. VALIDATE ASSIGNMENT
    # --------------------------------------------------------
    if incident.status in ["ASSIGNED", "IN_PROGRESS"]:
        if (
            incident.assigned_team is None
            and incident.assigned_resource is None
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Assigned team or resource is required "
                    "for this status"
                ),
            )

    # --------------------------------------------------------
    # 6. SAVE UPDATED INCIDENT
    # --------------------------------------------------------
    incidents[incident_id] = incident

    # Push status updates to Firebase Firestore
    doc_ref = db.collection("incidents").document(incident_id)
    doc_ref.set(incident.model_dump(), merge=True)

    return incident

@app.post("/resources", response_model=Resource)
def create_resource(request: ResourceCreate):

    resource_id = generate_resource_id()

    available_units = (
        request.available_units
        if request.available_units is not None
        else request.total_units
    )

    resource = Resource(
        resource_id=resource_id,
        name=request.name,
        type=request.type,
        latitude=request.latitude,
        longitude=request.longitude,
        total_units=request.total_units,
        available_units=available_units,
        capacity_per_unit=request.capacity_per_unit,
    )

    resources[resource_id] = resource

    doc_ref = db.collection("resources").document(resource_id)
    doc_ref.set(resource.model_dump())

    return resource

@app.get("/resources", response_model=list[Resource])
def get_resources(district: str | None = None):
    # Firestore-backed: the dashboard resolves each allocation decision
    # to a map position through this endpoint, so it must not come back
    # empty just because this container is freshly started.
    return _load_resources(district)

def _stable_resource_id(district: str | None, kind: str, lat: float, lon: float) -> str:
    """
    Deterministic id for a discovered facility.

    Re-running district discovery must map the same physical facility
    back to the same document, otherwise every sweep would either
    duplicate it or reset the availability of units that are already
    dispatched. Coordinates are rounded to ~11 m, which is well inside
    the 150 m spatial de-duplication the dashboard already applies.
    """

    seed = f"{(district or 'NA').strip().lower()}|{kind}|{lat:.4f}|{lon:.4f}"
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
    return f"RES-{digest}"


@app.post("/resources/bulk", response_model=ResourceBulkResponse)
def bulk_create_resources(request: ResourceBulkRequest):
    """
    Upsert the district's resources. Used by the dashboard after it
    discovers real facilities (hospitals, police stations, fire
    stations) for the selected district, so /allocate works against the
    same real locations the operator can see on the map.

    Each facility gets a deterministic id (see _stable_resource_id), so
    a repeat sweep updates in place: no duplicates, and units already
    dispatched keep their reduced availability. Pass replace=true to
    also drop district resources missing from this payload.
    """

    existing = {
        resource.resource_id: resource
        for resource in _load_resources(request.district)
    }

    created = []
    seen: set[str] = set()

    for item in request.resources:
        district = item.district or request.district
        resource_id = _stable_resource_id(
            district, item.type, item.latitude, item.longitude
        )
        seen.add(resource_id)

        previous = existing.get(resource_id)

        # Preserve dispatched availability across re-imports; only a
        # brand-new facility starts at full strength.
        if previous is not None:
            available_units = min(previous.available_units, item.total_units)
            status = previous.status
        else:
            available_units = (
                item.available_units
                if item.available_units is not None
                else item.total_units
            )
            status = "ACTIVE"

        resource = Resource(
            resource_id=resource_id,
            name=item.name,
            type=item.type,
            latitude=item.latitude,
            longitude=item.longitude,
            total_units=item.total_units,
            available_units=available_units,
            capacity_per_unit=item.capacity_per_unit,
            status=status,
            state=item.state or request.state,
            district=district,
        )

        resources[resource_id] = resource
        db.collection("resources").document(resource_id).set(
            resource.model_dump()
        )
        created.append(resource)

    removed_count = 0

    if request.replace and request.district is not None:
        stale_ids = [
            resource_id
            for resource_id, resource in existing.items()
            if resource.district == request.district and resource_id not in seen
        ]
        for resource_id in stale_ids:
            resources.pop(resource_id, None)
            db.collection("resources").document(resource_id).delete()
        removed_count = len(stale_ids)

    return ResourceBulkResponse(
        state=request.state,
        district=request.district,
        removed_count=removed_count,
        created=created,
    )

@app.get("/resources/{resource_id}", response_model=Resource)
def get_resource(resource_id: str):
    if resource_id not in resources:
        raise HTTPException(
            status_code=404,
            detail="Resource not found",
        )
    return resources[resource_id]

@app.patch("/resources/{resource_id}", response_model=Resource)
def update_resource(
    resource_id: str,
    update: ResourceUpdate,
):
    if resource_id not in resources:
        raise HTTPException(
            status_code=404,
            detail="Resource not found",
        )

    resource = resources[resource_id]

    if update.available_units is not None:
        if update.available_units > resource.total_units:
            raise HTTPException(
                status_code=400,
                detail=(
                    "available_units cannot exceed total_units "
                    f"({resource.total_units})"
                ),
            )
        resource.available_units = update.available_units

    if update.status is not None:
        resource.status = update.status

    if update.latitude is not None:
        resource.latitude = update.latitude

    if update.longitude is not None:
        resource.longitude = update.longitude

    resources[resource_id] = resource

    doc_ref = db.collection("resources").document(resource_id)
    doc_ref.set(resource.model_dump(), merge=True)

    return resource

# ============================================================
# FIRESTORE-BACKED READS
#
# This service runs on Cloud Run, which scales to zero -- the
# in-memory `incidents` / `resources` dicts are empty after every
# cold start, and citizens can also write incidents to Firestore
# directly from the Kavach app. Firestore is therefore the source
# of truth for allocation; the in-memory store is merged on top so
# anything created in this process is never missed.
# ============================================================

def _load_incidents(district: str | None = None) -> list[Incident]:
    """
    Every unresolved incident, merged from Firestore + this process.

    When `district` is given the result is scoped to that district.
    This is what stops one city's incidents pulling in another city's
    resources -- previously this function ignored the district while
    _load_resources honoured it, so /allocate happily matched a Kanpur
    ambulance to a Bhubaneswar incident 600 km away.
    """

    merged: dict[str, Incident] = {}

    try:
        for doc in db.collection("incidents").stream():
            data = doc.to_dict() or {}
            data.setdefault("incident_id", doc.id)
            data.setdefault("request_id", doc.id)
            data.setdefault("created_at", "")
            try:
                merged[data["incident_id"]] = Incident(**data)
            except Exception:
                # A malformed document must never break allocation.
                continue
    except Exception as exc:  # network / permission issue
        print(f"[allocate] Firestore incident read failed: {exc}")

    merged.update(incidents)

    result = list(merged.values())

    if district is not None:
        result = [
            incident
            for incident in result
            if _same_district(district, incident.district)
        ]

    return result


def _load_resources(district: str | None = None) -> list[Resource]:

    merged: dict[str, Resource] = {}

    try:
        query = db.collection("resources")
        if district is not None:
            query = query.where("district", "==", district)
        for doc in query.stream():
            data = doc.to_dict() or {}
            data.setdefault("resource_id", doc.id)
            try:
                merged[data["resource_id"]] = Resource(**data)
            except Exception:
                continue
    except Exception as exc:
        print(f"[allocate] Firestore resource read failed: {exc}")

    for resource_id, resource in resources.items():
        if district is None or resource.district == district:
            merged[resource_id] = resource

    return list(merged.values())


@app.get("/allocate", response_model=AllocationResponse)
def allocate_resources(district: str | None = None):
    """
    Recommend how available resources should be relocated to
    unresolved incidents.

    Clusters are served in strict severity order (CRITICAL, then
    HIGH, then MEDIUM, then LOW); the learned urgency score only
    breaks ties within a tier. Each cluster's needs are matched to
    compatible resource types and ranked by distance/ETA,
    availability, and a spread factor that stops the whole district
    being dispatched to one facility.

    This is ADVISORY only -- it does not change any state. Use
    POST /allocate/commit to actually deduct the units.

    `district` hard-partitions BOTH sides: only that district's
    incidents are queued and only that district's resources can serve
    them. A resource is additionally never dispatched further than
    MAX_DISPATCH_KM, so cross-city dispatch is impossible even when a
    legacy record is missing its district field.
    """
    return run_allocation(
        _load_incidents(district),
        _load_resources(district),
        district=district,
    )


@app.post("/allocate/commit", response_model=AllocationResponse)
def commit_allocation(district: str | None = None):
    """
    Run the allocator AND apply the result:

      - every allocated unit is deducted from the resource's
        available_units (in memory and in Firestore), so the next
        allocation only sees units that are genuinely still free;
      - every incident in an allocated cluster moves to ASSIGNED
        with the dispatched resource recorded.

    The authority dashboard calls this when the operator confirms a
    relocation run. Final override always stays with the operator
    via PATCH /incidents/{id} and PATCH /resources/{id}.
    """

    incident_list = _load_incidents(district)
    resource_list = _load_resources(district)

    result = run_allocation(incident_list, resource_list, district=district)

    resource_by_id = {r.resource_id: r for r in resource_list}
    incident_by_id = {i.incident_id: i for i in incident_list}

    # ---- 1. deduct availability -----------------------------
    for change in result.resource_changes:
        resource = resource_by_id.get(change.resource_id)
        if resource is None:
            continue

        resource.available_units = max(0, change.available_after)
        resources[resource.resource_id] = resource

        try:
            db.collection("resources").document(resource.resource_id).set(
                {
                    "available_units": resource.available_units,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
                merge=True,
            )
        except Exception as exc:
            print(f"[commit] resource write failed {resource.resource_id}: {exc}")

    # ---- 2. mark served incidents ASSIGNED -------------------
    for cluster in result.clusters:
        if not cluster.decisions:
            continue

        # The unit that will arrive FIRST is what the citizen is told
        # about — sort by ETA, not by allocation order.
        lead = min(cluster.decisions, key=lambda d: d.eta_minutes)

        assigned_ids = ", ".join(
            sorted({d.resource_id for d in cluster.decisions})
        )
        now_iso = datetime.now(timezone.utc).isoformat()

        for incident_id in cluster.incident_ids:
            incident = incident_by_id.get(incident_id)
            if incident is None or incident.status == "RESOLVED":
                continue

            # AUTO-ADVANCE. In a live emergency nobody has time to move
            # every incident through the status flow by hand, so
            # committing an allocation moves it straight to IN_PROGRESS
            # ("responders en route"). The operator can still override
            # via PATCH /incidents/{id}.
            if incident.status in ("UNASSIGNED", "ASSIGNED"):
                incident.status = "IN_PROGRESS"

            incident.assigned_resource = assigned_ids
            incident.assigned_team = lead.resource_name
            incident.assigned_resource_type = lead.resource_type
            incident.assigned_eta_minutes = lead.eta_minutes
            incident.assigned_distance_km = lead.distance_km
            incident.assigned_at = now_iso
            incidents[incident_id] = incident

            try:
                db.collection("incidents").document(incident_id).set(
                    {
                        "status": incident.status,
                        "assigned_resource": incident.assigned_resource,
                        "assigned_team": incident.assigned_team,
                        "assigned_resource_type": incident.assigned_resource_type,
                        "assigned_eta_minutes": incident.assigned_eta_minutes,
                        "assigned_distance_km": incident.assigned_distance_km,
                        "assigned_at": now_iso,
                        "updated_at": now_iso,
                    },
                    merge=True,
                )
            except Exception as exc:
                print(f"[commit] incident write failed {incident_id}: {exc}")

    result.committed = True
    return result


# ============================================================
# SACHET (NDMA) CORS PROXY
# ------------------------------------------------------------
# sachet.ndma.gov.in blocks browser CORS and generic third-party
# proxies. Fetching it server-side from here avoids CORS entirely,
# and Google Cloud egress is blocked far less than Cloudflare's.
# The dashboard/Kavach point RESQNET_SACHET_PROXY at "/api/sachet"
# and swap the origin, so this sees the original SACHET path:
#   GET /api/sachet/cap_public_website/rss/rss_india.xml?...
# ============================================================
_SACHET_ORIGIN = "https://sachet.ndma.gov.in"
_SACHET_ALLOWED = (
    "cap_public_website/rss/rss_india.xml",
    "cap_public_website/FetchXMLFile",
    "cap_public_website/FetchPolygonXMLFile",
)
_SACHET_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
    "Referer": "https://sachet.ndma.gov.in/cap_public_website/AlertView.html",
    "Origin": "https://sachet.ndma.gov.in",
}
_sachet_cache: dict[str, tuple[float, int, str, bytes]] = {}
_SACHET_TTL = 120.0


@app.get("/sachet/{path:path}")
def sachet_proxy(path: str, request: Request):
    if not any(path.startswith(p) for p in _SACHET_ALLOWED):
        raise HTTPException(status_code=403, detail="Forbidden SACHET path")

    target = f"{_SACHET_ORIGIN}/{path}"
    if request.url.query:
        target += f"?{request.url.query}"

    hit = _sachet_cache.get(target)
    if hit and time.time() - hit[0] < _SACHET_TTL:
        _, status, ctype, body = hit
        return Response(content=body, status_code=status, media_type=ctype,
                        headers={"X-Cache": "HIT"})

    try:
        upstream = requests.get(target, headers=_SACHET_HEADERS, timeout=30)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"SACHET upstream failed: {exc}")

    ctype = upstream.headers.get("content-type", "application/xml")
    if upstream.status_code == 200 and upstream.content:
        _sachet_cache[target] = (time.time(), 200, ctype, upstream.content)

    return Response(content=upstream.content, status_code=upstream.status_code,
                    media_type=ctype, headers={"X-Cache": "MISS"})


# ============================================================
# FIREBASE HOSTING INTEGRATION
# ------------------------------------------------------------
# The RESQNET dashboard + Kavach app are served from Firebase
# Hosting, which rewrites  /api/**  to the `api` Cloud Function
# (see SIH_HAZARD_MANAGEMENT/firebase.json). Firebase does NOT
# strip the "/api" prefix before forwarding, so the browser's
# request for  https://<project>.web.app/api/allocate  arrives
# here as  GET /api/allocate.
#
# To keep every route above written as "/allocate", "/incidents"
# etc. (and unchanged for anyone hitting the service directly
# under /api/...), the whole API is mounted under "/api" on a
# thin root app. The ASGI entrypoint stays `app.main:app` for
# the Cloud Functions shim / Procfile / Dockerfile / render.yaml.
#   deployed  :  https://<project>.web.app/api/...      (same origin, no CORS)
#   local dev :  http://127.0.0.1:8000/api/...          (uvicorn app.main:app)
# ============================================================
_api_app = app

app = FastAPI(
    title="SIH Citizen Intelligence API",
    description="AI-assisted disaster citizen message analysis",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root_health():
    # Cloud Run / render.yaml health check hits "/".
    return {
        "status": "online",
        "service": "SIH Citizen Intelligence API",
        "api_base": "/api",
    }


app.mount("/api", _api_app)