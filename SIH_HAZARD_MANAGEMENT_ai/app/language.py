# Optional dependency — transliteration falls back to returning the
# original transcript unchanged when no Ollama client/server is present,
# so a missing package must not stop the service from starting.
try:
    import ollama  # type: ignore
except Exception:  # pragma: no cover
    ollama = None


MODEL_NAME = "qwen3:4b"


TRANSLITERATION_PROMPT = """
Convert Hindi written in Devanagari script into Roman Hindi/Hinglish.

Rules:
- Preserve the exact meaning.
- Do not summarize.
- Do not add information.
- Do not remove information.
- Keep numbers as numbers.
- Keep English words in English.
- Output ONLY Roman Hindi/Hinglish.
- Do not output Devanagari.
- Do not add explanations.

Example:

घर में पानी घुस गया है, हम चार लोग हैं।
→ ghar mein pani ghus gaya hai, hum char log hain.

दादी को सांस लेने में दिक्कत है।
→ daadi ko saans lene mein dikkat hai.

खाना और पानी चाहिए।
→ khana aur pani chahiye.
"""


def normalize_hindi_script(text: str) -> str:

    if not isinstance(text, str):
        raise TypeError("text must be a string")

    text = text.strip()

    if not text:
        return ""

    # Roman/English text does not need conversion.
    if not any(
        "\u0900" <= char <= "\u097F"
        for char in text
    ):
        return text

    if ollama is None:
        return text

    try:

        response = ollama.chat(
            model=MODEL_NAME,
            messages=[
                {
                    "role": "system",
                    "content": TRANSLITERATION_PROMPT,
                },
                {
                    "role": "user",
                    "content": text,
                },
            ],
            think=False,
            options={
                "temperature": 0,
            },
        )

        result = response.message.content

        if "</think>" in result:
            result = result.split("</think>", 1)[1].strip()
    

        if result and result.strip():
            return result.strip()

    except Exception:
        pass

    # Never destroy the original transcript.
    return text