from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from app.schemas import CitizenFacts, Confidence, Incident
from app.severity import calculate_severity_features
from app.priority import calculate_priority


# ============================================================
# SYNTHETIC TRAINING DATA -- WHAT THIS IS AND ISN'T
#
# There is no logged history of past incidents matched to
# dispatched resources and outcomes for this project yet, so
# there is no real historical dataset to train on.
#
# What this module generates instead is a set of REALISTIC
# SCENARIO ARCHETYPES for flood/cyclone disaster response
# (matching this project's Odisha coastal-districts domain --
# Bhubaneswar, Cuttack, Puri, Berhampur, the same locations
# analyzer.py already recognizes), each expanded into many
# randomized variations. Facts are run through the SAME
# production severity.py / priority.py pipeline the live API
# uses, so priority_score/priority_level are not invented -- they
# are computed exactly as they would be for a real citizen
# report with these facts.
#
# The archetypes themselves are grounded in established
# disaster-response triage practice:
#   - entrapment (rooftop/structural collapse) as the highest
#     rescue priority
#   - the trauma "golden hour" for acute injuries
#   - mass-casualty-incident response tiers for large groups
#   - prolonged, low-acuity exposure (stranded villages, days
#     without food/water) as a distinct severity pattern
#
# This is a starting point for training LinearUrgencyModel, not
# a substitute for real outcome data. Once real allocation
# outcomes are logged, they should replace this dataset.
# ============================================================

REGION_CENTERS = [
    (20.2961, 85.8245),  # Bhubaneswar
    (20.4625, 85.8828),  # Cuttack
    (19.8135, 85.8312),  # Puri
    (19.3149, 84.7941),  # Berhampur
]

VULNERABLE_CATEGORIES = [
    "elderly",
    "child",
    "infant",
    "disabled",
    "mobility_impaired",
    "pregnant",
]


ARCHETYPES = [
    {
        "name": "rooftop_trapped_rising_water",
        "needs": ["rescue"],
        "people_range": (2, 8),
        "trapped_prob": 1.0,
        "injured_prob": 0.25,
        "vulnerable_prob": 0.3,
        "environmental": ["flooding", "water_entered_house"],
        "time_elapsed_range": (0.5, 48.0),
    },
    {
        "name": "structural_collapse_entrapment",
        "needs": ["rescue", "medical"],
        "people_range": (1, 5),
        "trapped_prob": 1.0,
        "injured_prob": 0.85,
        "vulnerable_prob": 0.2,
        "environmental": ["landslide"],
        "time_elapsed_range": (0.2, 30.0),
    },
    {
        "name": "elderly_disabled_unable_to_evacuate",
        "needs": ["evacuation"],
        "people_range": (1, 3),
        "trapped_prob": 0.4,
        "injured_prob": 0.1,
        "vulnerable_prob": 1.0,
        "environmental": ["flooding"],
        "time_elapsed_range": (1.0, 40.0),
    },
    {
        "name": "acute_medical_no_entrapment",
        "needs": ["medical"],
        "people_range": (1, 4),
        "trapped_prob": 0.0,
        "injured_prob": 1.0,
        "vulnerable_prob": 0.35,
        "environmental": [],
        "time_elapsed_range": (0.1, 6.0),
    },
    {
        "name": "mass_shelter_evacuation",
        "needs": ["evacuation", "shelter"],
        "people_range": (10, 60),
        "trapped_prob": 0.05,
        "injured_prob": 0.1,
        "vulnerable_prob": 0.4,
        "environmental": ["flooding", "cyclone"],
        "time_elapsed_range": (0.5, 20.0),
    },
    {
        "name": "food_water_shortage_stable",
        "needs": ["food", "water"],
        "people_range": (3, 25),
        "trapped_prob": 0.0,
        "injured_prob": 0.0,
        "vulnerable_prob": 0.2,
        "environmental": ["waterlogging"],
        "time_elapsed_range": (2.0, 72.0),
    },
    {
        "name": "minor_injury_self_mobile",
        "needs": ["medical"],
        "people_range": (1, 3),
        "trapped_prob": 0.0,
        "injured_prob": 0.6,
        "vulnerable_prob": 0.1,
        "environmental": [],
        "time_elapsed_range": (0.2, 10.0),
    },
    {
        "name": "multi_day_stranded_village",
        "needs": ["food", "water", "shelter"],
        "people_range": (15, 80),
        "trapped_prob": 0.05,
        "injured_prob": 0.1,
        "vulnerable_prob": 0.5,
        "environmental": ["flooding", "road_blocked"],
        "time_elapsed_range": (48.0, 120.0),
    },
    {
        "name": "fire_immediate_danger",
        "needs": ["rescue", "medical"],
        "people_range": (2, 10),
        "trapped_prob": 0.9,
        "injured_prob": 0.6,
        "vulnerable_prob": 0.3,
        "environmental": ["fire"],
        "time_elapsed_range": (0.05, 3.0),
    },
    {
        "name": "low_severity_routine_request",
        "needs": ["water"],
        "people_range": (1, 4),
        "trapped_prob": 0.0,
        "injured_prob": 0.0,
        "vulnerable_prob": 0.05,
        "environmental": [],
        "time_elapsed_range": (0.5, 10.0),
    },
    {
        "name": "children_stranded_school",
        "needs": ["rescue", "evacuation"],
        "people_range": (5, 30),
        "trapped_prob": 0.6,
        "injured_prob": 0.15,
        "vulnerable_prob": 1.0,
        "environmental": ["flooding"],
        "time_elapsed_range": (0.5, 24.0),
    },
    {
        "name": "pregnant_evacuation",
        "needs": ["medical", "evacuation"],
        "people_range": (1, 3),
        "trapped_prob": 0.1,
        "injured_prob": 0.2,
        "vulnerable_prob": 1.0,
        "environmental": [],
        "time_elapsed_range": (0.2, 8.0),
    },
    {
        "name": "widespread_flooding_large_scale",
        "needs": ["rescue", "food", "shelter"],
        "people_range": (80, 300),
        "trapped_prob": 0.3,
        "injured_prob": 0.15,
        "vulnerable_prob": 0.4,
        "environmental": ["flooding", "cyclone"],
        "time_elapsed_range": (1.0, 60.0),
    },
]


def _build_incident(
    archetype: dict,
    index: int,
    rng: random.Random,
) -> Incident:

    people_count = rng.randint(*archetype["people_range"])

    trapped_prob = archetype["trapped_prob"]
    injured_prob = archetype["injured_prob"]

    is_trapped = rng.random() < trapped_prob
    is_injured = rng.random() < injured_prob

    injury_count = None
    if is_injured:
        injury_count = min(
            people_count,
            rng.randint(1, max(1, people_count)),
        )

    vulnerable_people = []
    if rng.random() < archetype["vulnerable_prob"]:
        sample_size = rng.choice([1, 1, 2])
        vulnerable_people = rng.sample(
            VULNERABLE_CATEGORIES,
            k=min(sample_size, len(VULNERABLE_CATEGORIES)),
        )

    facts = CitizenFacts(
        needs=list(archetype["needs"]),
        people_count=people_count,
        trapped=is_trapped if (is_trapped or trapped_prob == 0) else None,
        injured=is_injured if (is_injured or injured_prob == 0) else None,
        injury_count=injury_count,
        vulnerable_people=vulnerable_people,
        environmental_conditions=list(archetype["environmental"]),
    )

    # Reuse the REAL production pipeline -- these are not
    # invented severity/priority numbers.
    severity_features = calculate_severity_features(facts)
    priority = calculate_priority(facts, severity_features)

    lat_center, lon_center = rng.choice(REGION_CENTERS)
    latitude = lat_center + rng.uniform(-0.05, 0.05)
    longitude = lon_center + rng.uniform(-0.05, 0.05)

    time_elapsed_hours = rng.uniform(*archetype["time_elapsed_range"])
    created_at = (
        datetime.now(timezone.utc) - timedelta(hours=time_elapsed_hours)
    ).isoformat()

    incident_id = f"TRAIN-{archetype['name']}-{index:03d}"

    return Incident(
        incident_id=incident_id,
        request_id=incident_id,
        created_at=created_at,
        latitude=latitude,
        longitude=longitude,
        facts=facts,
        severity_features=severity_features,
        priority=priority,
        confidence=Confidence(),
    )


def generate_dataset(
    per_archetype: int = 25,
    seed: int = 42,
) -> list[Incident]:
    """
    Generate a synthetic training set: `per_archetype` randomized
    variations of each realistic scenario archetype above.
    """

    rng = random.Random(seed)

    incidents = []

    for archetype in ARCHETYPES:
        for index in range(per_archetype):
            incidents.append(_build_incident(archetype, index, rng))

    return incidents
