// Package tracking keeps the last-known position of each tracked device.
package tracking

import "time"

// Position is a timestamped GPS fix.
type Position struct {
	Lat  float64
	Lon  float64
	Time time.Time
}

// Tracker stores the most recent position per device id.
type Tracker struct {
	last     map[string]Position
	staleAge time.Duration
}

// NewTracker builds a Tracker that considers a device stale after staleAge.
func NewTracker(staleAge time.Duration) *Tracker {
	return &Tracker{last: make(map[string]Position), staleAge: staleAge}
}

// Update records the latest known position for a device.
func (t *Tracker) Update(deviceID string, pos Position) {
	t.last[deviceID] = pos
}

// LastSeen returns the most recent position for a device, if any.
func (t *Tracker) LastSeen(deviceID string) (Position, bool) {
	p, ok := t.last[deviceID]
	return p, ok
}

// IsStale reports whether a device has not reported within staleAge.
func (t *Tracker) IsStale(deviceID string, now time.Time) bool {
	p, ok := t.last[deviceID]
	if !ok {
		return true
	}
	return now.Sub(p.Time) > t.staleAge
}
