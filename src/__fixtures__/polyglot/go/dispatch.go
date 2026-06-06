package tracking

import "fmt"

// Notifier delivers alerts to a downstream channel (push, SMS, …).
type Notifier interface {
	Notify(deviceID, message string) error
}

// DispatchLostAlert sends a lost-participant alert when a device goes stale.
func DispatchLostAlert(n Notifier, deviceID string, minutesSilent int) error {
	msg := fmt.Sprintf("participant %s lost — no signal for %d min", deviceID, minutesSilent)
	if err := n.Notify(deviceID, msg); err != nil {
		return fmt.Errorf("dispatch lost alert: %w", err)
	}
	return nil
}
