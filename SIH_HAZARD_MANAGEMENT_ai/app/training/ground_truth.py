from __future__ import annotations

import math
import random

from app.schemas import DemandCluster


# ============================================================
# GROUND-TRUTH LABELING FUNCTION
#
# LinearUrgencyModel (resource_allocator.py) is a linear model:
# urgency = weighted sum of normalized features. On its own it
# cannot represent thresholds or interactions between features.
#
# This function is deliberately NOT linear -- it exists to give
# the linear model a genuinely different target to approximate,
# grounded in established disaster-response triage doctrine
# rather than restating the same hand-tuned weights back at
# itself (which would make "training" a no-op).
#
# Principles encoded here:
#
#   1. START-style mass-casualty triage: entrapment and acute
#      injury outrank routine needs (food/water/shelter).
#
#   2. Trauma "golden hour": injury urgency is time-sensitive on
#      a SHORT horizon (hours) -- delay compounds risk quickly.
#
#   3. Search & rescue entrapment doctrine: the first ~36 hours
#      after entrapment is treated as the highest-yield rescue
#      window, but urgency never falls back down afterward -- an
#      unresolved entrapment does not become less urgent with
#      time, it plateaus high.
#
#   4. Mass-casualty-incident escalation: severity grows with
#      scale, but with diminishing marginal weight per person,
#      plus a step increase once an incident crosses into a
#      double-digit "MCI" response tier.
#
#   5. Compounding risk: a person who is BOTH trapped AND injured
#      is categorically worse than the two conditions considered
#      separately.
#
#   6. Prolonged low-acuity exposure (e.g. a village stranded for
#      days without food/water, no acute injury) is its own
#      distinct severity driver, separate from acute trauma.
#
# This is synthetic, expert-reasoned ground truth -- NOT a lookup
# into real historical outcomes, because no such dataset exists
# for this project yet. Replace this function with real
# outcome-labeled data as soon as it exists.
# ============================================================


def expert_urgency_label(
    cluster: DemandCluster,
    rng: random.Random,
) -> float:

    people = max(1, cluster.people_affected)

    # ---- baseline from the deterministic priority engine -------
    baseline = 0.30 * cluster.priority_score  # 0-30

    # ---- scale of the incident: diminishing returns + MCI bump -
    scale = 4.5 * math.log1p(people)
    if people >= 10:
        scale += 8.0
    scale = min(scale, 26.0)

    # ---- entrapment: rescue-window urgency, plateaus high ------
    trapped_component = 0.0
    if cluster.trapped_count > 0:
        trapped_fraction = min(1.0, cluster.trapped_count / people)
        rescue_window = min(1.0, cluster.time_elapsed_hours / 36.0)
        trapped_component = 26.0 * trapped_fraction * (0.55 + 0.45 * rescue_window)

    # ---- injury: golden-hour time pressure (short horizon) -----
    injury_component = 0.0
    if cluster.injured_count > 0:
        injury_fraction = min(1.0, cluster.injured_count / people)
        golden_hour_pressure = min(1.0, cluster.time_elapsed_hours / 4.0)
        injury_component = 18.0 * injury_fraction * (0.6 + 0.4 * golden_hour_pressure)

    # ---- compounding risk: trapped AND injured together --------
    compounding = (
        8.0
        if (cluster.trapped_count > 0 and cluster.injured_count > 0)
        else 0.0
    )

    # ---- prolonged exposure, independent of acute trauma --------
    exposure = 6.0 * min(1.0, cluster.time_elapsed_hours / 72.0)

    # ---- breadth of unmet demand ---------------------------------
    demand = min(6.0, cluster.demand_weight / 8.0)

    raw_score = (
        baseline
        + scale
        + trapped_component
        + injury_component
        + compounding
        + exposure
        + demand
    )

    # Small label noise -- real expert judgment isn't perfectly
    # deterministic, and this keeps train/test genuinely distinct
    # rather than a function the model can memorize exactly.
    noisy_score = raw_score + rng.gauss(0, 3.0)

    return round(max(0.0, min(100.0, noisy_score)), 2)
