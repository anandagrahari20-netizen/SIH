from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from typing import Optional

from app.aggregation import cluster_incidents
from app.maps import get_distance_eta
from app.schemas import (
    AllocationDecision,
    AllocationResponse,
    ClusterAllocationSummary,
    ClusterRequirement,
    DemandCluster,
    Incident,
    Resource,
    ResourceAvailabilityChange,
)


# ============================================================
# URGENCY MODEL
#
# A linear scoring model over demand-cluster features:
#
#   people affected, injured, trapped, demand, time elapsed,
#   deterministic priority score
#
# There is no labeled allocation-outcome data yet, so the
# weights below are hand-tuned defaults (same philosophy as
# priority.py: deterministic and explainable). `fit()` lets the
# weights be retrained by gradient descent later, once real
# outcomes (e.g. "did this allocation resolve the incident in
# time") are available, without changing any calling code.
# ============================================================

# Raw cluster counts. Values at/above the cap are treated as
# maximum severity for that feature.
BASE_FEATURES = [
    "priority_score",
    "people_affected",
    "injured_count",
    "trapped_count",
    "demand_weight",
    "time_elapsed_hours",
]

FEATURE_CAPS = {
    "priority_score": 100.0,
    "people_affected": 20.0,
    "injured_count": 10.0,
    "trapped_count": 10.0,
    "demand_weight": 50.0,
    "time_elapsed_hours": 24.0,
}

# Doctrine-derived interaction features, already normalized to 0-1.
#
# A purely linear model over the raw counts above cannot express the
# things a triage officer actually reasons about: that entrapment
# matters as a PROPORTION of the group, that injury urgency compounds
# with elapsed time on a short (golden-hour) horizon while entrapment
# compounds on a longer search-and-rescue horizon, and that trapped
# AND injured together is categorically worse than either alone.
#
# Feeding those interactions in as explicit features lets the linear
# model approximate the non-linear expert ground truth far more
# closely (see scripts/train_urgency_model.py for the measured
# before/after error), while keeping the model itself fully
# transparent and auditable -- every term is still a named quantity
# times a learned weight.
DERIVED_FEATURES = [
    "trapped_ratio",
    "injured_ratio",
    "rescue_window",
    "golden_hour",
    "compounding",
    "mci_scale",
]

FEATURE_ORDER = BASE_FEATURES + DERIVED_FEATURES

# Search-and-rescue entrapment window and trauma golden hour, in
# hours -- the horizons the two time-pressure features saturate over.
RESCUE_WINDOW_HOURS = 36.0
GOLDEN_HOUR_HOURS = 4.0

# Headcount at which an incident is treated as a mass-casualty
# incident and gets a step increase in scale.
MCI_THRESHOLD = 10

DEFAULT_URGENCY_WEIGHTS = {
    "priority_score": 0.24,
    "people_affected": 0.08,
    "injured_count": 0.10,
    "trapped_count": 0.10,
    "demand_weight": 0.04,
    "time_elapsed_hours": 0.06,
    "trapped_ratio": 0.12,
    "injured_ratio": 0.08,
    "rescue_window": 0.08,
    "golden_hour": 0.05,
    "compounding": 0.03,
    "mci_scale": 0.02,
}


class LinearUrgencyModel:
    """
    Scores how urgently a demand cluster needs resources, on a
    0-100 scale, as a weighted combination of normalized
    features.
    """

    def __init__(self, weights: Optional[dict[str, float]] = None):
        self.weights = {
            key: (weights or DEFAULT_URGENCY_WEIGHTS).get(key, 0.0)
            for key in FEATURE_ORDER
        }

    def _normalized_features(
        self,
        cluster: DemandCluster,
    ) -> dict[str, float]:

        raw = {
            "priority_score": cluster.priority_score,
            "people_affected": cluster.people_affected,
            "injured_count": cluster.injured_count,
            "trapped_count": cluster.trapped_count,
            "demand_weight": cluster.demand_weight,
            "time_elapsed_hours": cluster.time_elapsed_hours,
        }

        features = {
            key: max(0.0, min(value / FEATURE_CAPS[key], 1.0))
            for key, value in raw.items()
        }

        # ---- doctrine-derived interaction features (already 0-1) ----
        people = max(1, cluster.people_affected)

        trapped_ratio = max(0.0, min(cluster.trapped_count / people, 1.0))
        injured_ratio = max(0.0, min(cluster.injured_count / people, 1.0))

        # Time pressure saturates on two different horizons.
        rescue_pressure = min(
            1.0, cluster.time_elapsed_hours / RESCUE_WINDOW_HOURS
        )
        golden_hour_pressure = min(
            1.0, cluster.time_elapsed_hours / GOLDEN_HOUR_HOURS
        )

        features["trapped_ratio"] = trapped_ratio
        features["injured_ratio"] = injured_ratio

        # Entrapment urgency grows across the SAR window; injury
        # urgency grows much faster, across the golden hour.
        features["rescue_window"] = trapped_ratio * rescue_pressure
        features["golden_hour"] = injured_ratio * golden_hour_pressure

        # Trapped AND injured is categorically worse than either alone.
        features["compounding"] = (
            1.0
            if (cluster.trapped_count > 0 and cluster.injured_count > 0)
            else 0.0
        )

        # Scale with diminishing marginal weight per person, plus a
        # step once the incident crosses the mass-casualty tier.
        mci = math.log1p(people) / math.log1p(FEATURE_CAPS["people_affected"])
        if people >= MCI_THRESHOLD:
            mci += 0.25
        features["mci_scale"] = max(0.0, min(mci, 1.0))

        return features

    def score(self, cluster: DemandCluster) -> float:

        features = self._normalized_features(cluster)
        total_weight = sum(self.weights.values()) or 1.0

        raw_score = sum(
            self.weights[key] * features[key]
            for key in FEATURE_ORDER
        )

        return round(100.0 * raw_score / total_weight, 2)

    def reasons(self, cluster: DemandCluster) -> list[str]:

        reasons = []

        if cluster.trapped_count > 0:
            reasons.append(
                f"{cluster.trapped_count} people reported trapped"
            )

        if cluster.injured_count > 0:
            reasons.append(
                f"{cluster.injured_count} people reported injured"
            )

        if cluster.people_affected > 5:
            reasons.append(
                f"{cluster.people_affected} people affected"
            )

        if cluster.time_elapsed_hours >= 2:
            reasons.append(
                f"{cluster.time_elapsed_hours:.1f}h elapsed since "
                "first report increases severity"
            )

        if cluster.demand_weight > 10:
            reasons.append("High aggregate demand for assistance")

        if not reasons:
            reasons.append(
                "Baseline severity from priority assessment"
            )

        return reasons

    def fit(
        self,
        examples: list[tuple[DemandCluster, float]],
        learning_rate: float = 0.05,
        epochs: int = 200,
    ) -> None:
        """
        Batch gradient descent over labeled (cluster, target_score)
        examples, target_score in [0, 100].

        Not called anywhere yet -- this is the hook for retraining
        once real allocation-outcome data has been collected.
        Weights are clipped to stay non-negative so a feature can
        never reduce urgency.
        """

        if not examples:
            return

        weights = dict(self.weights)

        # Features never change between epochs -- compute once.
        cache = [
            (self._normalized_features(cluster), target)
            for cluster, target in examples
        ]

        def train_loss(candidate: dict[str, float]) -> float:
            total = sum(candidate.values()) or 1.0
            return sum(
                (
                    100.0
                    * sum(candidate[k] * f[k] for k in FEATURE_ORDER)
                    / total
                    - target
                )
                ** 2
                for f, target in cache
            ) / len(cache)

        # Never ship weights worse than the ones we started from: a
        # learning rate that is too large for this dataset would
        # otherwise silently save a diverged model.
        best_weights = dict(weights)
        best_loss = train_loss(weights)

        for _ in range(epochs):

            gradients = {key: 0.0 for key in FEATURE_ORDER}
            total_weight = sum(weights.values()) or 1.0

            for features, target in cache:

                prediction = 100.0 * sum(
                    weights[key] * features[key]
                    for key in FEATURE_ORDER
                ) / total_weight

                error = prediction - target

                # score() is a weighted MEAN (it divides by the sum of
                # the weights), so raising one weight also raises the
                # denominator. The exact derivative of
                #     p = 100 * (w . f) / S,   S = sum(w)
                # is
                #     dp/dw_k = (100 * f_k - p) / S
                # Using plain `error * f_k` here (ignoring the
                # denominator) is what made training with more
                # features converge worse than the hand-tuned start.
                for key in FEATURE_ORDER:
                    gradients[key] += (
                        error * (100.0 * features[key] - prediction)
                        / total_weight
                    )

            for key in FEATURE_ORDER:
                weights[key] -= (
                    learning_rate * gradients[key] / len(cache)
                )
                weights[key] = max(0.0, weights[key])

            # Renormalize each epoch so the learning rate stays
            # meaningful as the weights drift in magnitude.
            scale = sum(weights.values())
            if scale > 0:
                weights = {k: v / scale for k, v in weights.items()}

            loss = train_loss(weights)
            if loss < best_loss:
                best_loss = loss
                best_weights = dict(weights)

        # score() is invariant to uniform rescaling of the weights
        # (it divides by their sum), so this rescale doesn't change
        # any prediction -- it just keeps the saved/printed weights
        # on the same 0-1, sum-to-one scale as the hand-tuned
        # defaults, instead of drifting to an arbitrary magnitude.
        total = sum(best_weights.values()) or 1.0
        self.weights = {
            key: round(value / total, 4)
            for key, value in best_weights.items()
        }


# ============================================================
# TRAINED WEIGHTS
#
# If app/urgency_weights.json exists (produced by
# scripts/train_urgency_model.py), it overrides the hand-tuned
# DEFAULT_URGENCY_WEIGHTS above. Missing keys fall back to the
# defaults, so a partial/corrupt file can't crash startup.
# ============================================================

WEIGHTS_PATH = os.path.join(os.path.dirname(__file__), "urgency_weights.json")


def _load_trained_weights() -> dict[str, float]:

    weights = dict(DEFAULT_URGENCY_WEIGHTS)

    if os.path.exists(WEIGHTS_PATH):
        try:
            with open(WEIGHTS_PATH, "r", encoding="utf-8") as handle:
                trained = json.load(handle)

            for key in FEATURE_ORDER:
                if key in trained:
                    weights[key] = float(trained[key])

        except (OSError, ValueError, TypeError, KeyError):
            # Never let a bad weights file take down the API --
            # fall back to the hand-tuned defaults.
            pass

    return weights


urgency_model = LinearUrgencyModel(_load_trained_weights())


# ============================================================
# DISPATCH ORDER
#
# Severity is a HARD ordering, not a soft score: every CRITICAL
# cluster is served before any HIGH cluster, every HIGH before any
# MEDIUM, and so on. The learned urgency score only breaks ties
# *within* one severity tier (which of two CRITICAL clusters goes
# first). This matches how a real control room triages -- an
# operator never lets a large MEDIUM incident outrank a CRITICAL
# one just because more people are involved.
# ============================================================

SEVERITY_RANK = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


# ============================================================
# SUITABILITY / RESERVATION / SPREAD
# ============================================================

DISTANCE_REFERENCE_KM = 5.0
ETA_REFERENCE_MINUTES = 15.0

# ------------------------------------------------------------
# GEOGRAPHIC CONTAINMENT
#
# Two independent guards stop a unit from one city being sent to an
# incident in another (the "Kanpur ambulance dispatched 600 km to
# Bhubaneswar" class of bug):
#
#   1. DISTRICT PARTITION - when both the cluster and the resource
#      carry a district, they must match. This is exact and cheap.
#   2. HARD DISTANCE CAP  - an absolute ceiling that applies even
#      when district metadata is missing on one side (older records,
#      incidents filed before the field existed, manual entries).
#
# The cap is generous enough for a large rural district but far below
# any inter-city distance.
# ------------------------------------------------------------
MAX_DISPATCH_KM = 120.0

# If a district genuinely has nothing within MAX_DISPATCH_KM the
# cluster is reported unserved rather than served from another city --
# an honest "no capacity" is operationally better than a dispatch that
# can never arrive in time.


def _norm_admin(value: Optional[str]) -> str:
    """
    Normalise a district/state name for comparison: case-insensitive
    and tolerant of the common Indian suffixes ("Kanpur" vs "Kanpur
    Nagar", "Pune District" vs "Pune").
    """

    if not value:
        return ""

    text = str(value).strip().lower()

    for suffix in (" nagar", " district", " dist.", " dist", " rural", " urban"):
        if text.endswith(suffix):
            text = text[: -len(suffix)].strip()

    return text


def _same_district(
    cluster_district: Optional[str],
    resource_district: Optional[str],
) -> bool:
    """
    True when the two may be served together. Missing metadata on
    either side is NOT treated as a match on its own -- the distance
    cap is what protects those cases -- but it is not treated as a
    mismatch either, so legacy records still get help.
    """

    left = _norm_admin(cluster_district)
    right = _norm_admin(resource_district)

    if not left or not right:
        return True

    return left == right or left in right or right in left

# How hard to push allocations away from a resource that has already
# been dispatched earlier in the same run. Without this the single
# closest depot wins every cluster and the whole district's response
# collapses onto one facility.
SPREAD_PENALTY = 0.45

# A single resource can never cover more than this many units of one
# requirement, so coverage is spread across several facilities.
MAX_UNITS_PER_RESOURCE_PER_REQUIREMENT = 2


def _suitability_score(
    distance_km: float,
    eta_minutes: float,
) -> float:
    """
    0-1 score. Closer and faster resources score higher.
    """

    distance_component = 1.0 / (1.0 + distance_km / DISTANCE_REFERENCE_KM)
    eta_component = 1.0 / (1.0 + eta_minutes / ETA_REFERENCE_MINUTES)

    return round(0.5 * distance_component + 0.5 * eta_component, 4)


# Target time-on-scene. Beyond this the score decays super-linearly, so
# the allocator strongly prefers a unit that can actually get there in
# the response window over a marginally better-suited but slower one.
RESPONSE_TARGET_MINUTES = 20.0


def _response_time_factor(eta_minutes: float) -> float:
    """
    1.0 inside the target response window, then a sharp (super-linear)
    decay. This is what makes "everyone served as fast as possible" an
    explicit objective rather than a side effect of the distance term.
    """

    if eta_minutes <= RESPONSE_TARGET_MINUTES:
        return 1.0

    overrun = (eta_minutes - RESPONSE_TARGET_MINUTES) / RESPONSE_TARGET_MINUTES

    return round(1.0 / (1.0 + overrun ** 1.5), 4)


def _availability_ratio(resource: Resource) -> float:

    if resource.total_units <= 0:
        return 0.0

    return resource.available_units / resource.total_units


def _reservation_factor(
    availability_ratio: float,
    urgency_score: float,
) -> float:
    """
    The scarcer a resource is, the more strongly it is reserved
    for high-urgency clusters: a resource with availability_ratio
    close to 0 is usable mainly when urgency_score is also high.
    A resource with availability_ratio close to 1 is usable
    anywhere regardless of urgency.
    """

    urgency_fraction = urgency_score / 100.0

    return availability_ratio + (1.0 - availability_ratio) * urgency_fraction


def _spread_factor(units_already_dispatched: int) -> float:
    """
    Decays a resource's score each time it is used in this run, so
    the allocator keeps reaching for fresh units instead of sending
    every cluster to the same nearest facility.
    """

    return 1.0 / (1.0 + SPREAD_PENALTY * max(0, units_already_dispatched))


# ============================================================
# NEED <-> RESOURCE TYPE COMPATIBILITY
#
# Each need family is served by its OWN unit. A cluster that needs
# both `medical` and `rescue` gets an ambulance *and* a rescue unit,
# rather than two of whichever happens to be closest.
# ============================================================

NEED_RESOURCE_COMPATIBILITY = {
    "rescue": {"ndrf_team", "fire_brigade", "boat", "police"},
    "medical": {"ambulance", "medical_team"},
    "food": {"food_supply"},
    "water": {"water_tanker", "food_supply"},
    "shelter": {"shelter_unit"},
    "evacuation": {"ndrf_team", "boat", "fire_brigade", "police"},
}

# Order in which a single cluster's needs are satisfied: life-safety
# first, then relief.
NEED_DISPATCH_ORDER = [
    "rescue",
    "medical",
    "evacuation",
    "water",
    "food",
    "shelter",
]


def _compatible_resource_types(
    needs: list[str],
) -> Optional[set[str]]:
    """
    None means "no restriction" (e.g. no explicit needs were
    extracted for this cluster yet). "generic" resources are
    always eligible.
    """

    if not needs:
        return None

    compatible: set[str] = {"generic"}

    for need in needs:
        compatible.update(NEED_RESOURCE_COMPATIBILITY.get(need, set()))

    return compatible


def _types_for_need(need: str) -> Optional[set[str]]:
    """
    Resource types that can serve one specific need family.
    "general" (no stated need) accepts anything.
    """

    if need == "general":
        return None

    return {"generic"} | NEED_RESOURCE_COMPATIBILITY.get(need, set())


# ============================================================
# REQUIREMENT MODEL
#
# How many PEOPLE each need family of a cluster has to cover. This
# is derived from what citizens actually reported -- injured people
# drive medical demand, trapped people drive rescue demand, the
# whole affected headcount drives relief demand -- instead of
# treating every cluster as a flat headcount to be divided by
# capacity.
# ============================================================

def _requirements_for(cluster: DemandCluster) -> list[tuple[str, int]]:
    """
    Returns [(need, people_to_cover), ...] in dispatch order.
    """

    people = max(1, cluster.people_affected)

    needs = set(cluster.needs or [])

    # Facts imply needs even when the citizen never named them.
    if cluster.injured_count > 0:
        needs.add("medical")
    if cluster.trapped_count > 0:
        needs.add("rescue")

    if not needs:
        return [("general", people)]

    requirements: list[tuple[str, int]] = []

    for need in NEED_DISPATCH_ORDER:
        if need not in needs:
            continue

        if need == "medical":
            heads = max(1, min(cluster.injured_count or 1, people))
        elif need == "rescue":
            heads = max(1, min(cluster.trapped_count or 1, people))
        else:
            heads = people

        requirements.append((need, heads))

    return requirements


# ============================================================
# DEMAND CLUSTER CONSTRUCTION
# ============================================================

def _parse_timestamp(value: Optional[str]) -> Optional[datetime]:

    if not value:
        return None

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _people_in_incident(incident: Incident) -> int:
    return incident.facts.people_count or 1


def _injured_in_incident(incident: Incident) -> int:

    if incident.facts.injury_count is not None:
        return incident.facts.injury_count

    if incident.facts.injured is True:
        return 1

    return 0


def _trapped_in_incident(incident: Incident) -> int:

    if incident.facts.trapped is True:
        return _people_in_incident(incident)

    return 0


def _demand_weight_of_incident(incident: Incident) -> int:
    return len(incident.facts.needs) * _people_in_incident(incident)


def _centroid(
    cluster: list[Incident],
) -> tuple[Optional[float], Optional[float]]:

    coords = [
        (incident.latitude, incident.longitude)
        for incident in cluster
        if incident.latitude is not None
        and incident.longitude is not None
    ]

    if not coords:
        return None, None

    latitude = sum(lat for lat, _ in coords) / len(coords)
    longitude = sum(lon for _, lon in coords) / len(coords)

    return latitude, longitude


def _time_elapsed_hours(cluster: list[Incident]) -> float:

    timestamps = [
        value
        for value in (
            _parse_timestamp(incident.created_at)
            for incident in cluster
        )
        if value is not None
    ]

    if not timestamps:
        return 0.0

    earliest = min(timestamps)

    if earliest.tzinfo is None:
        earliest = earliest.replace(tzinfo=timezone.utc)

    now = datetime.now(timezone.utc)
    hours = (now - earliest).total_seconds() / 3600.0

    return round(max(0.0, hours), 2)


_PRIORITY_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


def incident_to_cluster(
    cluster: list[Incident],
    cluster_id: str,
) -> DemandCluster:
    """
    Convert a group of incidents (already established to be
    related, e.g. by cluster_incidents(), or a single synthetic
    incident during training) into the DemandCluster feature
    vector the urgency model scores on.
    """

    latitude, longitude = _centroid(cluster)

    priority_level = max(
        (incident.priority.level for incident in cluster),
        key=lambda level: _PRIORITY_ORDER.get(level, 0),
        default="LOW",
    )

    priority_score = max(
        (incident.priority.score for incident in cluster),
        default=0,
    )

    needs = sorted(
        {
            need
            for incident in cluster
            for need in incident.facts.needs
        }
    )

    # The cluster inherits the administrative scope of its members.
    # cluster_incidents() only ever groups reports within 2 km, so a
    # cluster cannot straddle two districts in practice; take the first
    # non-empty value.
    district = next(
        (i.district for i in cluster if i.district),
        None,
    )
    state = next(
        (i.state for i in cluster if i.state),
        None,
    )

    return DemandCluster(
        cluster_id=cluster_id,
        incident_ids=[incident.incident_id for incident in cluster],
        latitude=latitude,
        longitude=longitude,
        state=state,
        district=district,
        report_count=len(cluster),
        people_affected=sum(_people_in_incident(i) for i in cluster),
        injured_count=sum(_injured_in_incident(i) for i in cluster),
        trapped_count=sum(_trapped_in_incident(i) for i in cluster),
        demand_weight=sum(
            _demand_weight_of_incident(i) for i in cluster
        ),
        time_elapsed_hours=_time_elapsed_hours(cluster),
        priority_score=priority_score,
        priority_level=priority_level,
        needs=needs,
    )


def build_demand_clusters(
    incidents: list[Incident],
) -> list[DemandCluster]:
    """
    Group unresolved incidents into geographic/temporal demand
    clusters and compute the features the urgency model scores on.
    """

    open_incidents = [
        incident
        for incident in incidents
        if incident.status != "RESOLVED"
    ]

    raw_clusters = cluster_incidents(open_incidents)

    return [
        incident_to_cluster(cluster, f"DC-{index + 1:03d}")
        for index, cluster in enumerate(raw_clusters)
    ]


# ============================================================
# ALLOCATION
# ============================================================

def _cluster_description(cluster: DemandCluster) -> str:
    """
    One line describing the COMPLAINT a unit is being sent to, so the
    dashboard can show "why" beside every move instead of a cluster id.
    e.g. "3 reports · 12 people, 12 trapped, 5 injured · rescue, medical"
    """

    parts: list[str] = []

    if cluster.report_count > 1:
        parts.append(f"{cluster.report_count} reports")
    else:
        parts.append("1 report")

    people_bits = [f"{cluster.people_affected} people"]
    if cluster.trapped_count:
        people_bits.append(f"{cluster.trapped_count} trapped")
    if cluster.injured_count:
        people_bits.append(f"{cluster.injured_count} injured")
    parts.append(", ".join(people_bits))

    if cluster.needs:
        parts.append(", ".join(cluster.needs))

    if cluster.time_elapsed_hours >= 1:
        parts.append(f"waiting {cluster.time_elapsed_hours:.1f}h")

    return " · ".join(parts)


def run_allocation(
    incidents: list[Incident],
    resources: list[Resource],
    model: LinearUrgencyModel = urgency_model,
    district: Optional[str] = None,
) -> AllocationResponse:
    """
    Recommend how available resources should be relocated to
    unresolved incident clusters.

    This is advisory: it does not mutate incidents or resources.
    The caller decides whether to apply the recommendation (e.g.
    via PATCH /incidents/{id} and PATCH /resources/{id}).

    Algorithm:
      1. Cluster unresolved incidents and score each cluster's
         urgency (people affected, injured, trapped, demand,
         time elapsed, priority).
      2. Order the queue by SEVERITY TIER first -- every CRITICAL
         cluster is served before any HIGH, HIGH before MEDIUM,
         MEDIUM before LOW. The learned urgency score only breaks
         ties inside a tier.
      3. Break each cluster into per-need requirements (rescue,
         medical, evacuation, water, food, shelter) sized by what
         was actually reported: injured people drive medical
         demand, trapped people drive rescue demand, the affected
         headcount drives relief demand.
      4. Serve each requirement from resources of a COMPATIBLE
         type, ranked by suitability (distance + ETA), a
         reservation factor that keeps scarce resources for
         high-urgency clusters, and a spread factor that pushes
         allocations away from resources already used in this run
         so the whole district is not dispatched to one facility.
      5. Deduct every allocated unit from the running availability
         pool, so later (lower-severity) clusters only ever see
         what is genuinely still free.
    """

    # Scope both sides to one district before anything else. Even
    # though _build_candidates re-checks per resource, filtering here
    # keeps clusters from other cities out of the queue entirely, so
    # they can never consume this district's capacity.
    if district:
        incidents = [
            incident
            for incident in incidents
            if _same_district(district, incident.district)
        ]
        resources = [
            resource
            for resource in resources
            if _same_district(district, resource.district)
        ]

    demand_clusters = build_demand_clusters(incidents)

    if district:
        for cluster in demand_clusters:
            if not cluster.district:
                cluster.district = district

    scored_clusters = [
        (cluster, model.score(cluster))
        for cluster in demand_clusters
    ]

    # Severity is a hard tier; urgency_score only orders within it.
    scored_clusters.sort(
        key=lambda item: (
            SEVERITY_RANK.get(item[0].priority_level, 0),
            item[1],
            item[0].trapped_count,
            item[0].injured_count,
            item[0].time_elapsed_hours,
            item[0].people_affected,
        ),
        reverse=True,
    )

    active_resources = {
        resource.resource_id: resource
        for resource in resources
        if resource.status == "ACTIVE"
    }

    starting_units = {
        resource_id: resource.available_units
        for resource_id, resource in active_resources.items()
    }

    remaining_units = dict(starting_units)

    # Units already committed to earlier clusters in THIS run, used
    # by _spread_factor to fan the response out across facilities.
    dispatched_load: dict[str, int] = {
        resource_id: 0 for resource_id in active_resources
    }

    summaries: list[ClusterAllocationSummary] = []
    unserved: list[str] = []

    for dispatch_order, (cluster, urgency_score) in enumerate(
        scored_clusters, start=1
    ):

        severity_rank = SEVERITY_RANK.get(cluster.priority_level, 0)

        if cluster.latitude is None or cluster.longitude is None:
            summaries.append(
                ClusterAllocationSummary(
                    cluster_id=cluster.cluster_id,
                    people_affected=cluster.people_affected,
                    urgency_score=urgency_score,
                    priority=cluster.priority_level,
                    severity_rank=severity_rank,
                    dispatch_order=dispatch_order,
                    latitude=cluster.latitude,
                    longitude=cluster.longitude,
                    state=cluster.state,
                    district=cluster.district,
                    report_count=cluster.report_count,
                    needs=cluster.needs,
                    incident_ids=cluster.incident_ids,
                    requirements=[],
                    units_allocated=0,
                    coverage_ratio=0.0,
                    fully_served=False,
                    max_eta_minutes=0.0,
                    decisions=[],
                )
            )
            unserved.append(cluster.cluster_id)
            continue

        requirements = _requirements_for(cluster)
        cluster_description = _cluster_description(cluster)

        decisions: list[AllocationDecision] = []
        requirement_rows: list[ClusterRequirement] = []

        units_allocated_total = 0
        people_needed_total = 0
        people_covered_total = 0

        for need, heads_to_cover in requirements:

            allowed_types = _types_for_need(need)

            def _build_candidates(types: Optional[set[str]]) -> list:

                found = []

                for resource_id, resource in active_resources.items():

                    if remaining_units.get(resource_id, 0) <= 0:
                        continue

                    if types is not None and resource.type not in types:
                        continue

                    # GUARD 1 -- never cross a district boundary.
                    if not _same_district(cluster.district, resource.district):
                        continue

                    distance_info = get_distance_eta(
                        resource.latitude,
                        resource.longitude,
                        cluster.latitude,
                        cluster.longitude,
                    )

                    # GUARD 2 -- absolute distance ceiling, applies even
                    # when district metadata is missing on either side.
                    if distance_info.distance_km > MAX_DISPATCH_KM:
                        continue

                    suitability = _suitability_score(
                        distance_info.distance_km,
                        distance_info.eta_minutes,
                    )

                    reservation = _reservation_factor(
                        _availability_ratio(resource),
                        urgency_score,
                    )

                    spread = _spread_factor(
                        dispatched_load.get(resource_id, 0)
                    )

                    speed = _response_time_factor(distance_info.eta_minutes)

                    found.append(
                        (
                            round(
                                suitability * reservation * spread * speed, 4
                            ),
                            resource,
                            distance_info,
                            suitability,
                        )
                    )

                return found

            candidates = _build_candidates(allowed_types)

            # Districts rarely have a dedicated unit for every need --
            # most have hospitals, police and fire but no water tanker
            # or shelter unit at all. Leaving those citizens with
            # nothing is worse than sending the nearest available team,
            # so fall back to ANY free resource and say so in the
            # reasons. The operator can still override the assignment.
            substituted = False
            if not candidates and allowed_types is not None:
                candidates = _build_candidates(None)
                substituted = bool(candidates)

            candidates.sort(key=lambda item: item[0], reverse=True)

            # Nominal requirement, from the capacity of the units this
            # district actually has for the need (not a flat divisor).
            best_capacity = max(
                (max(1, item[1].capacity_per_unit) for item in candidates),
                default=1,
            )
            units_required = -(-heads_to_cover // best_capacity)  # ceil

            covered_for_need = 0
            units_for_need = 0

            for (
                allocation_score,
                resource,
                distance_info,
                suitability,
            ) in candidates:

                if covered_for_need >= heads_to_cover:
                    break

                resource_id = resource.resource_id
                available = remaining_units.get(resource_id, 0)

                if available <= 0:
                    continue

                per_unit_capacity = max(1, resource.capacity_per_unit)

                outstanding = max(0, heads_to_cover - covered_for_need)
                units_needed = -(-outstanding // per_unit_capacity)  # ceil

                units_to_take = min(
                    available,
                    max(1, units_needed),
                    MAX_UNITS_PER_RESOURCE_PER_REQUIREMENT,
                )

                if units_to_take <= 0:
                    continue

                available_before = available
                remaining_units[resource_id] = available_before - units_to_take
                dispatched_load[resource_id] = (
                    dispatched_load.get(resource_id, 0) + units_to_take
                )

                covered_for_need += units_to_take * per_unit_capacity
                units_for_need += units_to_take
                units_allocated_total += units_to_take

                reasons = [
                    f"Responding to: {cluster_description}",
                    f"{need.upper()} requirement — "
                    f"{distance_info.distance_km} km away, "
                    f"ETA {distance_info.eta_minutes} min "
                    f"({distance_info.source})",
                ]

                if substituted:
                    reasons.append(
                        f"No dedicated {need} unit in this district — "
                        f"nearest available {resource.type.replace('_', ' ')} "
                        "substituted"
                    )

                if _availability_ratio(resource) < 0.3:
                    reasons.append(
                        "Resource is scarce; reserved for high-urgency cases"
                    )

                if dispatched_load[resource_id] > units_to_take:
                    reasons.append(
                        "Already committed elsewhere this run — "
                        "load spread across nearby units"
                    )

                reasons.append(
                    f"Availability {available_before} -> "
                    f"{remaining_units[resource_id]} of "
                    f"{resource.total_units} unit(s)"
                )

                decisions.append(
                    AllocationDecision(
                        cluster_id=cluster.cluster_id,
                        resource_id=resource_id,
                        resource_name=resource.name,
                        resource_type=resource.type,
                        serving_summary=cluster_description,
                        serving_incident_ids=cluster.incident_ids,
                        serving_report_count=cluster.report_count,
                        units_allocated=units_to_take,
                        distance_km=distance_info.distance_km,
                        eta_minutes=distance_info.eta_minutes,
                        urgency_score=urgency_score,
                        suitability_score=suitability,
                        allocation_score=allocation_score,
                        need_covered=need,
                        available_before=available_before,
                        available_after=remaining_units[resource_id],
                        reasons=reasons,
                    )
                )

            people_needed_total += heads_to_cover
            people_covered_total += min(covered_for_need, heads_to_cover)

            requirement_rows.append(
                ClusterRequirement(
                    need=need,
                    people_required=heads_to_cover,
                    units_required=max(1, units_required),
                    units_allocated=units_for_need,
                    people_covered=min(covered_for_need, heads_to_cover),
                    satisfied=covered_for_need >= heads_to_cover,
                )
            )

        fully_served = bool(requirement_rows) and all(
            row.satisfied for row in requirement_rows
        )

        if not fully_served:
            unserved.append(cluster.cluster_id)

        coverage_ratio = (
            round(min(1.0, people_covered_total / people_needed_total), 2)
            if people_needed_total
            else 0.0
        )

        # Time-to-coverage for this cluster: the slowest unit sent to
        # it. Reported so the operator can see (and the allocator can
        # be judged on) how fast the whole cluster is actually covered.
        max_eta = max((d.eta_minutes for d in decisions), default=0.0)

        summaries.append(
            ClusterAllocationSummary(
                cluster_id=cluster.cluster_id,
                people_affected=cluster.people_affected,
                urgency_score=urgency_score,
                priority=cluster.priority_level,
                severity_rank=severity_rank,
                dispatch_order=dispatch_order,
                latitude=cluster.latitude,
                longitude=cluster.longitude,
                state=cluster.state,
                district=cluster.district,
                report_count=cluster.report_count,
                needs=cluster.needs,
                incident_ids=cluster.incident_ids,
                requirements=requirement_rows,
                units_allocated=units_allocated_total,
                coverage_ratio=coverage_ratio,
                fully_served=fully_served,
                max_eta_minutes=round(max_eta, 1),
                decisions=decisions,
            )
        )

    resource_changes = [
        ResourceAvailabilityChange(
            resource_id=resource_id,
            resource_name=active_resources[resource_id].name,
            resource_type=active_resources[resource_id].type,
            units_dispatched=starting_units[resource_id]
            - remaining_units[resource_id],
            available_before=starting_units[resource_id],
            available_after=remaining_units[resource_id],
            total_units=active_resources[resource_id].total_units,
        )
        for resource_id in active_resources
        if remaining_units[resource_id] != starting_units[resource_id]
    ]

    return AllocationResponse(
        generated_at=datetime.now(timezone.utc).isoformat(),
        clusters=summaries,
        unserved_clusters=unserved,
        committed=False,
        resource_changes=resource_changes,
    )
