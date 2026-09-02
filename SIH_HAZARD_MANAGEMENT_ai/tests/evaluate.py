import json
import sys
from pathlib import Path


# ============================================================
# PATHS
# ============================================================

ROOT = Path(__file__).resolve().parents[1]

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


from app.analyzer import extract_facts


DATASET = (
    Path(sys.argv[1])
    if len(sys.argv) > 1
    else Path(__file__).parent / "evaluation_dataset.json"
)


FIELDS = [
    "people_count",
    "trapped",
    "injured",
    "injury_count",
    "medical_issue",
    "vulnerable_people",
    "environmental_conditions",
    "needs",
]


# ============================================================
# HELPERS
# ============================================================

def normalize(value):

    if isinstance(value, list):
        return sorted(value)

    return value


# ============================================================
# MAIN
# ============================================================

def main():

    print()
    print("=" * 70)
    print("AI/NLP EVALUATION")
    print("=" * 70)

    print()
    print("Evaluator:", Path(__file__).resolve())
    print("Dataset:  ", DATASET.resolve())

    # --------------------------------------------------------
    # LOAD DATASET
    # --------------------------------------------------------

    with open(
        DATASET,
        "r",
        encoding="utf-8",
    ) as f:

        cases = json.load(f)

    print("Cases loaded:", len(cases))
    print()

    # --------------------------------------------------------
    # EVALUATION
    # --------------------------------------------------------

    total_checks = 0
    passed_checks = 0
    passed_cases = 0

    for case in cases:

        case_id = case["id"]
        text = case["text"]
        expected = case["expected"]

        try:

            result = extract_facts(text)

        except Exception as exc:

            print(f"❌ {case_id} — ERROR")
            print(f"   {exc}")
            print()

            continue

        case_passed = True

        for field in FIELDS:

            expected_value = normalize(
                expected.get(field)
            )

            actual_value = normalize(
                getattr(result, field, None)
            )

            total_checks += 1

            if actual_value == expected_value:

                passed_checks += 1

            else:

                case_passed = False

                print(
                    f"   ❌ {field}: "
                    f"expected={expected_value!r}, "
                    f"actual={actual_value!r}"
                )

        if case_passed:

            passed_cases += 1
            print(f"✅ {case_id}")

        else:

            print(f"❌ {case_id}")

        print()

    # --------------------------------------------------------
    # RESULTS
    # --------------------------------------------------------

    total_cases = len(cases)

    field_accuracy = (
        passed_checks / total_checks * 100
        if total_checks
        else 0
    )

    case_accuracy = (
        passed_cases / total_cases * 100
        if total_cases
        else 0
    )

    print("=" * 70)
    print("RESULTS")
    print("=" * 70)

    print(
        f"Cases:        {passed_cases}/{total_cases}"
    )

    print(
        f"Field checks: {passed_checks}/{total_checks}"
    )

    print(
        f"Field accuracy: {field_accuracy:.2f}%"
    )

    print(
        f"Case accuracy:  {case_accuracy:.2f}%"
    )

    print("=" * 70)
    print()


if __name__ == "__main__":
    main()