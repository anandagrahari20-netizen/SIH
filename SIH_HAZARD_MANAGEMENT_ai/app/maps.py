from __future__ import annotations

import os
import time
from math import atan2, cos, radians, sin, sqrt
from typing import Optional

import requests

from app.schemas import DistanceInfo


# ============================================================
# CONFIGURATION
# ============================================================

GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY")

DISTANCE_MATRIX_URL = (
    "https://maps.googleapis.com/maps/api/distancematrix/json"
)

# Used only for the haversine fallback when no API key is
# configured, or when the API call fails.
AVERAGE_ROAD_SPEED_KMH = 30.0

# Straight-line distance underestimates real road distance.
ROAD_DISTANCE_FACTOR = 1.3

REQUEST_TIMEOUT_SECONDS = 5
CACHE_TTL_SECONDS = 300

_cache: dict[tuple[float, float, float, float], tuple[float, DistanceInfo]] = {}


# ============================================================
# HAVERSINE FALLBACK
# ============================================================

def _haversine_km(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
) -> float:

    earth_radius_km = 6371.0

    lat1_rad = radians(lat1)
    lat2_rad = radians(lat2)

    delta_lat = radians(lat2 - lat1)
    delta_lon = radians(lon2 - lon1)

    a = (
        sin(delta_lat / 2) ** 2
        + cos(lat1_rad)
        * cos(lat2_rad)
        * sin(delta_lon / 2) ** 2
    )

    c = 2 * atan2(sqrt(a), sqrt(1 - a))

    return earth_radius_km * c


def _fallback_estimate(
    origin_lat: float,
    origin_lon: float,
    dest_lat: float,
    dest_lon: float,
) -> DistanceInfo:

    straight_line_km = _haversine_km(
        origin_lat, origin_lon, dest_lat, dest_lon
    )

    road_distance_km = straight_line_km * ROAD_DISTANCE_FACTOR
    eta_minutes = (road_distance_km / AVERAGE_ROAD_SPEED_KMH) * 60.0

    return DistanceInfo(
        distance_km=round(road_distance_km, 2),
        eta_minutes=round(eta_minutes, 1),
        source="haversine_estimate",
    )


# ============================================================
# GOOGLE MAPS DISTANCE MATRIX
# ============================================================

def _query_google_maps(
    origin_lat: float,
    origin_lon: float,
    dest_lat: float,
    dest_lon: float,
) -> DistanceInfo:

    response = requests.get(
        DISTANCE_MATRIX_URL,
        params={
            "origins": f"{origin_lat},{origin_lon}",
            "destinations": f"{dest_lat},{dest_lon}",
            "mode": "driving",
            "key": GOOGLE_MAPS_API_KEY,
        },
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    data = response.json()

    if data.get("status") != "OK":
        raise ValueError(f"Distance Matrix error: {data.get('status')}")

    element = data["rows"][0]["elements"][0]

    if element.get("status") != "OK":
        raise ValueError(f"No route found: {element.get('status')}")

    distance_km = element["distance"]["value"] / 1000.0
    eta_minutes = element["duration"]["value"] / 60.0

    return DistanceInfo(
        distance_km=round(distance_km, 2),
        eta_minutes=round(eta_minutes, 1),
        source="google_maps",
    )


# ============================================================
# PUBLIC API
# ============================================================

def get_distance_eta(
    origin_lat: float,
    origin_lon: float,
    dest_lat: float,
    dest_lon: float,
) -> DistanceInfo:
    """
    Distance and ETA between a resource and an incident/cluster.

    Uses the Google Maps Distance Matrix API when
    GOOGLE_MAPS_API_KEY is configured. Falls back to a haversine-
    based estimate when no key is set, or if the API call fails
    for any reason, so the allocator never crashes on a network
    or quota issue.
    """

    cache_key = (
        round(origin_lat, 4),
        round(origin_lon, 4),
        round(dest_lat, 4),
        round(dest_lon, 4),
    )

    cached = _cache.get(cache_key)

    if cached and (time.time() - cached[0]) < CACHE_TTL_SECONDS:
        return cached[1]

    if not GOOGLE_MAPS_API_KEY:
        result = _fallback_estimate(
            origin_lat, origin_lon, dest_lat, dest_lon
        )
    else:
        try:
            result = _query_google_maps(
                origin_lat, origin_lon, dest_lat, dest_lon
            )
        except (
            requests.RequestException,
            ValueError,
            KeyError,
            IndexError,
        ):
            result = _fallback_estimate(
                origin_lat, origin_lon, dest_lat, dest_lon
            )

    _cache[cache_key] = (time.time(), result)

    return result
