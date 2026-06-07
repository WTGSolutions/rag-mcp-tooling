"""Diverse small utilities (TASK-030 distractor corpus).

These are normal-sized single-chunk functions. They exist to give the A/B corpus
realistic top-5 competition — including a few *topical neighbours* of each tail
concept (networking/retry, string distance) so a truncated head embedding does
not falsely rank for a tail query. None of them is an A/B target.
"""

from typing import Callable, Iterable


def http_status_category(code: int) -> str:
    """Classify an HTTP status code into a coarse category."""
    if 100 <= code < 200:
        return "informational"
    if 200 <= code < 300:
        return "success"
    if 300 <= code < 400:
        return "redirect"
    if 400 <= code < 500:
        return "client-error"
    return "server-error"


def token_bucket_allow(tokens: float, capacity: float, refill_rate: float, elapsed: float) -> bool:
    """Rate-limit decision: does the bucket have a token after refilling?"""
    refilled = min(capacity, tokens + refill_rate * elapsed)
    return refilled >= 1.0


def parse_retry_after(header: str) -> int:
    """Parse a Retry-After header value (delta-seconds) into an int, clamped >= 0."""
    try:
        return max(0, int(header.strip()))
    except (ValueError, AttributeError):
        return 0


def hamming_distance(a: str, b: str) -> int:
    """Count positions at which two equal-length strings differ."""
    if len(a) != len(b):
        raise ValueError("hamming_distance requires equal-length strings")
    return sum(1 for x, y in zip(a, b) if x != y)


def longest_common_prefix(strings: Iterable[str]) -> str:
    """Return the longest string prefix shared by every input string."""
    items = list(strings)
    if not items:
        return ""
    prefix = items[0]
    for s in items[1:]:
        while not s.startswith(prefix):
            prefix = prefix[:-1]
            if prefix == "":
                return ""
    return prefix


def format_bytes(count: int) -> str:
    """Render a byte count in human-readable binary units."""
    size = float(count)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if size < 1024.0:
            return f"{size:.1f}{unit}"
        size /= 1024.0
    return f"{size:.1f}PiB"


def triangle_area(ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    """Area of a triangle from its three vertex coordinates (cross product)."""
    return abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2.0


def bounding_box(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    """Axis-aligned bounding rectangle (min_x, min_y, max_x, max_y) of 2D points."""
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return (min(xs), min(ys), max(xs), max(ys))


def partition(items: Iterable[int], predicate: Callable[[int], bool]) -> tuple[list[int], list[int]]:
    """Split items into (matching, not-matching) by a predicate."""
    yes: list[int] = []
    no: list[int] = []
    for item in items:
        (yes if predicate(item) else no).append(item)
    return yes, no
