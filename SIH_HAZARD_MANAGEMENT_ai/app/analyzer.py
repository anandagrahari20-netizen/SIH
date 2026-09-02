import re
from typing import Optional, Literal

from pydantic import BaseModel, ValidationError

from app.schemas import CitizenFacts

# Ollama is an OPTIONAL runtime dependency. Every extraction path below
# already falls back to the deterministic rule engine when the model is
# unavailable, so a missing client must degrade rather than take the
# whole service down at import time (a hard import here would stop the
# Cloud Run container from booting at all).
try:
    import ollama  # type: ignore
except Exception:  # pragma: no cover
    ollama = None


# ============================================================
# MODEL
# ============================================================

MODEL_NAME = "qwen3:4b"


# ============================================================
# RAW MODEL OUTPUT
# ============================================================

class RawExtraction(BaseModel):
    """
    Internal representation returned by Qwen.

    IMPORTANT:
    These are NOT trusted directly.
    Python normalizes and validates them before they become
    CitizenFacts.
    """

    needs: list[str] = []

    people_count: Optional[int] = None

    trapped: Optional[bool] = None

    injured: Optional[bool] = None

    injury_count: Optional[int] = None

    medical_issue: Optional[str] = None

    vulnerable_people: list[str] = []

    environmental_conditions: list[str] = []


# ============================================================
# QWEN SYSTEM PROMPT
# ============================================================

SYSTEM_PROMPT = """
You are a disaster-response information extraction engine.

Your job is ONLY to understand what the citizen explicitly says.

The citizen may use:

- English
- Roman Hindi
- Hinglish
- informal Roman Hindi
- SMS abbreviations
- spelling mistakes
- missing vowels
- shortened words
- mixed English and Hindi

Understand MEANING, not exact spelling.

Examples:

"pani", "paani" -> water
"ghar me", "ghar mein", "ghar m" -> in the house
"aa gaya", "aa gya" -> came
"ghus gaya", "ghus gya" -> entered
"fase hue", "fase hain", "phas gaye" -> trapped
"chal nahi pa rahi" -> unable to walk
"ghayal", "chot lagi" -> injured
"dadi", "nani", "dada", "nana" -> elderly
"bachcha", "bachche" -> child

============================================================
STRICT EVIDENCE RULE
============================================================

Extract ONLY information explicitly stated or directly supported.

NEVER invent facts.

If something is not mentioned, use null or [].

Unknown does NOT mean false.

For example:

"ghar m pani aa gya"

means:

people_count = null
trapped = null
injured = null
medical_issue = null
vulnerable_people = []
environmental_conditions = ["water entered house"]

It does NOT mean:

trapped = true
injured = false
rescue = true

============================================================
PEOPLE COUNT
============================================================

Extract an explicitly stated TOTAL number of people.

Examples:

"4 log hain" -> 4
"hum 6 log hain" -> 6
"there are 5 people" -> 5
"family of 5" -> 5
"4 log h" -> 4
"hum paanch log hain" -> 5

Do not calculate totals from subgroup counts.

============================================================
TRAPPED
============================================================

true ONLY when the message explicitly says:

- trapped
- stuck
- fase hue
- fase hain
- phasa hua
- phasi hui
- phas gaye
- phanse hue
- cannot get out
- can't get out
- cannot leave
- can't leave
- bahar nahi nikal sakte

Water entering a house does NOT automatically mean trapped.

"pls help" does NOT automatically mean trapped.

If trapping is not stated, use null.

If the citizen explicitly says they are NOT trapped,
use false.

============================================================
INJURY
============================================================

true ONLY when injury is explicitly stated.

Examples:

"injured"
"injury"
"ghayal"
"chot lagi"
"hurt"
"bleeding"

Do NOT infer injury from:

- flood
- ambulance
- rescue
- emergency
- road blockage

If injury is not mentioned, use null.

injury_count must ONLY be populated when an explicit number
of injured people is stated.

============================================================
MEDICAL ISSUE
============================================================

medical_issue should contain a short description ONLY when
a specific medical problem is explicitly stated.

Examples:

"saans lene mein dikkat"
-> "breathing difficulty"

"difficulty breathing"
-> "breathing difficulty"

"fever hai"
-> "fever"

"doctor chahiye"
-> "doctor needed"

"papa injured hain"
-> "injury"

Do NOT diagnose.

Do NOT invent a medical condition.

Do NOT put YES, NO, UNKNOWN, null, or similar control values
inside medical_issue.

"ambulance nahi aa rahi" alone does NOT mean medical.

MEDICAL ISSUE RULES:

medical_issue must describe the actual medical condition or symptom.

Examples:

"breathing mein problem" → "breathing difficulty"
"saans lene mein dikkat" → "breathing difficulty"
"chot lagi" → "injury"
"injured" → "injury"
"bleeding ho rahi hai" → "bleeding"

Do NOT use the requested medical service as the medical_issue.

"doctor chahiye" → medical need, but medical_issue = null
"ambulance chahiye" → medical need only if supported by medical evidence
"hospital chahiye" → medical need, but medical_issue = null

If both a condition and a requested service are present,
extract the condition.

Example:
"Papa ko saans lene mein dikkat hai aur doctor chahiye"
→ medical_issue = "breathing difficulty"

============================================================
VULNERABLE PEOPLE
============================================================

Identify only explicitly mentioned vulnerable people.

Examples:

"dadi" -> elderly
"nani" -> elderly
"dada" -> elderly
"nana" -> elderly
"buzurg" -> elderly
"elderly" -> elderly

"bachcha" -> child
"child" -> child

"baby" -> infant
"infant" -> infant

"disabled" -> disabled

"wheelchair" or explicit inability to walk
-> mobility_impaired

"pregnant" -> pregnant

Do NOT assume:

"mummy" -> elderly
"papa" -> elderly
"uncle" -> elderly

============================================================
ENVIRONMENT
============================================================

Identify only explicitly stated conditions.

Examples:

"ghar mein pani ghus gaya"
-> "water entered house"

"ghar m pani aa gya"
-> "water entered house"

"road blocked"
-> "road blocked"

"rasta band hai"
-> "road blocked"

"waterlogging"
-> "waterlogging"

"landslide"
-> "landslide"

"fire"
-> "fire"

"cyclone"
-> "cyclone"

"earthquake"
-> "earthquake"

Do NOT invent environmental conditions.

ENVIRONMENTAL CONDITION RULES:

Extract environmental conditions from the meaning of the sentence,
not only exact keywords.

Examples:

"road ke paas pani jama hai"
→ waterlogging

"road pe bahut paani khada hai"
→ waterlogging

"ghar mein pani aa gaya hai"
→ water_entered_house

"ghar mein paani ghus gaya"
→ water_entered_house

"road band hai"
→ road_blocked

"road blocked hai"
→ road_blocked

"landslide hua hai"
→ landslide

"fire lagi hai"
→ fire

NEED CLASSIFICATION IS MULTI-LABEL.

If multiple different types of assistance are explicitly requested,
return ALL applicable needs.

Examples:

"khana aur pani chahiye"
→ ["food", "water"]

"food and water needed"
→ ["food", "water"]

"rescue aur medical help chahiye"
→ ["rescue", "medical"]

"food, water aur shelter chahiye"
→ ["food", "water", "shelter"]

Never choose only one need when multiple needs are explicitly present.


============================================================
NEEDS
============================================================

You may return needs when explicitly requested or directly supported.

Possible values:

rescue
medical
food
water
shelter
evacuation

IMPORTANT:

"pls help" alone does NOT specify rescue.

If someone is explicitly trapped, rescue is directly supported.

If someone is explicitly injured or has a medical problem,
medical is directly supported.

Do not infer food, drinking water, shelter, or evacuation
unless the message supports it.

NEGATION RULE:

Explicit negative statements override positive interpretations.

Examples:

"injured nahi hai"
→ injured = false

"injury nahi hai"
→ injured = false

"no one is injured"
→ injured = false

"not injured"
→ injured = false

"trapped nahi hain"
→ trapped = false

"we are not trapped"
→ trapped = false

"safe hain"
→ do not infer injured or trapped

Do not classify a person as injured or trapped merely because
words such as "injured", "hurt", "stuck", "trapped" appear inside
a negated statement.

IMPORTANT:

Never infer rescue or medical need solely from the presence of
a negated emergency condition.

Example:

"No one is injured and we are not trapped."
→ needs = []

Example:

"We are safe and do not need help."
→ needs = []

============================================================
FINAL RULE
============================================================

Return ONLY JSON matching the requested schema.

Do not explain.

Do not give advice.

Do not assign priority.
"""



# ============================================================
# NUMBER WORDS
# ============================================================

NUMBER_WORDS = {
    "एक": 1,
    "दो": 2,
    "तीन": 3,
    "चार": 4,
    "पांच": 5,
    "पाँच": 5,
    "छह": 6,
    "सात": 7,
    "आठ": 8,
    "नौ": 9,
    "दस": 10,
    "बीस": 20,
    "पचास": 50,
    "सौ": 100,
    "१": 1,
    "२": 2,
    "३": 3,
    "४": 4,
    "५": 5,
    "६": 6,
    "७": 7,
    "८": 8,
    "९": 9,

    "ek": 1,
    "one": 1,

    "do": 2,
    "two": 2,

    "teen": 3,
    "three": 3,

    "char": 4,
    "chaar": 4,
    "four": 4,

    "paanch": 5,
    "panch": 5,
    "five": 5,

    "chhe": 6,
    "che": 6,
    "chhah": 6,
    "six": 6,

    "saat": 7,
    "seven": 7,

    "aath": 8,
    "eight": 8,

    "nau": 9,
    "nine": 9,

    "das": 10,
    "ten": 10,
}


def _number_from_word(value: str) -> int:

    value = value.lower().strip()

    if value.isdigit():
        return int(value)

    return NUMBER_WORDS.get(value, 1)  # noqa: E501


# ============================================================
# TEXT HELPERS
# ============================================================

def _has_any(
    text: str,
    phrases: list[str],
) -> bool:

    import unicodedata

    def normalize(value: str) -> str:
        return (
            unicodedata.normalize("NFKC", value)
            .lower()
            .replace("\u2019", "'")
            .replace("\u2018", "'")
            .replace("\u201c", '"')
            .replace("\u201d", '"')
            .replace("\u00a0", " ")
            .strip()
        )

    normalized_text = normalize(text)

    return any(
        normalize(phrase) in normalized_text
        for phrase in phrases
    )


# ============================================================
# PEOPLE COUNT
# ============================================================

def _extract_explicit_people_count(
    text: str,
) -> Optional[int]:

    number_pattern = (
        r"(?:\d+|"
        r"ek|one|"
        r"do|two|"
        r"teen|three|"
        r"char|chaar|four|"
        r"paanch|panch|five|"
        r"chhe|che|chhah|six|"
        r"saat|seven|"
        r"aath|eight|"
        r"nau|nine|"
        r"das|ten|"
        # Devanagari number words, so a Hindi caller's headcount is
        # not silently dropped.
        r"एक|दो|तीन|चार|पांच|पाँच|छह|सात|आठ|नौ|दस|बीस|पचास)"
    )

    patterns = [

        # 4 log / 4 people
        rf"\b({number_pattern})\s*"
        r"(?:log|people|persons|person|members|logo|logon|aadmi|admi|vyakti|लोग|लोगों|व्यक्ति|आदमी|जन)\b",

        # hum 4 log
        rf"\b(?:hum|we)\s+"
        rf"({number_pattern})\s*"
        r"(?:log|people|persons|members|logo|logon|aadmi|admi|vyakti|लोग|लोगों|व्यक्ति|आदमी|जन)\b",

        # family of 5
        rf"\bfamily\s+of\s+"
        rf"({number_pattern})\b",

        # there are 5 people
        rf"\bthere\s+are\s+"
        rf"({number_pattern})\s+"
        r"(?:people|persons|members|of\s+us)\b",

        # 4 log h
        rf"\b({number_pattern})\s*"
        r"(?:log|people|persons|members|logo|logon|aadmi|admi|vyakti|लोग|लोगों|व्यक्ति|आदमी|जन)\s*"
        r"(?:h|hai|hain)\b",
    ]

    for pattern in patterns:

        match = re.search(
            pattern,
            text,
            re.IGNORECASE,
        )

        if match:

            return _number_from_word(
                match.group(1)
            )

    return None


# ============================================================
# INJURY COUNT
# ============================================================

def _extract_explicit_injury_count(
    text: str,
) -> Optional[int]:

    number_pattern = (
        r"(?:\d+|"
        r"ek|one|"
        r"do|two|"
        r"teen|three|"
        r"char|chaar|four|"
        r"paanch|panch|five|"
        r"chhe|che|chhah|six|"
        r"saat|seven|"
        r"aath|eight|"
        r"nau|nine|"
        r"das|ten)"
    )

    patterns = [

        rf"\b({number_pattern})\s*"
        r"(?:people|persons|person|log|members|aadmi|insaan)"
        r"\s*(?:are|is|hain|hai|ko)?\s*"
        r"(?:injured|hurt|ghayal)\b",

        rf"\b({number_pattern})\s*"
        r"(?:injured|hurt|ghayal)\b",

        rf"\b({number_pattern})\s*"
        r"(?:people|persons|person|log|members)"
        r"\s*(?:have|has|ko)?\s*"
        r"(?:injuries|injury|chot)\b",
    ]

    for pattern in patterns:

        match = re.search(
            pattern,
            text,
            re.IGNORECASE,
        )

        if match:

            return _number_from_word(
                match.group(1)
            )

    return None


# ============================================================
# LOCATION
# ============================================================

def _extract_location(
    text: str,
) -> Optional[str]:

    patterns = [

        r"\b(Cuttack\s+ke\s+Sector\s+\d+)\b",

        r"\b(Bhubaneswar\s+ke\s+Sector\s+\d+)\b",

        r"\b(Sector\s+\d+)\b",

        r"\b(Bhubaneswar)\b",

        r"\b(Cuttack)\b",

        r"\b(Patia)\b",

        r"\b(Puri)\b",

        r"\b(Berhampur)\b",

        r"\b(Brahmapur)\b",

        r"\b(Village\s+[A-Za-z0-9_-]+)\b",
    ]

    for pattern in patterns:

        match = re.search(
            pattern,
            text,
            re.IGNORECASE,
        )

        if match:

            return match.group(1).strip()

    return None


# ============================================================
# CANONICALIZE VULNERABLE PEOPLE
# ============================================================

def _canonical_vulnerable_people(
    text: str,
    model_values: list[str],
) -> list[str]:

    lower = text.lower()

    vulnerable = set()

    # --------------------------------------------------------
    # Elderly
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "dadi",
            "nani",
            "dada",
            "nana",
            "buzurg",
            "elderly",
            "grandmother",
            "grandfather",
            "old person",
            "aged person",
        ],
    ):

        vulnerable.add("elderly")

    # --------------------------------------------------------
    # Child
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "bachcha",
            "bachche",
            "child",
            "children",
            "kid",
            "kids",
            "baccha",
            "bacche",
        ],
    ):

        vulnerable.add("child")

    # --------------------------------------------------------
    # Infant
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "baby",
            "infant",
            "newborn",
        ],
    ):

        vulnerable.add("infant")

    # --------------------------------------------------------
    # Disability
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "disabled",
            "disability",
            "viklang",
        ],
    ):

        vulnerable.add("disabled")

    # --------------------------------------------------------
    # Mobility impairment
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "chal nahi pa raha",
            "chal nahi pa rahi",
            "chal nahi pa rahe",
            "chal nahi sakta",
            "chal nahi sakti",
            "chal nahi sakte",
            "chalne mein dikkat",
            "chalne me dikkat",
            "walk nahi kar pa raha",
            "walk nahi kar pa rahi",
            "walk nahi kar pa rahe",
            "cannot walk",
            "unable to walk",
            "can't walk",
            "wheelchair",
        ],
    ):

        vulnerable.add("mobility_impaired")

    # --------------------------------------------------------
    # Pregnancy
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "pregnant",
            "pregnancy",
            "garbhavati",
        ],
    ):

        vulnerable.add("pregnant")

    # --------------------------------------------------------
    # Also canonicalize useful model aliases
    # --------------------------------------------------------

    aliases = {
        "dadi": "elderly",
        "nani": "elderly",
        "dada": "elderly",
        "nana": "elderly",
        "grandmother": "elderly",
        "grandfather": "elderly",
        "buzurg": "elderly",

        "bachcha": "child",
        "bachche": "child",
        "children": "child",
        "kids": "child",
        "kid": "child",

        "baby": "infant",
        "newborn": "infant",

        "wheelchair": "mobility_impaired",
    }

    for value in model_values:

        canonical = aliases.get(
            value.lower().strip()
        )

        if canonical:

            vulnerable.add(canonical)

    return sorted(vulnerable)


# ============================================================
# CANONICALIZE ENVIRONMENT
# ============================================================

def _canonical_environment(
    text: str,
    model_values: list[str],
) -> list[str]:

    lower = text.lower()

    conditions = set()

    # --------------------------------------------------------
    # Water entered house
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "ghar mein pani ghus",
            "ghar me pani ghus",
            "ghar m pani ghus",
            "ghar mein paani ghus",
            "ghar me paani ghus",
            "ghar m paani ghus",

            "ghar mein pani aa",
            "ghar me pani aa",
            "ghar m pani aa",
            "ghar mein paani aa",
            "ghar me paani aa",
            "ghar m paani aa",

            "water entered house",
            "water entered the house",
            "water entered my house",
            "water entered house",
            "water entered the house",
            "water has entered the house",

            "pani ghar mein aa gaya",
            "pani ghar me aa gaya",
            "paani ghar mein aa gaya",
            "paani ghar me aa gaya",

            "ghar mein pani aa gaya",
            "ghar mein paani aa gaya",
            "ghar me pani aa gaya",
            "ghar me paani aa gaya",

            "ghar m pani hai",
            "ghar mein pani hai",
            "ghar me pani hai",
            "ghar mein paani hai",
            "ghar me paani hai",
            "ghar ke andar pani",
            "ghar ke ander pani",
            "ghar ke andar paani",
            "ghar ke ander paani",
        ],
    ):

        conditions.add(
            "water_entered_house"
        )

    # --------------------------------------------------------
    # Waterlogging
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "waterlogging",
            "water logged",
            "waterlogged",
            "pani jama",
            "paani jama",
            "road pe pani jama",
            "road par pani jama",
            "road pe paani jama",
            "road par paani jama",
            "pani khada hai",
            "paani khada hai",
            "pani bhar gaya",
            "paani bhar gaya",
        ],
    ):

        conditions.add(
            "waterlogging"
        )

    # --------------------------------------------------------
    # Road blocked
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "road blocked",
            "road is blocked",
            "road block",
            "rasta band",
            "raasta band",
            "sadak band",
            "road band",
        ],
    ):

        conditions.add(
            "road_blocked"
        )

    # --------------------------------------------------------
    # Flooding
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "flood",
            "flooded",
            "flooding",
            "baadh",
            "badh",
        ],
    ):

        conditions.add(
            "flooding"
        )

    # --------------------------------------------------------
    # Landslide
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "landslide",
            "land slide",
            "landslide hua",
        ],
    ):

        conditions.add(
            "landslide"
        )

    # --------------------------------------------------------
    # Cyclone
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "cyclone",
            "hurricane",
        ],
    ):

        conditions.add(
            "cyclone"
        )

    # --------------------------------------------------------
    # Fire
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "fire",
            "aag",
        ],
    ):

        conditions.add(
            "fire"
        )

    # --------------------------------------------------------
    # Earthquake
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "earthquake",
            "bhukamp",
        ],
    ):

        conditions.add(
            "earthquake"
        )

    # --------------------------------------------------------
    # Canonicalize model values only when they have evidence
    # --------------------------------------------------------

    aliases = {
        "water entered house": "water_entered_house",
        "water entered the house": "water_entered_house",
        "water entered my house": "water_entered_house",

        "waterlogging": "waterlogging",
        "water logged": "waterlogging",
        "waterlogged": "waterlogging",

        "road blocked": "road_blocked",
        "road is blocked": "road_blocked",

        "flood": "flooding",
        "flooded": "flooding",
        "flooding": "flooding",

        "landslide": "landslide",
        "land slide": "landslide",

        "cyclone": "cyclone",
        "hurricane": "cyclone",

        "fire": "fire",
        "aag": "fire",

        "earthquake": "earthquake",
        "bhukamp": "earthquake",
    }

    for value in model_values:

        canonical = aliases.get(
            value.lower().strip()
        )

        if canonical:

            # Only accept if the corresponding textual
            # evidence exists.
            if canonical in conditions:

                conditions.add(canonical)

    return sorted(conditions)


# ============================================================
# MEDICAL ISSUE NORMALIZATION
# ============================================================

def _medical_issue(
    text: str,
    model_issue: Optional[str],
) -> Optional[str]:

    lower = text.lower()

    # --------------------------------------------------------
    # SPECIFIC MEDICAL CONDITIONS
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "saans lene mein dikkat",
            "saans lene me dikkat",
            "saans lene mein problem",
            "saans lene me problem",
            "saans ki dikkat",
            "saans nahi aa rahi",
            "saans nahi aa raha",
            "breathing difficulty",
            "difficulty breathing",
            "difficulty in breathing",
            "shortness of breath",
            "can't breathe",
            "cannot breathe",
            "breathing mein problem",
            "breathing mein dikkat",
            "breathing me problem",
            "breathing me dikkat",
            "breathing mein prob",
            "breathing me prob",
            "saans lene mein prob",
            "saans lene me prob",
            "saans lene me prob",
            "saans lene mein prob",
            "saans lene me problem",
            "saans lene mein problem",
            "saans me prob",
            "saans mein prob",
            "breathing me problem",
            "breathing mein problem",
        ],
    ):
        return "breathing difficulty"

    # --------------------------------------------------------
    # BLEEDING
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "bleeding",
            "bleeding ho",
            "khoon aa raha",
            "khoon aa rahi",
            "khoon beh",
        ],
    ):
        return "bleeding"

    # --------------------------------------------------------
    # FEVER
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "fever",
            "bukhar",
        ],
    ):
        return "fever"

    # --------------------------------------------------------
    # INJURY NEGATION
    # --------------------------------------------------------

    injury_negative = _has_any(
        lower,
        [
            "not injured",
            "no injury",
            "not hurt",

            "injured nahi",
            "injured nahin",
            "injured nhi",
            "no one is injured",
            "no one injured",
            "nobody is injured",
            "nobody injured",
            "none injured",
            "no injuries",
            "no one hurt",
            "nobody hurt",
            "we are all safe",
            "we are safe",
            "everyone is safe",
            "everyone is fine",
            "all safe",
            "all fine",
            "no casualties",
            "घायल नहीं",
            "कोई घायल नहीं",
            "चोट नहीं",
            "सब ठीक",
            "हम सब ठीक",
            "सुरक्षित हैं",

            "injury nahi",
            "injury nahin",
            "injury nhi",

            "chot nahi",
            "chot nahin",
            "chot nhi",

            "ghayal nahi",
            "ghayal nahin",
            "ghayal nhi",

            "hurt nahi",
            "hurt nahin",
            "hurt nhi",

            "no one is injured",
            "no one injured",
            "nobody is injured",
            "nobody injured",
        ],
    )

    # --------------------------------------------------------
    # INJURY
    # --------------------------------------------------------

    if not injury_negative:

        if _has_any(
            lower,
            [
                "injured",
                "injury",
                "ghayal",
                "chot lagi",
                "chot aayi",
                "hurt",
                "fracture",
            ],
        ):
            return "injury"

    # --------------------------------------------------------
    # MODEL OUTPUT
    #
    # Only use the model's free-form value if it represents
    # an actual medical condition.
    #
    # Service requests such as "doctor needed" are NOT
    # medical issues.
    # --------------------------------------------------------

    if not model_issue:
        return None

    cleaned = model_issue.strip()

    if cleaned.lower() in {
        "",
        "yes",
        "no",
        "unknown",
        "none",
        "null",
        "n/a",
        "doctor needed",
        "doctor required",
        "medical attention",
        "medicine needed",
        "medicine required",
    }:
        return None

    return cleaned

# ============================================================
# NEED NORMALIZATION
# ============================================================

def _extract_needs(
    text: str,
    facts: CitizenFacts,
    model_needs: list[str],
) -> list[str]:

    lower = text.lower()

    needs = set()

    rescue_negative = _has_any(
    lower,
    [
        "no rescue needed",
        "no rescue required",
        "rescue not needed",
        "rescue ki zarurat nahi",
        "rescue ki koi zarurat nahi",
        "rescue nahi chahiye",
        "rescue ki zarurat nhi",
        "rescue ki zarurat nahin",
    ],
)
    
    # --------------------------------------------------------
    # RESCUE
    # --------------------------------------------------------

    trapped = facts.trapped is True

    explicit_rescue = _has_any(
        lower,
        [
            "rescue chahiye",
            "need rescue",
            "rescue needed",
            "please rescue",
            "rescue us",
            "save us",
            "rescue aur",
            "hume bachao",
            "humein bachao",
            "help us get out",
            "bachao",
            "bacha lo",
        ],
    )

    if not rescue_negative and (trapped or explicit_rescue):
        needs.add("rescue")
    

    # --------------------------------------------------------
    # MEDICAL
    # --------------------------------------------------------

    explicit_medical_request = _has_any(
        lower,
        [
            "doctor chahiye",
            "doctor needed",
            "need a doctor",
            "medical help",
            "medical attention",
            "medical help chahiye",
            "medical attention chahiye",
            "medicine chahiye",
            "medicine needed",
            "dawa chahiye",
            "dawai chahiye",
            "hospital chahiye",
            "hospital needed",
            "dawa ki zarurat",
            "dawai ki zarurat",
            "medicine ki zarurat",
            "medicine ki requirement",
            "medicine required",
        ],
    )

    if (
        facts.injured is True
        or facts.medical_issue is not None
        or explicit_medical_request
    ):
        needs.add("medical")

    # --------------------------------------------------------
    # FOOD
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "food chahiye",
            "need food",
            "khaana",
            "khana" ,
            "food needed",
            "khana chahiye",
            "खाना",
            "भोजन",
            "भूख",
            "राशन",
            "khana nahi",
            "bhookh lagi",
            "khaana chahiye",
            "khane ki zarurat",
            "khana nahi hai",
            "food nahi hai",
            "ration chahiye",
            "khana chahiye",
            "khana chahie",
            "khane chahiye",
            "khaana chahiye",
            "khaane chahiye",

            "hume khana chahiye",
            "hume khaana chahiye",

            "khana do",
            "khana dena",
            "khana chahiye",

            "bhojan chahiye",
            "meal chahiye",

        ],
    ):

        needs.add("food")

    # --------------------------------------------------------
    # DRINKING WATER
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "drinking water",
            "drinking paani",
            "drinking pani",
            "peene ka pani",
            "peene ka paani",
            "paani chahiye",
            "pani chahiye",
            "water chahiye",
            "need water",
            "water needed",
            "paani nahi hai",
            "pani nahi hai",
            "khana pani",
            "khana paani",
            "food and water",
            "food aur water",
            "food aur pani",
            "food aur paani",
            "food, water",
            "food, pani",
            "food, paani",
            "pani dono chahiye",
            "paani dono chahiye",
            "पीने का पानी",
            "पानी चाहिए",
            "प्यास",
            "peene ka pani",
            "peene ka paani",
        ],
    ):

        needs.add("water")


    if _has_any(
        lower,
        [
            "khana pani dono chahiye",
            "khana aur pani chahiye",
            "khana or pani chahiye",
            "food and water needed",
            "food aur water chahiye",
            "food and water chahiye",
        ],
    ):
        needs.add("food")
        needs.add("water")    

    # --------------------------------------------------------
    # SHELTER
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "shelter chahiye",
            "need shelter",
            "shelter needed",
            "ashray chahiye",
            "rehne ki jagah chahiye",
            "rehne ki jagah",
            "place to stay",
            "need a place to stay",
            "आश्रय",
            "रहने की जगह",
            "बेघर",
            "छत नहीं",
        ],
    ):

        needs.add("shelter")

    # --------------------------------------------------------
    # EVACUATION
    # --------------------------------------------------------

    if _has_any(
        lower,
        [
            "evacuate",
            "evacuation",
            "need evacuation",
            "evacuate us",
            "hume evacuate karo",
            "humein evacuate karo",
            "hume yahan se nikalo",
            "humein yahan se nikalo",
            "safe jagah le jao",
            "safe place le jao",
            "need evacuation",
            "we need evacuation",
            "evacuation needed",
            "evacuation required",
            "evacuate us",
            "evacuate please",
            "evacuation chahiye",
            "evacuation ki zarurat hai",
            "bahar nikalo",
            
        ],
    ):

        needs.add("evacuation")

    # --------------------------------------------------------
    # Model needs are candidates only.
    # Accept them ONLY if Python finds supporting evidence.
    # --------------------------------------------------------

    supported = {
        "rescue",
        "medical",
        "food",
        "water",
        "shelter",
        "evacuation",
    }

    for value in model_needs:

        value = value.lower().strip()

        if value not in supported:
            continue

        if value == "rescue" and (
            trapped or explicit_rescue
        ):
            needs.add("rescue")

        elif value == "medical" and (
            facts.injured is True
            or facts.medical_issue is not None
        ):
            needs.add("medical")

        elif value == "food" and "food" in needs:
            needs.add("food")

        elif value == "water" and "water" in needs:
            needs.add("water")

        elif value == "shelter" and "shelter" in needs:
            needs.add("shelter")

        elif value == "evacuation" and "evacuation" in needs:
            needs.add("evacuation")

    # --------------------------------------------------------
    # Explicit "no help" overrides needs
    # --------------------------------------------------------

    no_help = _has_any(
        lower,
        [
            "no help needed",
            "don't need help",
            "do not need help",
            "help ki zarurat nahi",
            "help ki koi zarurat nahi",
            "kisi help ki zarurat nahi",
            "kisi madad ki zarurat nahi",
            "madad nahi chahiye",
        ],
    )

    if no_help:

        needs.clear()

    return [
        need
        for need in [
            "rescue",
            "medical",
            "food",
            "water",
            "shelter",
            "evacuation",
        ]
        if need in needs
    ]


# ============================================================
# NORMALIZATION
# ============================================================

def _normalize(
    text: str,
    raw: RawExtraction,
) -> CitizenFacts:

    facts = CitizenFacts()

    lower = text.lower()

    # --------------------------------------------------------
    # PEOPLE COUNT
    # --------------------------------------------------------

    explicit_people_count = (
        _extract_explicit_people_count(text)
    )

    if explicit_people_count is not None:

        facts.people_count = (
            explicit_people_count
        )

    else:

        facts.people_count = None

    # --------------------------------------------------------
    # TRAPPED
    # --------------------------------------------------------

    trapped_negative = _has_any(
        lower,
        [
            "not trapped",
            "not stuck",
            "not stranded",

            "trapped nahi",
            "trapped nahin",
            "trapped nhi",

            "stuck nahi",
            "stuck nahin",
            "stuck nhi",

            "fase nahi",
            "fase nahin",
            "fase nhi",

            "fasa nahi",
            "fasa nahin",
            "fasa nhi",

            "phasa nahi",
            "phasa nahin",
            "phasa nhi",

            "phasi nahi",
            "phasi nahin",
            "phasi nhi",

            "phans nahi",
            "phans nahin",
            "we are not trapped",
            "not trapped",
            "no one is trapped",
            "nobody is trapped",
            "we can get out",
            "we got out",
            "we are outside",
            "everyone is out",
            "hum phanse nahi",
            "फँसे नहीं",
            "फंसे नहीं",
            "phans nhi",
            "we are not trapped",
            "not trapped",
            "no one is trapped",
            "nobody is trapped",
            "we can get out",
            "we got out",
            "we are outside",
            "everyone is out",
            "फँसे नहीं",
            "फंसे नहीं",
            "नहीं फँस",
            "सब ठीक",
            "बाहर निकल गए",

            "we are safe",
            "hum safe hain",
            "hum safe hai",
            "no rescue needed",
            "rescue not needed",
            "rescue ki zarurat nahi",
            "rescue ki koi zarurat nahi",
            "rescue nahi chahiye",
        ],
    )

    trapped_positive = _has_any(
        lower,
        [
            "trapped",
            "stuck",
            # Hinglish bare forms. "8 log phanse hain" previously scored
            # LOW because only the compound "phanse hue" was listed.
            "phanse",
            "phansa",
            "phans gay",
            "phase",
            "fanse",
            "fansa",
            "dabe hue",
            "dab gaye",
            "malbe",
            "malbe ke niche",
            "bahar nahi nikal pa",
            # Devanagari
            "फँस",   # phans (chandrabindu)
            "फंस",   # phans (anusvara)
            "फँसा",
            "दब गय",   # dab gaye
            "दबे हुए",
            "मलबे",   # malbe / rubble
            "अंदर बंद",  # andar band
            "बाहर नहीं निकल",
            "fase hue",
            "fase hain",
            "fasa hua",
            "fasi hui",
            "fasse hue",
            "phasa hua",
            "phasi hui",
            "phas gaye",
            "phans gaye",
            "phanse hue",
            "bahar nahi nikal",
            "cannot get out",
            "can't get out",
            "cannot leave",
            "can't leave",
        ],
    )

    if trapped_negative:

        facts.trapped = False

    elif trapped_positive:

        facts.trapped = True

    elif raw.trapped is True:

        # Only accept model TRUE if there is supporting evidence.
        facts.trapped = True

    elif raw.trapped is False:

        facts.trapped = False

    else:

        facts.trapped = None

    # --------------------------------------------------------
    # INJURY
    # --------------------------------------------------------

    injury_negative = _has_any(
        lower,
        [
            "not injured",
            "no injury",
            "not hurt",
            "injured nahi",
            "injured nahin",
            "no one is injured",
            "no one injured",
            "nobody is injured",
            "nobody injured",
            "none injured",
            "no injuries",
            "no one hurt",
            "nobody hurt",
            "we are all safe",
            "we are safe",
            "everyone is safe",
            "everyone is fine",
            "all safe",
            "all fine",
            "no casualties",
            "घायल नहीं",
            "कोई घायल नहीं",
            "चोट नहीं",
            "सब ठीक",
            "हम सब ठीक",
            "सुरक्षित हैं",
            "koi ghayal nahi",
            "sab theek",
            "hum sab theek",
            "घायल नहीं",
            "कोई घायल नहीं",
            "चोट नहीं",
            "सब ठीक",
            "हम सब ठीक",
            "सुरक्षित हैं",
            "injury nahi",
            "injury nahin",
            "chot nahi",
            "chot nahin",
            "ghayal nahi",
            "ghayal nahin",
            "hurt nahi",
            "hurt nahin",
        ],
    )

    explicit_injury_count = (
        _extract_explicit_injury_count(text)
    )

    injury_positive = _has_any(
        lower,
        [
            "injured",
            "injury",
            "ghayal",
            "chot lagi",
            "chot aayi",
            "hurt",
            "bleeding",
            "fracture",
            "khoon beh",
            "khoon nikal",
            "behosh",
            "unconscious",
            "lahuluhan",
            # Devanagari
            "घायल",           # ghayal
            "चोट",             # chot
            "खून",             # khoon
            "बेहोश",         # behosh
            "फ्रैक्चर",  # fracture
            "लहूलुहान",  # lahuluhan
        ],
    )

    if injury_negative:

        facts.injured = False
        facts.injury_count = None

    elif explicit_injury_count is not None:

        facts.injured = True
        facts.injury_count = (
            explicit_injury_count
        )

    elif injury_positive:

        facts.injured = True
        facts.injury_count = None

    elif raw.injured is True:

        facts.injured = True

        # NEVER invent an injury count.
        facts.injury_count = None

    elif raw.injured is False:

        facts.injured = False
        facts.injury_count = None

    else:

        facts.injured = None
        facts.injury_count = None

    # --------------------------------------------------------
    # MEDICAL ISSUE
    # --------------------------------------------------------

    facts.medical_issue = _medical_issue(
        text,
        raw.medical_issue,
    )

    # --------------------------------------------------------
    # VULNERABLE PEOPLE
    # --------------------------------------------------------

    facts.vulnerable_people = (
        _canonical_vulnerable_people(
            text,
            raw.vulnerable_people,
        )
    )

    # --------------------------------------------------------
    # ENVIRONMENT
    # --------------------------------------------------------

    facts.environmental_conditions = (
        _canonical_environment(
            text,
            raw.environmental_conditions,
        )
    )

    # --------------------------------------------------------
    # NEEDS
    # --------------------------------------------------------

    facts.needs = _extract_needs(
        text,
        facts,
        raw.needs,
    )

    # --------------------------------------------------------
    # LOCATION
    # --------------------------------------------------------

    facts.location_mentioned = (
        _extract_location(text)
    )

    # --------------------------------------------------------
    # FINAL CONSISTENCY
    # --------------------------------------------------------

    if facts.injured is True:

        if "medical" not in facts.needs:

            facts.needs.append("medical")

    if facts.medical_issue is not None:

        if "medical" not in facts.needs:

            facts.needs.append("medical")

    if facts.trapped is True:

        if "rescue" not in facts.needs:

            facts.needs.append("rescue")

    # Preserve intended ordering.
    facts.needs = [
        need
        for need in [
            "rescue",
            "medical",
            "food",
            "water",
            "shelter",
            "evacuation",
        ]
        if need in facts.needs
    ]

    return facts


# ============================================================
# DETERMINISTIC FALLBACK
# ============================================================

def _fallback_extract_facts(
    text: str,
) -> CitizenFacts:

    raw = RawExtraction()

    return _normalize(
        text,
        raw,
    )


# ============================================================
# PUBLIC API
# ============================================================

def extract_facts(
    text: str,
) -> CitizenFacts:

    if not isinstance(text, str):

        raise TypeError(
            "text must be a string"
        )

    text = text.strip()

    if not text:

        return CitizenFacts()

    if ollama is None:

        return _fallback_extract_facts(text)

    try:

        response = ollama.chat(
            model=MODEL_NAME,
            messages=[
                {
                    "role": "system",
                    "content": SYSTEM_PROMPT,
                },
                {
                    "role": "user",
                    "content": text,
                },
            ],
            format=RawExtraction.model_json_schema(),
            think=False,
            options={
                "temperature": 0,
            },
        )

        content = response.message.content

        if not content or not content.strip():

            return _fallback_extract_facts(
                text
            )

        try:

            raw = RawExtraction.model_validate_json(
                content
            )

        except ValidationError:

            return _fallback_extract_facts(
                text
            )

        return _normalize(
            text,
            raw,
        )

    except Exception:

        # Covers ollama.ResponseError, ConnectionError, TimeoutError,
        # OSError and anything else the client raises — every failure
        # mode falls back to the deterministic extractor.
        return _fallback_extract_facts(
            text
        )