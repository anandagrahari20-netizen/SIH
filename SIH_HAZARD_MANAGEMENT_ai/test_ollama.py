import time
import ollama


prompt = """
You are an emergency information extraction system.

Extract ONLY the facts explicitly present in the citizen message.

Return ONLY JSON.
Do not explain.
Do not reason.
Do not give advice.
Do not repeat the message.

Use exactly these fields:
- house_flooded: boolean
- injured: boolean
- injured_count: integer or null
- total_people: integer or null
- trapped: boolean
- needs: array of strings

Citizen message:
Ghar mein paani bhar gaya hai, papa injured hain aur hum 5 log hain.
"""


def main():
    start = time.time()

    response = ollama.chat(
        model="qwen3:1.7b",
        messages=[
            {
                "role": "user",
                "content": prompt,
            }
        ],
        think=False,
    )

    elapsed = time.time() - start

    print("\nMODEL RESPONSE:")
    print(response.message.content)

    print(f"\nTIME: {elapsed:.2f} seconds")


if __name__ == "__main__":
    main()