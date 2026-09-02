from __future__ import annotations

from collections import Counter
from datetime import datetime
from math import atan2, cos, radians, sin, sqrt
from typing import Optional

from app.schemas import Incident


# ============================================================
# CONFIGURATION
# ============================================================

# Approximate geographic radius for considering reports related.
# This is intentionally conservative for the prototype.
CLUSTER_RADIUS_KM = 2.0

# Reports farther apart in time than this are not clustered.
CLUSTER_TIME_WINDOW_HOURS = 6.0


# ============================================================
# GEOGRAPHIC DISTANCE
# ============================================================

def _distance_km(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
) -> float:
    """
    Calculate approximate great-circle distance using the
    Haversine formula.
    """

    earth_radius_km = 6371.0

    lat1_rad = radians(lat1)
    lat2_rad = radians(lat2)

    delta_lat = radians(lat2 - lat1)
    delta_lon = radians(lon2 - lon1)

    a = (
        sin(delta_lat / 2) ** 2
        + cos(lat1_rad)
        * cos(lat2_rad)
        * sin(delta_lon / 2) ** 2
    )

    c = 2 * atan2(sqrt(a), sqrt(1 - a))

    return earth_radius_km * c


# ============================================================
# TIME
# ============================================================

def _parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None

    try:
        return datetime.fromisoformat(
            value.replace("Z", "+00:00")
        )
    except (ValueError, TypeError):
        return None


def _within_time_window(
    first: Incident,
    second: Incident,
) -> bool:

    first_time = _parse_timestamp(first.created_at)
    second_time = _parse_timestamp(second.created_at)

    # If timestamps are unavailable, don't reject the
    # reports solely because of missing time information.
    if first_time is None or second_time is None:
        return True

    difference_hours = abs(
        (first_time - second_time).total_seconds()
    ) / 3600.0

    return difference_hours <= CLUSTER_TIME_WINDOW_HOURS


# ============================================================
# SEMANTIC SIMILARITY
# ============================================================

def _shared_needs(
    first: Incident,
    second: Incident,
) -> set[str]:

    return (
        set(first.facts.needs)
        & set(second.facts.needs)
    )


def _shared_environment(
    first: Incident,
    second: Incident,
) -> set[str]:

    return (
        set(first.facts.environmental_conditions)
        & set(second.facts.environmental_conditions)
    )


def _issues_are_related(
    first: Incident,
    second: Incident,
) -> bool:

    shared_needs = _shared_needs(first, second)
    shared_environment = _shared_environment(first, second)

    # Same explicit need is strong evidence of a related incident.
    if shared_needs:
        return True

    # Same environmental condition can also indicate the same
    # local event, especially when reports are geographically close.
    if shared_environment:
        return True

    return False


# ============================================================
# CLUSTER COMPATIBILITY
# ============================================================

def _can_cluster(
    first: Incident,
    second: Incident,
) -> bool:

    # Coordinates are required for reliable geographic clustering.
    if (
        first.latitude is None
        or first.longitude is None
        or second.latitude is None
        or second.longitude is None
    ):
        return False

    distance = _distance_km(
        first.latitude,
        first.longitude,
        second.latitude,
        second.longitude,
    )

    if distance > CLUSTER_RADIUS_KM:
        return False

    if not _within_time_window(first, second):
        return False

    if not _issues_are_related(first, second):
        return False

    return True


# ============================================================
# UNION-FIND
# ============================================================

class _UnionFind:

    def __init__(self, size: int):
        self.parent = list(range(size))

    def find(self, value: int) -> int:

        while self.parent[value] != value:

            self.parent[value] = (
                self.parent[self.parent[value]]
            )

            value = self.parent[value]

        return value

    def union(
        self,
        first: int,
        second: int,
    ) -> None:

        root_first = self.find(first)
        root_second = self.find(second)

        if root_first != root_second:
            self.parent[root_second] = root_first


# ============================================================
# CLUSTER INCIDENTS
# ============================================================

def cluster_incidents(
    incidents: list[Incident],
) -> list[list[Incident]]:
    """
    Group incidents that are likely to describe the same
    local emergency.

    Clustering uses:

    - geographic proximity
    - time proximity
    - shared needs or environmental conditions

    Individual incidents are preserved.
    """

    if not incidents:
        return []

    union_find = _UnionFind(len(incidents))

    for i in range(len(incidents)):

        for j in range(i + 1, len(incidents)):

            if _can_cluster(
                incidents[i],
                incidents[j],
            ):
                union_find.union(i, j)

    groups: dict[int, list[Incident]] = {}

    for index, incident in enumerate(incidents):

        root = union_find.find(index)

        groups.setdefault(
            root,
            [],
        ).append(incident)

    return list(groups.values())


# ============================================================
# CLUSTER ID
# ============================================================

def _cluster_id(
    index: int,
) -> str:
    return f"CL-{index + 1:03d}"


# ============================================================
# AGGREGATION
# ============================================================

def aggregate_cluster(
    cluster: list[Incident],
    cluster_index: int,
) -> dict:

    people_affected = sum(
        incident.facts.people_count or 0
        for incident in cluster
    )

    need_counter: Counter[str] = Counter()

    for incident in cluster:

        for need in incident.facts.needs:
            need_counter[need] += (
                incident.facts.people_count
                or 1
            )

    priority_levels = [
        incident.priority.level
        for incident in cluster
    ]

    priority_order = {
        "LOW": 0,
        "MEDIUM": 1,
        "HIGH": 2,
        "CRITICAL": 3,
    }

    highest_priority = max(
        priority_levels,
        key=lambda level: priority_order.get(
            level,
            0,
        ),
        default="LOW",
    )

    priority_score = max(
        (
            incident.priority.score
            for incident in cluster
        ),
        default=0,
    )

    # Centroid of the reports in this cluster. The dashboard draws a
    # complaint-density dot here whose radius grows with report_count,
    # so several complaints from the same street show up as one bigger
    # dot instead of overlapping pins.
    coords = [
        (incident.latitude, incident.longitude)
        for incident in cluster
        if incident.latitude is not None
        and incident.longitude is not None
    ]

    latitude = (
        sum(lat for lat, _ in coords) / len(coords) if coords else None
    )
    longitude = (
        sum(lon for _, lon in coords) / len(coords) if coords else None
    )

    district = next(
        (i.district for i in cluster if getattr(i, "district", None)),
        None,
    )

    return {
        "cluster_id": _cluster_id(cluster_index),
        "report_count": len(cluster),
        "people_affected": people_affected,
        "latitude": latitude,
        "longitude": longitude,
        "district": district,
        "needs": dict(
            sorted(
                need_counter.items()
            )
        ),
        "priority": highest_priority,
        "priority_score": priority_score,
        "incident_ids": [
            incident.incident_id
            for incident in cluster
        ],
    }


# ============================================================
# FULL DEMAND AGGREGATION
# ============================================================

def aggregate_incidents(
    incidents: list[Incident],
) -> list[dict]:
    """
    Cluster incidents and convert each cluster into an
    area-level demand summary.
    """

    clusters = cluster_incidents(
        incidents
    )

    return [
        aggregate_cluster(
            cluster,
            index,
        )
        for index, cluster in enumerate(
            clusters
        )
    ]