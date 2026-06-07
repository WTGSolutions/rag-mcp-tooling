"""Telemetry ingestion pipeline fixture (TASK-030, Phase 6b A/B corpus).

A single deliberately oversized function. Its HEAD is dense input validation and
normalization code. Its TAIL is a second, unrelated routine that lives well beyond
the first 512 tokens, so a head-only (truncated) embedding cannot represent it —
the tail is retrievable only when oversized-symbol windowing splits the symbol.
The tail concept is named only inside the tail itself, never in this header or the
function docstring, so the A/B isolates windowing rather than docstring leakage.
"""

from typing import Any


def normalize_sensor_batch(raw_records: list[dict[str, Any]], boundary) -> dict[str, Any]:
    """Validate, normalize and deduplicate a batch of sensor readings.

    The head checks and normalizes each incoming record; a second, unrelated
    computation then summarizes the batch before the result summary is returned.
    """
    # ===== SECTION 1 (HEAD): validation & normalization =========================
    # Reject malformed envelopes early. Every record must carry a device id, a
    # monotonic sequence number and a UTC timestamp in milliseconds since epoch.
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, int]] = set()

    for index, record in enumerate(raw_records):
        if not isinstance(record, dict):
            rejected.append({"index": index, "reason": "record-not-an-object"})
            continue

        device_id = record.get("device_id")
        if not isinstance(device_id, str) or device_id.strip() == "":
            rejected.append({"index": index, "reason": "missing-device-id"})
            continue
        device_id = device_id.strip().lower()

        sequence = record.get("sequence")
        if not isinstance(sequence, int) or sequence < 0:
            rejected.append({"index": index, "reason": "invalid-sequence"})
            continue

        timestamp_ms = record.get("timestamp_ms")
        if not isinstance(timestamp_ms, int) or timestamp_ms <= 0:
            rejected.append({"index": index, "reason": "invalid-timestamp"})
            continue

        # Deduplicate on the (device, sequence) natural key. A repeated key means
        # the same reading appeared twice; keep the first occurrence, drop the rest.
        natural_key = (device_id, sequence)
        if natural_key in seen_keys:
            rejected.append({"index": index, "reason": "duplicate-key"})
            continue
        seen_keys.add(natural_key)

        # Normalize the measurement payload. Coerce numeric strings, clamp values
        # to the physically plausible range, and fill missing optionals with None
        # so the downstream schema is uniform regardless of firmware version.
        readings = record.get("readings")
        if not isinstance(readings, dict):
            rejected.append({"index": index, "reason": "readings-not-an-object"})
            continue

        normalized_readings: dict[str, Any] = {}
        invalid_field = None
        for field_name, value in readings.items():
            if isinstance(value, bool):
                invalid_field = field_name
                break
            if isinstance(value, str):
                try:
                    value = float(value)
                except ValueError:
                    invalid_field = field_name
                    break
            if not isinstance(value, (int, float)):
                invalid_field = field_name
                break
            # Clamp temperature-like channels into a sane Celsius band; clamp the
            # rest into a generic non-negative range. Out-of-band is not an error,
            # firmware glitches are common — we record the clamp instead.
            if field_name.startswith("temp"):
                value = max(-90.0, min(60.0, float(value)))
            else:
                value = max(0.0, float(value))
            normalized_readings[field_name] = round(value, 4)

        if invalid_field is not None:
            rejected.append({"index": index, "reason": f"invalid-field:{invalid_field}"})
            continue

        # Carry a normalized envelope forward. Optional metadata is defaulted so
        # the consumer always sees the same shape (uniform schema contract).
        accepted.append({
            "device_id": device_id,
            "sequence": sequence,
            "timestamp_ms": timestamp_ms,
            "readings": normalized_readings,
            "site": (record.get("site") or "unknown").strip().lower(),
            "firmware": record.get("firmware") or "0.0.0",
        })

    # ===== SECTION 2 (TAIL): polygon area via the shoelace formula ==============
    # The batch carries the monitored region as a closed ring of (x, y) vertices.
    # Compute its enclosed area with the shoelace (surveyor's) formula: twice the
    # signed area is the running sum over edges of (x_i * y_next - x_next * y_i);
    # the absolute half of that sum is the polygon area for either winding order.
    vertices = boundary
    region_area = 0.0
    if len(vertices) >= 3:
        cross_sum = 0.0
        vertex_count = len(vertices)
        for i in range(vertex_count):
            x_i, y_i = vertices[i]
            # Wrap the last vertex back to the first so the ring is closed; each
            # edge contributes the cross product of its two endpoint coordinates.
            x_next, y_next = vertices[(i + 1) % vertex_count]
            cross_sum += (x_i * y_next) - (x_next * y_i)
        # Summed over the closed ring this cross-product total is twice the signed
        # area; halve the magnitude to get the unsigned polygon area.
        region_area = abs(cross_sum) / 2.0

    return {
        "accepted": accepted,
        "rejected": rejected,
        "region_area": region_area,
        "vertex_count": len(vertices),
    }
