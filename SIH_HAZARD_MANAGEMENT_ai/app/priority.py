import math

from app.schemas import CitizenFacts, SeverityFeatures, PriorityAssessment


# ============================================================
# PRIORITY ASSESSMENT
#
# Deterministic and explainable. The AI extracts facts; this
# converts those facts into an operational priority. It does NOT
# use an LLM.
#
# TWO SEPARATE OUTPUTS, deliberately:
#
#   level  -- the hard triage TIER (CRITICAL/HIGH/MEDIUM/LOW),
#             decided by the presence of life-threatening facts.
#             The allocator serves every CRITICAL before any HIGH,
#             so this must not drift with headcount: two trapped
#             people are just as CRITICAL as fifty.
#
#   score  -- a graded 0-100 MAGNITUDE within that tier, which
#             DOES scale with how many people are trapped/injured/
#             affected. This is what the urgency model consumes to
#             decide which of two CRITICAL incidents gets the
#             nearest unit first.
#
# Previously `score` hit its 100 cap on almost any trapped+injured
# report, so a 2-person entrapment and a 50-person mass-casualty
# incident were indistinguishable to the highest-weighted feature
# in the urgency model. The magnitude terms below keep headroom so
# scale actually shows through.
# ============================================================


# Points for the FIRST affected person in each category, plus a
# saturating bonus for additional people. log1p keeps the marginal
# value of each extra casualty diminishing (10 -> 11 trapped matters
# far less than 1 -> 2) without ever flattening completely.
_TRAPPED_BASE = 30.0
_TRAPPED_SCALE = 16.0

_INJURED_BASE = 26.0
_INJURED_SCALE = 14.0

_AFFECTED_SCALE = 10.0

# Headcount at which an incident is treated as a mass-casualty
# incident and earns a step increase.
_MCI_THRESHOLD = 10
_MCI_BONUS = 8.0


def _scaled(count: int, cap_reference: int) -> float:
    """
    0-1, saturating. 1 person -> 0, `cap_reference` people -> ~1.
    """

    if count <= 1:
        return 0.0

    return min(1.0, math.log1p(count - 1) / math.log1p(cap_reference - 1))


def calculate_priority(
    facts: CitizenFacts,
    severity: SeverityFeatures,
) -> PriorityAssessment:

    reasons: list[str] = []
    score = 0.0

    people = facts.people_count or 1
    trapped_count = people if facts.trapped is True else 0
    injured_count = (
        facts.injury_count
        if facts.injury_count is not None
        else (1 if facts.injured is True else 0)
    )
    injured_count = min(injured_count, people)

    # --------------------------------------------------------
    # 1. IMMEDIATE RESCUE  (entrapment)
    # --------------------------------------------------------
    if facts.trapped is True:
        bonus = _TRAPPED_SCALE * _scaled(trapped_count, 20)
        score += _TRAPPED_BASE + bonus
        if trapped_count > 1:
            reasons.append(f"{trapped_count} people reported trapped")
        else:
            reasons.append("Citizen is trapped")

    elif "rescue" in facts.needs:
        score += 18
        reasons.append("Rescue assistance is required")

    # --------------------------------------------------------
    # 2. MEDICAL EMERGENCY
    # --------------------------------------------------------
    if injured_count > 0:
        bonus = _INJURED_SCALE * _scaled(injured_count, 15)
        score += _INJURED_BASE + bonus
        if injured_count > 1:
            reasons.append(f"{injured_count} people reported injured")
        else:
            reasons.append("Injury is reported")

    elif severity.medical_attention:
        score += 20
        reasons.append("Medical attention is required")

    # --------------------------------------------------------
    # 3. SCALE OF THE INCIDENT
    #    More people in one place must outrank fewer people in
    #    another, all else being equal.
    # --------------------------------------------------------
    if people > 1:
        score += _AFFECTED_SCALE * _scaled(people, 25)
        reasons.append(f"{people} people affected")

    if people >= _MCI_THRESHOLD:
        score += _MCI_BONUS
        reasons.append(
            f"Mass-casualty scale ({people} people) — escalated response tier"
        )

    # --------------------------------------------------------
    # 4. VULNERABLE PEOPLE
    # --------------------------------------------------------
    if severity.vulnerable_person:
        score += 9
        reasons.append("Vulnerable person is present")

    # --------------------------------------------------------
    # 5. ENVIRONMENTAL HAZARD
    # --------------------------------------------------------
    if facts.environmental_conditions:
        score += 7
        reasons.append("Environmental hazard is reported")

    # --------------------------------------------------------
    # 6. BASIC ASSISTANCE (relief, no acute trauma)
    # --------------------------------------------------------
    if (
        not facts.trapped
        and not severity.medical_attention
        and "rescue" not in facts.needs
        and any(
            need in facts.needs
            for need in ["food", "water", "shelter"]
        )
    ):
        score += 16
        reasons.append("Basic assistance is required")

    score = int(round(min(score, 100.0)))

    # --------------------------------------------------------
    # 7. TRIAGE TIER
    #
    # Decided by the FACTS, not by the magnitude score, so the
    # tier never softens just because few people are involved.
    # Entrapment or injury is life-threatening at any headcount.
    # --------------------------------------------------------
    if facts.trapped is True or injured_count > 0:
        level = "CRITICAL"

    elif severity.medical_attention or "rescue" in facts.needs:
        level = "HIGH"

    elif severity.vulnerable_person and facts.environmental_conditions:
        level = "HIGH"

    elif facts.needs or facts.environmental_conditions:
        level = "MEDIUM"

    else:
        level = "LOW"

    # --------------------------------------------------------
    # 8. FALLBACK
    # --------------------------------------------------------
    if not reasons:
        reasons.append("No immediate emergency indicators detected")

    return PriorityAssessment(
        score=score,
        level=level,
        reasons=reasons,
    )
