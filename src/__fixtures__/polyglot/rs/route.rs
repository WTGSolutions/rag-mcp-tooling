//! Tour route as an ordered list of waypoints, with cumulative distance.

const EARTH_RADIUS_M: f64 = 6_371_000.0;

/// A single point along a route.
pub struct Waypoint {
    pub lat: f64,
    pub lon: f64,
}

/// An ordered sequence of waypoints forming a tour route.
pub struct Route {
    points: Vec<Waypoint>,
}

impl Route {
    pub fn new() -> Self {
        Route { points: Vec::new() }
    }

    /// Append a waypoint to the end of the route.
    pub fn append_point(&mut self, lat: f64, lon: f64) {
        self.points.push(Waypoint { lat, lon });
    }

    /// Sum the great-circle distance along all waypoints, in metres.
    pub fn total_distance(&self) -> f64 {
        self.points
            .windows(2)
            .map(|w| haversine(&w[0], &w[1]))
            .sum()
    }
}

fn haversine(a: &Waypoint, b: &Waypoint) -> f64 {
    let (p1, p2) = (a.lat.to_radians(), b.lat.to_radians());
    let dphi = (b.lat - a.lat).to_radians();
    let dlmb = (b.lon - a.lon).to_radians();
    let h = (dphi / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dlmb / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}
