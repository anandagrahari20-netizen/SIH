"""
End-to-end demo: a realistic set of citizen incidents + a limited
resource fleet, run through the trained urgency model and the
allocator, with the recommendation printed and saved to JSON.

Usage:
    python scripts/demo_allocation.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(
    0,
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
)

from app.priority import calculate_priority  # noqa: E402
from app.resource_allocator import run_allocation  # noqa: E402
from app.schemas import CitizenFacts, Confidence, Incident, Resource  # noqa: E402
from app.severity import calculate_severity_features  # noqa: E402


NOW = datetime.now(timezone.utc)


def _hours_ago(hours: float) -> str:
    return (NOW - timedelta(hours=hours)).isoformat()


def _incident(
    incident_id: str,
    lat: float,
    lon: float,
    hours_ago: float,
    needs,
    people_count,
    trapped=None,
    injured=None,
    injury_count=None,
    vulnerable_people=None,
    environmental_conditions=None,
) -> Incident:

    facts = CitizenFacts(
        needs=needs,
        people_count=people_count,
        trapped=trapped,
        injured=injured,
        injury_count=injury_count,
        vulnerable_people=vulnerable_people or [],
        environmental_conditions=environmental_conditions or [],
    )
    severity = calculate_severity_features(facts)
    priority = calculate_priority(facts, severity)

    return Incident(
        incident_id=incident_id,
        request_id=incident_id,
        created_at=_hours_ago(hours_ago),
        latitude=lat,
        longitude=lon,
        facts=facts,
        severity_features=severity,
        priority=priority,
        confidence=Confidence(),
    )


# ============================================================
# DATASET: Cuttack-Bhubaneswar-Puri-Berhampur flood scenario
# ============================================================

INCIDENTS = [
    _incident(
        "INC-001", 20.4625, 85.8828, hours_ago=2.0,
        needs=["rescue", "medical"], people_count=6,
        trapped=True, injured=True, injury_count=1,
        vulnerable_people=["elderly", "child"],
        environmental_conditions=["flooding", "water_entered_house"],
    ),  # family of 6 trapped on rooftop, Cuttack, water rising

    _incident(
        "INC-002", 20.4650, 85.8790, hours_ago=5.0,
        needs=["evacuation"], people_count=2,
        trapped=False, injured=False,
        vulnerable_people=["elderly", "mobility_impaired"],
        environmental_conditions=["flooding"],
    ),  # elderly couple unable to evacuate, Cuttack

    _incident(
        "INC-003", 19.8200, 85.8400, hours_ago=68.0,
        needs=["food", "water", "shelter"], people_count=40,
        trapped=False, injured=False,
        environmental_conditions=["flooding", "road_blocked"],
    ),  # village stranded ~3 days, Puri outskirts

    _incident(
        "INC-004", 20.2961, 85.8245, hours_ago=0.5,
        needs=["medical"], people_count=1,
        trapped=False, injured=True, injury_count=1,
    ),  # breathing difficulty, Bhubaneswar

    _incident(
        "INC-005", 20.2990, 85.8300, hours_ago=4.0,
        needs=["rescue", "evacuation"], people_count=15,
        trapped=True, injured=False,
        vulnerable_people=["child"],
        environmental_conditions=["flooding"],
    ),  # children stranded at school, Bhubaneswar

    _incident(
        "INC-006", 20.4600, 85.8850, hours_ago=1.0,
        needs=["medical", "evacuation"], people_count=1,
        trapped=False, injured=False,
        vulnerable_people=["pregnant"],
    ),  # pregnant woman needs evacuation, Cuttack

    _incident(
        "INC-007", 19.8100, 85.8350, hours_ago=6.0,
        needs=["food", "water"], people_count=3,
        trapped=False, injured=False,
    ),  # small family, routine food/water request, Puri

    _incident(
        "INC-008", 19.3149, 84.7941, hours_ago=0.33,
        needs=["rescue", "medical"], people_count=4,
        trapped=True, injured=True, injury_count=2,
        environmental_conditions=["fire"],
    ),  # fire outbreak, people trapped and injured, Berhampur
]

RESOURCES = [
    Resource(
        resource_id="RES-AMB-1", name="Ambulance Unit 1", type="ambulance",
        latitude=20.2980, longitude=85.8260,
        total_units=2, available_units=2, capacity_per_unit=4,
    ),
    Resource(
        resource_id="RES-NDRF-1", name="NDRF Team Cuttack", type="ndrf_team",
        latitude=20.4600, longitude=85.8800,
        total_units=2, available_units=2, capacity_per_unit=10,
    ),
    Resource(
        resource_id="RES-BOAT-1", name="Rescue Boats Cuttack", type="boat",
        latitude=20.4610, longitude=85.8810,
        total_units=3, available_units=3, capacity_per_unit=6,
    ),
    Resource(
        resource_id="RES-FIRE-1", name="Fire Brigade Berhampur", type="fire_brigade",
        latitude=19.3140, longitude=84.7900,
        total_units=1, available_units=1, capacity_per_unit=8,
    ),
    Resource(
        resource_id="RES-FOOD-1", name="Food Supply Truck", type="food_supply",
        latitude=20.2950, longitude=85.8200,
        total_units=2, available_units=2, capacity_per_unit=25,
    ),
    Resource(
        resource_id="RES-WATER-1", name="Water Tanker Puri", type="water_tanker",
        latitude=19.8150, longitude=85.8320,
        total_units=1, available_units=1, capacity_per_unit=30,
    ),
    Resource(
        resource_id="RES-SHELTER-1", name="Shelter Unit Puri", type="shelter_unit",
        latitude=19.8120, longitude=85.8280,
        total_units=1, available_units=1, capacity_per_unit=50,
    ),
]


def main() -> None:

    print("=" * 70)
    print("INCIDENTS")
    print("=" * 70)
    for incident in INCIDENTS:
        print(
            f"{incident.incident_id:10s} "
            f"people={incident.facts.people_count or 0:<4d} "
            f"trapped={str(incident.facts.trapped):<6s} "
            f"injured={str(incident.facts.injured):<6s} "
            f"needs={incident.facts.needs} "
            f"priority={incident.priority.level}({incident.priority.score})"
        )

    print("\n" + "=" * 70)
    print("RESOURCES (available/total)")
    print("=" * 70)
    for resource in RESOURCES:
        print(
            f"{resource.resource_id:14s} {resource.name:24s} "
            f"type={resource.type:14s} "
            f"units={resource.available_units}/{resource.total_units} "
            f"capacity_per_unit={resource.capacity_per_unit}"
        )

    dataset_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "scripts",
        "demo_dataset.json",
    )
    with open(dataset_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "incidents": [i.model_dump() for i in INCIDENTS],
                "resources": [r.model_dump() for r in RESOURCES],
            },
            handle,
            indent=2,
        )
    print(f"Saved input dataset to {dataset_path}\n")

    result = run_allocation(INCIDENTS, RESOURCES)

    print("\n" + "=" * 70)
    print("ALLOCATION RECOMMENDATION (highest urgency first)")
    print("=" * 70)

    ordered = sorted(
        result.clusters, key=lambda c: c.urgency_score, reverse=True
    )

    for cluster in ordered:
        served = "FULLY SERVED" if cluster.fully_served else "NOT FULLY SERVED"
        print(
            f"\n{cluster.cluster_id} | urgency={cluster.urgency_score:5.1f} "
            f"| priority={cluster.priority:8s} "
            f"| people={cluster.people_affected:<4d} "
            f"| coverage={cluster.coverage_ratio*100:5.1f}% [{served}]"
        )
        if not cluster.decisions:
            print("    -> no compatible/available resource found")
        for decision in cluster.decisions:
            print(
                f"    -> {decision.units_allocated}x {decision.resource_name} "
                f"({decision.resource_type}) | "
                f"{decision.distance_km} km, ETA {decision.eta_minutes} min | "
                f"score={decision.allocation_score}"
            )
            for reason in decision.reasons:
                print(f"       - {reason}")

    if result.unserved_clusters:
        print(f"\nUNSERVED CLUSTERS: {result.unserved_clusters}")

    output_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "scripts",
        "demo_allocation_result.json",
    )
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(result.model_dump(), handle, indent=2)

    print(f"\nSaved full result to {output_path}")


if __name__ == "__main__":
    main()
