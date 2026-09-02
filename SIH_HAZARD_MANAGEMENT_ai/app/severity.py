from app.schemas import CitizenFacts, SeverityFeatures


def calculate_severity_features(
    facts: CitizenFacts,
) -> SeverityFeatures:
    """
    Convert extracted citizen facts into deterministic
    severity-related features.

    This function does NOT use the AI model.
    """

    immediate_rescue = facts.trapped is True

    medical_attention = (
        facts.injured is True
        or "medical" in facts.needs
        or facts.medical_issue is not None
    )

    multiple_people = (
        facts.people_count is not None
        and facts.people_count > 1
    )

    vulnerable_person = len(facts.vulnerable_people) > 0

    return SeverityFeatures(
        immediate_rescue=immediate_rescue,
        medical_attention=medical_attention,
        multiple_people=multiple_people,
        vulnerable_person=vulnerable_person,
    )