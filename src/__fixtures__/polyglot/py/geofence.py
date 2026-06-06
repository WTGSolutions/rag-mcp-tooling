"""Circular geofence membership test for tour participants."""
from .geo import haversine


class Geofence:
    """A circular geofence defined by a centre point and radius in metres."""

    def __init__(self, lat: float, lon: float, radius_m: float) -> None:
        self.lat = lat
        self.lon = lon
        self.radius_m = radius_m

    def contains(self, lat: float, lon: float) -> bool:
        """True when the given GPS point lies inside the geofence."""
        return haversine(self.lat, self.lon, lat, lon) <= self.radius_m

    def distance_to_edge(self, lat: float, lon: float) -> float:
        """Signed distance to the fence edge (negative = inside)."""
        return haversine(self.lat, self.lon, lat, lon) - self.radius_m
