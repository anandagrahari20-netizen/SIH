from typing import List, Optional, Literal
from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    request_id: str
    text: str
    language: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    timestamp: Optional[str] = None
    source: str

    # Administrative scope the report came from. Carried end-to-end so
    # allocation NEVER dispatches a resource across districts (a Kanpur
    # unit must not be sent to a Bhubaneswar incident 600 km away).
    state: Optional[str] = None
    district: Optional[str] = None


class SeverityFeatures(BaseModel):
    immediate_rescue: bool = False
    medical_attention: bool = False
    multiple_people: bool = False
    vulnerable_person: bool = False


class Confidence(BaseModel):
    needs: float = 0.0
    people_count: float = 0.0
    trapped: float = 0.0
    injured: float = 0.0


class CitizenFacts(BaseModel):
    """
    Facts extracted directly from a citizen's message.
    """

    needs: List[
        Literal[
            "rescue",
            "medical",
            "food",
            "water",
            "shelter",
            "evacuation"
        ]
    ] = Field(default_factory=list)

    people_count: Optional[int] = None

    trapped: Optional[bool] = None

    injured: Optional[bool] = None

    injury_count: Optional[int] = None

    medical_issue: Optional[str] = None

    vulnerable_people: List[
        Literal[
            "elderly",
            "child",
            "infant",
            "disabled",
            "mobility_impaired",
            "pregnant"
        ]
    ] = Field(default_factory=list)

    environmental_conditions: List[
        Literal[
            "flooding",
            "waterlogging",
            "water_entered_house",
            "road_blocked",
            "landslide",
            "cyclone",
            "fire",
            "earthquake"
        ]
    ] = Field(default_factory=list)

    location_mentioned: Optional[str] = None


class PriorityAssessment(BaseModel):
    score: int = 0

    level: Literal[
        "LOW",
        "MEDIUM",
        "HIGH",
        "CRITICAL"
    ] = "LOW"

    reasons: List[str] = Field(default_factory=list)


class Incident(BaseModel):
    incident_id: str
    request_id: str
    created_at: str

    latitude: Optional[float] = None
    longitude: Optional[float] = None

    # Administrative scope — allocation is hard-partitioned on this.
    state: Optional[str] = None
    district: Optional[str] = None

    # What the citizen actually said / the generated summary. Without
    # this the dashboard's dispatch board shows an empty description
    # ("—") for every backend-created incident.
    text: str = ""
    source: Optional[str] = None

    # Full helpline transcript + caller identity, when the incident
    # came from an AI call rather than a form.
    transcript: Optional[str] = None
    caller_name: Optional[str] = None
    caller_mobile: Optional[str] = None

    facts: CitizenFacts
    severity_features: SeverityFeatures
    priority: PriorityAssessment
    confidence: Confidence

    status: Literal[
        "UNASSIGNED",
        "ASSIGNED",
        "IN_PROGRESS",
        "RESOLVED"
    ] = "UNASSIGNED"

    assigned_team: Optional[str] = None
    assigned_resource: Optional[str] = None

    # Human-readable dispatch info the citizen's app shows them:
    # "Ambulance from LLR Hospital — ETA 6 min".
    assigned_resource_type: Optional[str] = None
    assigned_eta_minutes: Optional[float] = None
    assigned_distance_km: Optional[float] = None
    assigned_at: Optional[str] = None


class IncidentUpdate(BaseModel):
    status: Optional[
        Literal[
            "UNASSIGNED",
            "ASSIGNED",
            "IN_PROGRESS",
            "RESOLVED"
        ]
    ] = None

    assigned_team: Optional[str] = None
    assigned_resource: Optional[str] = None



class AnalyzeResponse(BaseModel):
    request_id: str
    language: Optional[str] = None

    facts: CitizenFacts

    severity_features: SeverityFeatures

    priority: PriorityAssessment

    confidence: Confidence


# ============================================================
# AI HELPLINE (conversational voice triage)
# ============================================================

class HelplineMessage(BaseModel):
    role: Literal["user", "assistant"]
    text: str


class HelplineTurnRequest(BaseModel):
    session_id: Optional[str] = None
    language: str = "english"        # english | hindi | hinglish
    history: List[HelplineMessage] = Field(default_factory=list)
    user_text: str = ""

    # Live caller context. When present, a finished call is filed as a
    # fully geo-tagged incident by the backend itself (no second call
    # from the client), with everything the AI extracted attached.
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    state: Optional[str] = None
    district: Optional[str] = None
    caller_name: Optional[str] = None
    caller_mobile: Optional[str] = None

    # Set false to get the analysis without filing an incident.
    file_incident: bool = True


class HelplineTurnResponse(BaseModel):
    reply: str
    provider: str                   # ollama | groq | gemini | scripted
    transcript: str                 # everything the caller has said so far
    facts: CitizenFacts
    severity_features: SeverityFeatures
    priority: PriorityAssessment
    done: bool

    # Populated on the turn where `done` first becomes true and the
    # backend files the geo-tagged emergency report.
    incident_id: Optional[str] = None
    incident_filed: bool = False


# ============================================================
# RESOURCE ALLOCATION
# ============================================================

ResourceTypeLiteral = Literal[
    "ambulance",
    "medical_team",
    "fire_brigade",
    "ndrf_team",
    "boat",
    "food_supply",
    "water_tanker",
    "shelter_unit",
    "police",
    "generic",
]


class ResourceCreate(BaseModel):
    name: str
    type: ResourceTypeLiteral
    latitude: float
    longitude: float

    # Total deployable units of this resource (e.g. 5 ambulances).
    total_units: int = Field(gt=0)

    # Defaults to total_units when not supplied.
    available_units: Optional[int] = None

    # How many affected people a single unit can serve/carry.
    capacity_per_unit: int = Field(default=10, gt=0)

    # Administrative scope this resource was discovered/registered
    # for (e.g. from a district-level resource discovery import).
    # Optional -- resources registered directly via POST /resources
    # don't need to set these.
    state: Optional[str] = None
    district: Optional[str] = None


class Resource(ResourceCreate):
    resource_id: str
    available_units: int
    status: Literal["ACTIVE", "INACTIVE"] = "ACTIVE"


class ResourceBulkRequest(BaseModel):
    """
    Bulk-register resources for a district (e.g. hospitals, police
    stations, fire stations discovered via OpenStreetMap for the
    district a citizen-facing dashboard is currently scoped to).

    This is an UPSERT keyed on (district, type, rounded location), so
    re-running discovery for the same district neither duplicates
    facilities nor resets the availability of units that have already
    been dispatched. Set `replace` to also drop district resources that
    are absent from this payload -- off by default, because a thin
    discovery sweep (a flaky Overpass mirror) would otherwise wipe a
    complete resource set.
    """

    state: Optional[str] = None
    district: Optional[str] = None
    replace: bool = False
    resources: List[ResourceCreate]


class ResourceBulkResponse(BaseModel):
    state: Optional[str] = None
    district: Optional[str] = None
    removed_count: int
    created: List[Resource]


class ResourceUpdate(BaseModel):
    available_units: Optional[int] = Field(default=None, ge=0)
    status: Optional[Literal["ACTIVE", "INACTIVE"]] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class DistanceInfo(BaseModel):
    distance_km: float
    eta_minutes: float
    source: Literal["google_maps", "haversine_estimate"]


class DemandCluster(BaseModel):
    """
    A geographic/temporal grouping of unresolved incidents,
    with the features the urgency model scores on.
    """

    cluster_id: str
    incident_ids: List[str]

    latitude: Optional[float] = None
    longitude: Optional[float] = None

    # Inherited from the incidents in the cluster; a cluster may only
    # ever be served by resources from the same district.
    state: Optional[str] = None
    district: Optional[str] = None

    # How many distinct citizen reports formed this cluster — drives
    # the dot size on the dashboard's complaint-density layer.
    report_count: int = 1

    people_affected: int = 0
    injured_count: int = 0
    trapped_count: int = 0
    demand_weight: int = 0
    time_elapsed_hours: float = 0.0

    priority_score: int = 0
    priority_level: Literal[
        "LOW", "MEDIUM", "HIGH", "CRITICAL"
    ] = "LOW"

    needs: List[str] = Field(default_factory=list)


class AllocationDecision(BaseModel):
    cluster_id: str
    resource_id: str
    resource_name: str
    resource_type: str

    units_allocated: int

    distance_km: float
    eta_minutes: float

    urgency_score: float
    suitability_score: float
    allocation_score: float

    # Which requirement this unit was sent to satisfy (medical /
    # rescue / evacuation / food / water / shelter / general). One
    # cluster with several needs gets one decision per need family,
    # so a medical + rescue cluster receives an ambulance AND a
    # rescue unit instead of two ambulances.
    need_covered: str = "general"

    # Plain-language description of the COMPLAINT this unit is being
    # sent to, so the dashboard shows "why" next to every move rather
    # than an opaque cluster id.
    serving_summary: str = ""
    serving_incident_ids: List[str] = Field(default_factory=list)
    serving_report_count: int = 1

    # Availability of this resource before and after this decision.
    # The dashboard subtracts these live so the operator can see the
    # district's remaining capacity shrink as units are committed.
    available_before: int = 0
    available_after: int = 0

    reasons: List[str] = Field(default_factory=list)


class ClusterRequirement(BaseModel):
    """
    How many units each need family of a cluster actually requires,
    derived from what the citizens reported (injured -> medical,
    trapped -> rescue, people -> relief), not from a flat headcount.
    """

    need: str

    # People this need family has to cover for the cluster.
    people_required: int = 0

    # Nominal units needed, from people_required and the capacity of
    # the compatible units actually available in the district.
    units_required: int = 0

    units_allocated: int = 0
    people_covered: int = 0
    satisfied: bool = False


class ClusterAllocationSummary(BaseModel):
    cluster_id: str
    people_affected: int
    urgency_score: float
    priority: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]

    # Strict severity tier used to order dispatch: CRITICAL(3) is
    # always served before HIGH(2), HIGH before MEDIUM(1), and so on.
    # urgency_score only breaks ties *within* a tier.
    severity_rank: int = 0

    # 1-based position in the dispatch queue after severity ordering.
    dispatch_order: int = 0

    # Centroid of the cluster's incidents. Exposed so the dashboard
    # relocation-simulation map can draw resource -> cluster routes.
    latitude: Optional[float] = None
    longitude: Optional[float] = None

    # Administrative scope + how many citizen reports merged into this
    # cluster (drives the complaint-density dot size on the dashboard).
    state: Optional[str] = None
    district: Optional[str] = None
    report_count: int = 1

    needs: List[str] = Field(default_factory=list)
    incident_ids: List[str] = Field(default_factory=list)
    requirements: List[ClusterRequirement] = Field(default_factory=list)

    units_allocated: int
    coverage_ratio: float
    fully_served: bool

    # Slowest ETA among this cluster's decisions — the time until the
    # cluster is actually covered. The allocator minimises this.
    max_eta_minutes: float = 0.0

    decisions: List[AllocationDecision] = Field(default_factory=list)


class ResourceAvailabilityChange(BaseModel):
    resource_id: str
    resource_name: str
    resource_type: str
    units_dispatched: int
    available_before: int
    available_after: int
    total_units: int


class AllocationResponse(BaseModel):
    generated_at: str
    clusters: List[ClusterAllocationSummary]
    unserved_clusters: List[str] = Field(default_factory=list)

    # True when the plan was applied (available_units actually
    # decremented and persisted). A plain GET /allocate is advisory
    # and leaves this false.
    committed: bool = False

    # Per-resource availability delta for this run.
    resource_changes: List[ResourceAvailabilityChange] = Field(
        default_factory=list
    )


