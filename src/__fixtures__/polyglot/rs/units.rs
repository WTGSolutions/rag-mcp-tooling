//! Unit conversions and coordinate parsing for tour telemetry.

/// Distance expressed in a particular unit.
pub enum Distance {
    Meters(f64),
    Kilometers(f64),
    Miles(f64),
}

/// Convert metres to feet.
pub fn meters_to_feet(m: f64) -> f64 {
    m * 3.280_84
}

/// Convert kilometres to miles.
pub fn km_to_miles(km: f64) -> f64 {
    km * 0.621_371
}

/// Parse a "lat,lon" string into a coordinate pair.
pub fn parse_coordinate(s: &str) -> Option<(f64, f64)> {
    let (a, b) = s.split_once(',')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}
