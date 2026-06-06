package com.guidetrackee.tracking;

import java.util.Objects;

/** A circular geofence around a tour meeting point. */
public class Geofence implements Region {

    private final double lat;
    private final double lon;
    private final double radiusMeters;

    public Geofence(double lat, double lon, double radiusMeters) {
        this.lat = lat;
        this.lon = lon;
        this.radiusMeters = radiusMeters;
    }

    /** True when the given GPS point lies inside the geofence. */
    @Override
    public boolean contains(double pLat, double pLon) {
        return haversine(lat, lon, pLat, pLon) <= radiusMeters;
    }

    private static double haversine(double aLat, double aLon, double bLat, double bLon) {
        double dLat = Math.toRadians(bLat - aLat);
        double dLon = Math.toRadians(bLon - aLon);
        double h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(aLat)) * Math.cos(Math.toRadians(bLat))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 6_371_000.0 * 2 * Math.asin(Math.sqrt(h));
    }

    @Override
    public String toString() {
        return "Geofence(" + lat + "," + lon + ")";
    }
}

/** A region membership test. */
interface Region {
    boolean contains(double lat, double lon);
}

/** Coarse alert severity. */
enum Severity {
    INFO,
    WARNING,
    CRITICAL
}
