"""
AI Emergency Helpline — conversational turn handler.

The citizen talks to the Kavach "helpline" by voice. Each spoken turn
is sent here; we return the assistant's next spoken line PLUS a live,
*deterministic* severity assessment computed from everything the caller
has said so far.

Design:
  - The LLM only writes the conversational reply (calm, one question at
    a time). It never decides the severity score.
  - Severity/priority come from the existing deterministic pipeline
    (analyzer.extract_facts -> severity -> priority), so the score is
    explainable and identical to the rest of the system.

LLM provider chain (first that works wins):
  1. Ollama  — local model (same as analyzer.MODEL_NAME). Free, private,
     works offline; only reachable when the backend host runs Ollama.
  2. Groq    — free hosted API (OPENAI-compatible). Set GROQ_API_KEY.
  3. Gemini  — free hosted API. Set GEMINI_API_KEY.
  4. Scripted — a fixed EN/HI/Hinglish question flow, no LLM at all.
     Guarantees the helpline always responds.
"""

from __future__ import annotations

import os
from typing import List, Optional

import requests

from app.analyzer import MODEL_NAME, extract_facts
from app.priority import calculate_priority
from app.severity import calculate_severity_features

try:  # ollama is an optional runtime dependency
    import ollama  # type: ignore
except Exception:  # pragma: no cover
    ollama = None


GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
OLLAMA_ENABLED = os.environ.get("HELPLINE_USE_OLLAMA", "1") != "0"

REQUEST_TIMEOUT = 12

LANG_NAME = {
    "english": "English",
    "hindi": "Hindi (Devanagari)",
    "hinglish": "Hinglish (Hindi written in Roman letters)",
}

SYSTEM_PROMPT = (
    "You are Kavach, an Indian government emergency helpline assistant. "
    "A citizen is calling during a disaster. Reply in {lang}. "
    "Be calm and reassuring. Keep every reply to ONE or TWO short sentences. "
    "Ask exactly ONE question per turn to find out, in this order: what has "
    "happened, how many people are with them, is anyone injured, is anyone "
    "trapped, and their location or a nearby landmark. "
    "Do NOT give medical instructions beyond basic reassurance. "
    "Once you know the situation, people count and whether anyone is "
    "injured/trapped, tell them a response team is being dispatched and to "
    "stay on the line. Never invent facts."
)

# Fixed fallback script — one line per stage, no LLM needed.
SCRIPT = {
    "english": [
        "Kavach emergency helpline. Please tell me what has happened.",
        "Thank you. How many people are with you right now?",
        "Is anyone injured or unwell?",
        "Is anyone trapped or unable to move to safety?",
        "What is your location or a nearby landmark?",
        "A response team is being dispatched to your location. Please stay on the line and keep safe.",
    ],
    "hindi": [
        "कवच आपातकालीन हेल्पलाइन। कृपया बताइए क्या हुआ है।",
        "धन्यवाद। इस समय आपके साथ कितने लोग हैं?",
        "क्या कोई घायल या बीमार है?",
        "क्या कोई फँसा हुआ है या सुरक्षित जगह नहीं जा पा रहा?",
        "आपका स्थान या पास की कोई पहचान बताइए।",
        "एक राहत टीम आपके स्थान पर भेजी जा रही है। कृपया लाइन पर बने रहें और सुरक्षित रहें।",
    ],
    "hinglish": [
        "Kavach emergency helpline. Kripya bataiye kya hua hai.",
        "Dhanyavaad. Is samay aapke saath kitne log hain?",
        "Kya koi ghayal ya bimaar hai?",
        "Kya koi phansa hua hai ya safe jagah nahi ja pa raha?",
        "Aapki location ya paas ki koi pehchaan bataiye.",
        "Ek response team aapki location par bheji ja rahi hai. Kripya line par bane rahein aur safe rahein.",
    ],
}


# ------------------------------------------------------------------
# LLM providers
# ------------------------------------------------------------------

def _messages(system: str, history: List[dict], user_text: str) -> List[dict]:
    msgs = [{"role": "system", "content": system}]
    for turn in history:
        role = "assistant" if turn.get("role") == "assistant" else "user"
        msgs.append({"role": role, "content": turn.get("text", "")})
    if user_text:
        msgs.append({"role": "user", "content": user_text})
    return msgs


def _try_ollama(system: str, history: List[dict], user_text: str) -> Optional[str]:
    if not (OLLAMA_ENABLED and ollama):
        return None
    try:
        resp = ollama.chat(
            model=MODEL_NAME,
            messages=_messages(system, history, user_text),
            think=False,
            options={"temperature": 0.4, "num_predict": 120},
        )
        return (resp.message.content or "").strip() or None
    except Exception:
        return None


def _try_groq(system: str, history: List[dict], user_text: str) -> Optional[str]:
    if not GROQ_API_KEY:
        return None
    try:
        r = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            json={
                "model": GROQ_MODEL,
                "messages": _messages(system, history, user_text),
                "temperature": 0.4,
                "max_tokens": 120,
            },
            timeout=REQUEST_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip() or None
    except Exception:
        return None


def _try_gemini(system: str, history: List[dict], user_text: str) -> Optional[str]:
    if not GEMINI_API_KEY:
        return None
    try:
        contents = []
        for turn in history:
            role = "model" if turn.get("role") == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": turn.get("text", "")}]})
        if user_text:
            contents.append({"role": "user", "parts": [{"text": user_text}]})
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
            params={"key": GEMINI_API_KEY},
            json={
                "system_instruction": {"parts": [{"text": system}]},
                "contents": contents,
                "generationConfig": {"temperature": 0.4, "maxOutputTokens": 120},
            },
            timeout=REQUEST_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip() or None
    except Exception:
        return None


def _scripted_reply(language: str, assistant_turns: int) -> str:
    lines = SCRIPT.get(language, SCRIPT["english"])
    idx = min(assistant_turns, len(lines) - 1)
    return lines[idx]


def generate_reply(language: str, history: List[dict], user_text: str) -> tuple[str, str]:
    """Return (reply_text, provider_used)."""
    system = SYSTEM_PROMPT.format(lang=LANG_NAME.get(language, "English"))
    for name, fn in (("ollama", _try_ollama), ("groq", _try_groq), ("gemini", _try_gemini)):
        reply = fn(system, history, user_text)
        if reply:
            # models sometimes wrap replies in quotes / add a name prefix
            return reply.strip().strip('"'), name
    assistant_turns = sum(1 for t in history if t.get("role") == "assistant")
    return _scripted_reply(language, assistant_turns), "scripted"


# ------------------------------------------------------------------
# Turn handler
# ------------------------------------------------------------------

def handle_turn(
    language: str,
    history: List[dict],
    user_text: str,
) -> dict:
    """
    One conversational turn.

    Returns: reply, provider, transcript, facts, severity_features,
    priority, done.
    """

    language = (language or "english").lower()
    history = history or []

    reply, provider = generate_reply(language, history, user_text)

    # Deterministic assessment over the WHOLE caller transcript so far.
    caller_text = " ".join(
        [t.get("text", "") for t in history if t.get("role") != "assistant"]
        + ([user_text] if user_text else [])
    ).strip()

    facts = extract_facts(caller_text) if caller_text else extract_facts("")
    severity_features = calculate_severity_features(facts)
    priority = calculate_priority(facts, severity_features)

    caller_turns = sum(1 for t in history if t.get("role") != "assistant") + (1 if user_text else 0)
    have_core = bool(facts.needs) and facts.people_count is not None
    done = caller_turns >= 5 or (have_core and (facts.injured is not None or facts.trapped is not None) and caller_turns >= 3)

    return {
        "reply": reply,
        "provider": provider,
        "transcript": caller_text,
        "facts": facts,
        "severity_features": severity_features,
        "priority": priority,
        "done": done,
    }
