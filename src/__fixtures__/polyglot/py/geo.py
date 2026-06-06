"""Geospatial helpers: distance, bearing, bounding box, midpoint.

A deliberately multi-concept module so a query for one concept must surface
the right region — the case where AST chunking beats blind line windows.
"""
import math

EARTH_RADIUS_M = 6_371_000.0


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lon points, in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial compass bearing (degrees, 0=N) from point 1 to point 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def bounding_box(lat: float, lon: float, radius_m: float) -> tuple[float, float, float, float]:
    """Approximate (min_lat, min_lon, max_lat, max_lon) square around a point."""
    dlat = math.degrees(radius_m / EARTH_RADIUS_M)
    dlon = dlat / max(math.cos(math.radians(lat)), 1e-6)
    return (lat - dlat, lon - dlon, lat + dlat, lon + dlon)


def midpoint(lat1: float, lon1: float, lat2: float, lon2: float) -> tuple[float, float]:
    """Geographic midpoint between two coordinates."""
    return ((lat1 + lat2) / 2, (lon1 + lon2) / 2)
