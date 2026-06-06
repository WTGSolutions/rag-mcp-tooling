"""Participant tracking-token normalisation and rate limiting."""
import time


def normalize_tokens(raw: list[str]) -> list[str]:
    """Lower-case, strip, de-duplicate participant tracking tokens (stable order)."""
    seen: set[str] = set()
    out: list[str] = []
    for tok in raw:
        t = tok.strip().lower()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


class TokenBucket:
    """Simple token-bucket rate limiter for outbound location pings."""

    def __init__(self, capacity: int, refill_per_sec: float) -> None:
        self.capacity = capacity
        self.refill_per_sec = refill_per_sec
        self.tokens = float(capacity)
        self.updated = time.monotonic()

    def allow(self, cost: float = 1.0) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.refill_per_sec)
        self.updated = now
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False
