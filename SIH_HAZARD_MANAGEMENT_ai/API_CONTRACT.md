# Citizen Intelligence API Contract

## 1. Overview

The Citizen Intelligence API converts an unstructured citizen emergency message into structured disaster-response information.

The API is responsible for:

- Understanding citizen messages
- Handling Hindi, English and Hinglish input
- Extracting explicitly stated facts
- Detecting emergency needs
- Detecting trapped/injured status
- Detecting vulnerable people
- Detecting environmental conditions
- Extracting explicitly mentioned geographic locations
- Producing severity-related features
- Producing a deterministic priority/triage assessment
- Returning confidence indicators

The API does NOT:

- Make final dispatch decisions
- Select a specific rescue team for dispatch
- Select a specific resource for dispatch
- Perform resource optimization
- Dispatch resources
- Decide the final rescue route
- Replace official disaster alerts
- Override government/authority decisions
- Make final operational decisions on behalf of authorities
- Diagnose medical conditions
- Invent missing information

The priority assessment returned by the API is an advisory triage signal for downstream systems. Final operational decisions remain with the backend, authority dashboard, and resource-allocation system.

---

# 2. Endpoint

## Analyze Citizen Message

POST /analyze

Local development URL:

http://127.0.0.1:8000/analyze

Interactive API documentation:

http://127.0.0.1:8000/docs

---

# 3. Request Format

The API accepts an `AnalyzeRequest`.

Example:

```json
{
  "request_id": "REQ-001",
  "text": "Ghar mein paani bhar gaya hai, papa injured hain aur hum 5 log hain.",
  "language": "hinglish",
  "latitude": 20.2961,
  "longitude": 85.8245,
  "timestamp": "2026-08-26T14:30:00",
  "source": "citizen_app"
}
```

---

# 4. Request Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `request_id` | string | Yes | Unique identifier for the citizen request |
| `text` | string | Yes | Raw citizen message |
| `language` | string or null | No | Language of the message, e.g. `hindi`, `english`, `hinglish` |
| `latitude` | float or null | No | Citizen's geographic latitude |
| `longitude` | float or null | No | Citizen's geographic longitude |
| `timestamp` | string or null | No | Time at which the request was created |
| `source` | string | Yes | Source of the request, e.g. `citizen_app`, `sms`, `ivr` |

---

# 5. Important Location Rule

The `latitude` and `longitude` fields represent the citizen's actual geographic coordinates supplied by the application/backend.

The AI does NOT replace these coordinates.

The AI only extracts a textual location when the citizen explicitly mentions one in their message.

For example:

"Cuttack ke Sector 5 mein 10 log fase hue hain."

May produce:

```json
{
  "location_mentioned": "Cuttack ke Sector 5"
}
```

But:

"Ghar mein paani bhar gaya hai."

must produce:

```json
{
  "location_mentioned": null
}
```

Words such as:

- ghar
- mummy
- papa
- dadi
- chhat
- uncle

must NOT be treated as geographic locations.

---

# 6. Response Format

The API returns an `AnalyzeResponse`.

Example:

```json
{
  "request_id": "REQ-001",
  "language": "hinglish",
  "facts": {
    "needs": [
      "medical",
      "water"
    ],
    "people_count": 5,
    "trapped": null,
    "injured": true,
    "injury_count": 1,
    "medical_issue": null,
    "vulnerable_people": [],
    "environmental_conditions": [
      "water_entered_house"
    ],
    "location_mentioned": null
  },
  "severity_features": {
    "immediate_rescue": false,
    "medical_attention": true,
    "multiple_people": true,
    "vulnerable_person": false
  },
  "priority": {
    "score": 50,
    "level": "HIGH",
    "reasons": [
      "Medical attention is required",
      "Multiple people are affected",
      "Environmental hazard is reported"
    ]
  },
  "confidence": {
    "needs": 1.0,
    "people_count": 1.0,
    "trapped": 0.0,
    "injured": 1.0
  }
}
```

---

# 7. Facts

The `facts` object contains information extracted from the citizen's message.

## 7.1 Needs

Allowed values:

- `rescue`
- `medical`
- `food`
- `water`
- `shelter`
- `evacuation`

Example:

```json
{
  "needs": ["rescue"]
}
```

Another example:

```json
{
  "needs": ["medical", "water"]
}
```

Multiple needs may be returned when multiple needs are explicitly stated or directly supported by the message.

Example:

"Hume rescue aur medical help chahiye."

May produce:

```json
{
  "needs": [
    "rescue",
    "medical"
  ]
}
```

If no need is detected:

```json
{
  "needs": []
}
```

The AI should not invent a need that is not explicitly stated or directly supported by the citizen's message.

Generic requests such as "help" or "please help" must not automatically be converted into a specific need.

---

# 8. People Count

Field:

```json
{
  "people_count": 5
}
```

The value represents the number of people explicitly stated in the citizen's message.

Examples:

"Hum 5 log hain."

```json
{
  "people_count": 5
}
```

Another example:

"Need food for 20 people."

```json
{
  "people_count": 20
}
```

If no number is available:

```json
{
  "people_count": null
}
```

The system must not invent a people count.

---

# 9. Trapped Status

Field:

```json
{
  "trapped": true
}
```

The following types of expressions indicate that the citizen is trapped:

- fase hue
- fasse hue
- fase hain
- trapped
- stuck
- can't get out
- cannot get out
- unable to get out

Example:

"Hum chhat pe fase hue hain."

May produce:

```json
{
  "trapped": true
}
```

If the message explicitly establishes that the person is not trapped, the system may return:

```json
{
  "trapped": false
}
```

If the message does not establish trapped status:

```json
{
  "trapped": null
}
```

The AI should not assume that a person is trapped merely because a disaster is occurring.

---

# 10. Injury Information

Fields:

```json
{
  "injured": true,
  "injury_count": 1
}
```

If someone is explicitly described as injured:

"Ek aadmi injured hai."

The system may produce:

```json
{
  "injured": true,
  "injury_count": 1
}
```

If an injury is explicitly reported but the number of injured people is unknown:

```json
{
  "injured": true,
  "injury_count": null
}
```

If the message explicitly establishes that nobody is injured:

```json
{
  "injured": false,
  "injury_count": null
}
```

If injury status is not established:

```json
{
  "injured": null,
  "injury_count": null
}
```

The system must not invent an injury count.

---

# 11. Medical Information

Field:

```json
{
  "medical_issue": "breathing difficulty"
}
```

Medical needs may be detected from expressions such as:

- saans lene mein dikkat
- saans lene me dikkat
- breathing difficulty
- difficulty breathing
- breathing problem
- shortness of breath
- can't breathe
- dawa chahiye
- medicine needed
- doctor chahiye
- doctor needed
- hospital chahiye
- medical attention
- serious illness

Example:

"Mummy ko dawa chahiye, unki tabiyat bahut kharab hai."

May produce:

```json
{
  "needs": [
    "medical"
  ],
  "medical_issue": "medicine needed"
}
```

Example:

"Uncle ko saans lene mein dikkat ho rahi hai."

May produce:

```json
{
  "needs": [
    "medical"
  ],
  "medical_issue": "breathing difficulty"
}
```

The system must not diagnose a medical condition.

---

# 12. Vulnerable People

Allowed values:

- `elderly`
- `child`
- `infant`
- `disabled`
- `mobility_impaired`
- `pregnant`

Examples:

"Teen bachche school mein fase hue hain."

May produce:

```json
{
  "vulnerable_people": [
    "child"
  ]
}
```

Example:

"Dadi chal nahi sakti."

May produce:

```json
{
  "vulnerable_people": [
    "elderly",
    "mobility_impaired"
  ]
}
```

The system should only include vulnerability categories supported by the citizen's message.

Family terms such as "dadi", "grandmother", "grandpa", etc. may support an `elderly` classification when the context establishes the person is elderly.

Vulnerability must not be inferred without sufficient textual evidence.

---

# 13. Environmental Conditions

Allowed values:

- `flooding`
- `waterlogging`
- `water_entered_house`
- `road_blocked`
- `landslide`
- `cyclone`
- `fire`
- `earthquake`

Examples:

"Ghar mein paani bhar gaya hai."

May produce:

```json
{
  "environmental_conditions": [
    "water_entered_house"
  ]
}
```

Example:

"Road is blocked."

May produce:

```json
{
  "environmental_conditions": [
    "road_blocked"
  ]
}
```

Example:

"Road par bahut pani jama hai."

May produce:

```json
{
  "environmental_conditions": [
    "waterlogging"
  ]
}
```

The system should not infer a disaster type unless supported by the citizen's message.

---

# 14. Textual Location

Field:

```json
{
  "location_mentioned": "Cuttack ke Sector 5"
}
```

This field is only for geographic locations explicitly mentioned in the citizen's message.

Examples of valid geographic information:

- Bhubaneswar
- Cuttack
- Patia
- Sector 5
- Railway Station
- Village X
- Street names
- Addresses

If no geographic location is explicitly mentioned:

```json
{
  "location_mentioned": null
}
```

Generic words such as:

- ghar
- home
- chhat
- mummy
- papa
- dadi
- uncle

must not be treated as geographic locations.

---

# 15. Severity Features

The `severity_features` object provides deterministic features that downstream modules can use for triage and resource allocation.

These features are NOT themselves final operational decisions.

## 15.1 immediate_rescue

```json
{
  "immediate_rescue": true
}
```

This is true when:

- `rescue` is detected as a need, OR
- the citizen is explicitly trapped.

Example:

"Hum chhat pe fase hue hain."

Produces:

```json
{
  "immediate_rescue": true
}
```

---

## 15.2 medical_attention

```json
{
  "medical_attention": true
}
```

This is true when:

- `medical` is detected as a need, OR
- someone is injured.

Example:

"Papa injured hain."

Produces:

```json
{
  "medical_attention": true
}
```

---

## 15.3 multiple_people

```json
{
  "multiple_people": true
}
```

This is true when:

people_count > 1

If the number of people is unknown:

```json
{
  "multiple_people": false
}
```

The system must not infer multiple people merely because words such as "family" or "we" appear unless the extraction logic establishes a count or otherwise explicitly supports multiple affected people.

---

## 15.4 vulnerable_person

```json
{
  "vulnerable_person": true
}
```

This is true when `vulnerable_people` contains at least one vulnerability category.

Example:

```json
{
  "vulnerable_people": [
    "elderly"
  ]
}
```

produces:

```json
{
  "vulnerable_person": true
}
```

---

# 16. Priority / Triage Assessment

The API returns a deterministic priority assessment based on extracted facts and severity features.

Example:

```json
{
  "priority": {
    "score": 100,
    "level": "CRITICAL",
    "reasons": [
      "Citizen is trapped",
      "Medical attention is required",
      "Vulnerable person is present",
      "Multiple people are affected",
      "Environmental hazard is reported"
    ]
  }
}
```

Allowed levels:

- `LOW`
- `MEDIUM`
- `HIGH`
- `CRITICAL`

The priority assessment is an advisory triage signal.

It does NOT mean that the AI has made the final operational decision.

The downstream authority/backend system remains responsible for:

- deciding whether to dispatch resources
- selecting the appropriate team
- selecting the appropriate resource
- determining the rescue route
- making final operational decisions

Priority should be treated as one decision-support input alongside:

- official alerts
- resource availability
- resource capability
- resource location
- distance
- ETA
- capacity
- current resource status
- incident status
- other operational information

---

# 17. Confidence

The `confidence` object provides confidence indicators for selected extracted fields.

Current fields:

- `needs`
- `people_count`
- `trapped`
- `injured`

Example:

```json
{
  "confidence": {
    "needs": 1.0,
    "people_count": 1.0,
    "trapped": 0.0,
    "injured": 1.0
  }
}
```

The current implementation uses these values primarily to indicate whether a corresponding fact was successfully detected.

These values should NOT be interpreted as scientifically calibrated probabilities unless the confidence calculation is later calibrated and validated.

A confidence value of `0.0` currently means that the corresponding field was not established by the extraction pipeline.

A confidence value of `1.0` currently means that the corresponding field was successfully established by the extraction pipeline.

---

# 18. Null vs False

Downstream modules must distinguish between:

```json
null
```

and:

```json
false
```

`null` means the information was not established from the citizen's message.

`false` means the system has established that the condition is false.

For example:

```json
{
  "trapped": null
}
```

means:

> The citizen did not provide enough information to establish whether they are trapped.

Whereas:

```json
{
  "trapped": false
}
```

means:

> The message explicitly indicates that the citizen is not trapped.

Downstream systems should NOT automatically convert all `null` values to `false`.

The same principle applies to other nullable factual fields.

---

# 19. AI Responsibilities

The AI module is responsible for:

1. Understanding citizen text.
2. Handling Hindi, English and Hinglish input.
3. Extracting structured facts.
4. Identifying explicitly stated needs.
5. Identifying people counts.
6. Identifying trapped status.
7. Identifying injuries.
8. Identifying medical issues.
9. Identifying vulnerable people.
10. Identifying environmental conditions.
11. Extracting explicitly mentioned textual locations.
12. Producing severity-related features.
13. Producing a deterministic priority/triage assessment.
14. Producing confidence indicators.

---

# 20. AI Non-Responsibilities

The AI module must NOT:

1. Make final dispatch decisions.
2. Select a specific resource for dispatch.
3. Dispatch a resource.
4. Decide the final rescue route.
5. Perform resource optimization.
6. Replace official disaster warnings.
7. Override government/authority decisions.
8. Invent missing information.
9. Diagnose medical conditions.
10. Treat generic words as locations.
11. Treat generic "help" requests as a specific emergency need.
12. Make final operational decisions on behalf of authorities.

---

# 21. Resource Optimization Integration

The output of this API can be consumed by the resource optimization module.

Example:

Citizen Message
       |
       v
POST /analyze
       |
       v
CitizenFacts
       |
       v
Severity Features
       |
       v
Priority / Triage Assessment
       |
       v
Resource Optimization
       |
       v
Recommended Resource

The AI does NOT directly select the resource.

The resource optimization module should use the structured information returned by this API along with:

- resource availability
- resource capability
- resource location
- distance
- ETA
- capacity
- current status
- emergency priority
- official disaster information
- other operational constraints

The final resource recommendation remains a downstream system decision.

---

# 22. Geographic Integration

The API receives:

- latitude
- longitude

from the upstream application/backend.

These coordinates should be used by the mapping and geographic intelligence module.

The `location_mentioned` field is supplementary textual information only.

Example:

```json
{
  "latitude": 20.2961,
  "longitude": 85.8245,
  "facts": {
    "location_mentioned": "Cuttack Sector 5"
  }
}
```

The geographic module can combine both sources.

The AI must not replace application-provided coordinates with a textual location extracted from the message.

---

# 23. Source Integration

The API may receive requests from multiple sources:

- `citizen_app`
- `sms`
- `ivr`

The `source` field identifies where the message originated.

Example:

```json
{
  "source": "sms"
}
```

or:

```json
{
  "source": "citizen_app"
}
```

The AI extraction logic should remain independent of the source.

---

# 24. Official Disaster Information

Official disaster information from government sources such as IMD and SACHET is handled separately from citizen-message extraction.

Official alerts may provide:

- disaster type
- warning level
- affected area
- forecast information
- official alert information

Citizen Intelligence uses this official information as external context in the larger system.

The AI citizen-message extractor must not fabricate official alerts.

Official information may be combined with citizen reports by downstream systems for broader incident intelligence and decision support.

---

# 25. Example End-to-End Request

## Input

```json
{
  "request_id": "REQ-1042",
  "text": "Hum 6 log chhat pe fase hue hain, dadi chal nahi sakti aur uncle ko saans lene mein dikkat ho rahi hai.",
  "language": "hinglish",
  "latitude": 20.2961,
  "longitude": 85.8245,
  "timestamp": "2026-08-26T14:30:00",
  "source": "citizen_app"
}
```

## Expected structured information

```json
{
  "facts": {
    "needs": [
      "rescue",
      "medical"
    ],
    "people_count": 6,
    "trapped": true,
    "injured": null,
    "injury_count": null,
    "medical_issue": "breathing difficulty",
    "vulnerable_people": [
      "elderly",
      "mobility_impaired"
    ],
    "environmental_conditions": [],
    "location_mentioned": null
  },
  "severity_features": {
    "immediate_rescue": true,
    "medical_attention": true,
    "multiple_people": true,
    "vulnerable_person": true
  }
}
```

The exact ordering of arrays is not guaranteed.

The example demonstrates the type of structured information expected from the extraction pipeline. Priority and confidence are calculated separately by the API implementation.

---

# 26. Integration Principle

Other team members should integrate with the AI module through the API contract rather than directly depending on the internal Python implementation.

They should call:

POST /analyze

and consume the returned JSON.

They should NOT depend directly on:

- Qwen
- Ollama
- system prompts
- `analyzer.py` internals
- deterministic extraction functions

This allows the AI implementation to be changed later without breaking the rest of the system, provided the API contract remains compatible.

The API response schema should be treated as the integration boundary between the AI service and the rest of the platform.

---

# 27. Current Development Environment

During development, the API runs locally at:

http://127.0.0.1:8000

Swagger/OpenAPI documentation is available at:

http://127.0.0.1:8000/docs

The current AI inference engine is:

Ollama

with:

qwen3:1.7b

The AI service is implemented using:

- Python
- FastAPI
- Pydantic
- Ollama

---

# 28. Future Deployment

The local development endpoint:

http://127.0.0.1:8000

is only for development.

For final integration, the AI service may be deployed on a shared server or other accessible environment.

The API contract should remain stable during deployment so that the other system modules do not require unnecessary changes.

The deployed service must expose an endpoint equivalent to:

POST /analyze

and preserve the request and response structure defined in this document.

---

# 29. Resource Allocation Module (Advisory)

Section 21 described resource optimization as a downstream consumer of this API. That module now exists in this service as a separate, non-LLM component (`app/resource_allocator.py`), following the same deterministic/explainable philosophy as `priority.py`.

It does NOT dispatch resources. It recommends which resources should relocate to which unresolved incident clusters. The backend/authority dashboard remains responsible for applying (or overriding) the recommendation via `PATCH /incidents/{id}` and `PATCH /resources/{id}`.

## 29.1 Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/resources` | Register a resource (ambulance, NDRF team, food supply, etc.) |
| GET | `/resources` | List all resources |
| GET | `/resources/{resource_id}` | Get one resource |
| PATCH | `/resources/{resource_id}` | Update availability, status, or location |
| GET | `/allocate` | Get the current allocation recommendation |

## 29.2 Resource Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Resource name |
| `type` | string | One of: `ambulance`, `medical_team`, `fire_brigade`, `ndrf_team`, `boat`, `food_supply`, `water_tanker`, `shelter_unit`, `generic` |
| `latitude` / `longitude` | float | Resource's current location |
| `total_units` | int | Total deployable units (e.g. 5 ambulances) |
| `available_units` | int | Units currently free to dispatch |
| `capacity_per_unit` | int | People one unit can serve/carry (default 10) |
| `status` | string | `ACTIVE` or `INACTIVE` |

## 29.3 Allocation Algorithm

For each unresolved incident cluster (grouped the same way as `/incidents/aggregation`), an **urgency score** (0-100) is computed from:

- people affected
- injured count
- trapped count
- aggregate demand (needs x people)
- time elapsed since the first report — longer elapsed time increases severity
- the existing deterministic priority score

Clusters are processed from highest urgency to lowest. For each cluster, candidate resources (filtered to types compatible with the cluster's stated needs, e.g. `medical` -> `ambulance`/`medical_team`) are ranked by a **suitability score** combining:

- distance to the cluster (via Google Maps Distance Matrix when `GOOGLE_MAPS_API_KEY` is set, otherwise a haversine-based estimate)
- ETA to the cluster
- an availability-based reservation factor: resources with low availability are increasingly reserved for high-urgency clusters, while abundant resources are usable everywhere

Units are then greedily allocated until the cluster's people are covered or resources run out, and processing moves to the next cluster with whatever capacity remains.

The urgency weights are trained (not hand-set) via `python scripts/train_urgency_model.py`, which:

1. Generates realistic scenario variations (rooftop entrapment during flooding, structural collapse, acute medical emergencies, mass evacuation, multi-day stranded villages, etc. -- see `app/training/scenarios.py`), running each through the same production `severity.py`/`priority.py` pipeline the live API uses.
2. Labels each scenario with a rule-based "expert" urgency score (`app/training/ground_truth.py`) grounded in disaster-response triage doctrine (START mass-casualty triage, the trauma "golden hour," search-and-rescue entrapment-window practice).
3. Trains `LinearUrgencyModel` on an 80/20 train/test split via gradient descent, and saves the learned weights to `app/urgency_weights.json`, which `resource_allocator.py` loads automatically.

Because no logged history of real incident-to-resource-outcome data exists for this project yet, step 2's labels are synthetic and expert-reasoned, not historical fact. The training pipeline is built so that once real outcome data is logged, it becomes a drop-in replacement for the synthetic dataset -- the training loop and weight-loading do not need to change.

## 29.4 Example: GET /allocate response

```json
{
  "generated_at": "2026-08-31T11:58:12Z",
  "clusters": [
    {
      "cluster_id": "DC-001",
      "people_affected": 6,
      "urgency_score": 53.83,
      "priority": "CRITICAL",
      "units_allocated": 2,
      "coverage_ratio": 1.0,
      "fully_served": true,
      "decisions": [
        {
          "cluster_id": "DC-001",
          "resource_id": "RES-001",
          "resource_name": "Ambulance 1",
          "resource_type": "ambulance",
          "units_allocated": 2,
          "distance_km": 1.98,
          "eta_minutes": 4.0,
          "urgency_score": 53.83,
          "suitability_score": 0.7529,
          "allocation_score": 0.7529,
          "reasons": [
            "1.98 km away, ETA 4.0 min (haversine_estimate)"
          ]
        }
      ]
    }
  ],
  "unserved_clusters": []
}
```

---

# 30. Version

Current API contract version:

1.2

Version 1.2 adds the advisory Resource Allocation Module (`/resources`, `/allocate`) described in Section 29. Version 1.1 clarified that the API provides a deterministic priority/triage assessment while final dispatch, resource selection, resource optimization, and other operational decisions remain outside the AI module.

Any breaking change to the request or response structure should be communicated to all team members before integration.