from app.analyzer import extract_facts


def main():
    print("=== SIH Citizen Intelligence Tester ===")
    print("Type a citizen message.")
    print("Type 'exit' to stop.\n")

    while True:
        text = input("Citizen: ")

        if text.lower() == "exit":
            break

        try:
            result = extract_facts(text)

            print("\nAI OUTPUT:")
            print(result.model_dump_json(indent=2))
            print()

        except Exception as e:
            print(f"\nERROR: {e}\n")


if __name__ == "__main__":
    main()