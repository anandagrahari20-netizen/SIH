import time

from app.analyzer import extract_facts


messages = [
    "Ghar mein paani bhar gaya hai, papa injured hain aur hum 5 log hain.",

    "Hum 6 log chhat pe fase hue hain, dadi chal nahi sakti aur ek uncle ko saans lene mein dikkat ho rahi hai.",

    "Need food and water for 20 people. Road is blocked.",

    "Mummy ko dawa chahiye, unki tabiyat bahut kharab hai.",

    "We are safe. No help needed.",
]


def main():
    for message in messages:

        print("\n" + "=" * 70)
        print("INPUT:")
        print(message)

        start = time.time()

        result = extract_facts(message)

        elapsed = time.time() - start

        print("\nEXTRACTED:")
        print(result.model_dump_json(indent=2))

        print(f"\nTIME: {elapsed:.2f} seconds")


if __name__ == "__main__":
    main()