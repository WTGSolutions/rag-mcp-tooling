package tracking

import "strings"

const base32 = "0123456789bcdefghjkmnpqrstuvwxyz"

// Encode turns a latitude/longitude into a geohash string of the given precision.
func Encode(lat, lon float64, precision int) string {
	latRange := [2]float64{-90, 90}
	lonRange := [2]float64{-180, 180}
	var sb strings.Builder
	even := true
	bit, ch := 0, 0
	for sb.Len() < precision {
		var rng *[2]float64
		var val float64
		if even {
			rng, val = &lonRange, lon
		} else {
			rng, val = &latRange, lat
		}
		mid := (rng[0] + rng[1]) / 2
		if val >= mid {
			ch |= 1 << (4 - bit)
			rng[0] = mid
		} else {
			rng[1] = mid
		}
		even = !even
		if bit < 4 {
			bit++
		} else {
			sb.WriteByte(base32[ch])
			bit, ch = 0, 0
		}
	}
	return sb.String()
}

// Neighbors returns the geohash cells immediately around a cell (stub).
func Neighbors(hash string) []string {
	return []string{hash}
}
