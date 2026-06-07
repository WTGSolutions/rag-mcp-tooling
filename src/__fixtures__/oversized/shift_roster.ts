// Workforce scheduling fixture (TASK-030, Phase 6b A/B corpus).
//
// A single deliberately oversized function. Its HEAD assigns guides to shift slots
// (scheduling / conflict-resolution vocabulary). Its TAIL is a second, unrelated
// routine placed well beyond the first 512 tokens; a head-only (truncated)
// embedding cannot represent it, so the tail region is retrievable only when symbol
// windowing splits the symbol. The tail concept is named only inside the tail.

type ShiftRequest = {
  guideId: string;
  start: number; // minutes since midnight
  end: number;
  priority: number;
  skills: string[];
};

type Slot = { id: string; start: number; end: number; requiredSkill: string };

export function assignShiftRoster(
  requests: ShiftRequest[],
  slots: Slot[],
): { assignments: Array<{ slotId: string; guideId: string; colour: string }>; unfilled: string[] } {
  // ===== SECTION 1 (HEAD): scheduling & conflict resolution ===================
  // Sort requests by descending priority so the most important guides claim the
  // scarce slots first; ties broken by the earliest available start so the day
  // packs tightly from the morning onward.
  const ordered = [...requests].sort((a, b) => b.priority - a.priority || a.start - b.start);

  const assignments: Array<{ slotId: string; guideId: string; colour: string }> = [];
  const unfilled: string[] = [];
  const busyIntervals = new Map<string, Array<[number, number]>>();

  // A guide can take a slot only if they hold the required skill and the slot
  // does not overlap any interval they were already assigned. Overlap is the
  // classic half-open comparison: [aStart, aEnd) intersects [bStart, bEnd).
  const overlaps = (intervals: Array<[number, number]>, start: number, end: number): boolean => {
    for (const [busyStart, busyEnd] of intervals) {
      if (start < busyEnd && busyStart < end) return true;
    }
    return false;
  };

  for (const slot of slots) {
    let chosen: ShiftRequest | undefined;

    for (const request of ordered) {
      // Skill gate: the guide must be qualified for this slot's required skill.
      if (!request.skills.includes(slot.requiredSkill)) continue;

      // Availability gate: the request window must cover the slot window. A guide
      // whose declared availability ends before the slot ends cannot take it.
      if (request.start > slot.start || request.end < slot.end) continue;

      // Conflict gate: no overlap with what this guide already holds today.
      const held = busyIntervals.get(request.guideId) ?? [];
      if (overlaps(held, slot.start, slot.end)) continue;

      chosen = request;
      break;
    }

    if (!chosen) {
      unfilled.push(slot.id);
      continue;
    }

    // Commit the assignment and record the newly busy interval so subsequent
    // slots see this guide as occupied for the overlapping window.
    const held = busyIntervals.get(chosen.guideId) ?? [];
    held.push([slot.start, slot.end]);
    busyIntervals.set(chosen.guideId, held);

    // ===== SECTION 2 (TAIL): HSL to RGB colour conversion =====================
    // Give each assignment a stable display colour derived from the guide id. We
    // map the id's hash to a hue on the colour wheel, then convert HSL to RGB.
    // HSL-to-RGB: chroma C = (1 - |2L - 1|) * S; the hue sector picks which of the
    // RGB channels carry the chroma, X = C * (1 - |(H/60 mod 2) - 1|) handles the
    // intermediate channel, and m = L - C/2 lifts every channel to the lightness.
    let hueHash = 0;
    for (let i = 0; i < chosen.guideId.length; i++) {
      hueHash = (hueHash * 31 + chosen.guideId.charCodeAt(i)) % 360;
    }
    const hue = hueHash; // degrees, 0..359
    const saturation = 0.65;
    const lightness = 0.55;

    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const huePrime = hue / 60;
    const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1));
    const lightnessMatch = lightness - chroma / 2;

    let red = 0;
    let green = 0;
    let blue = 0;
    if (huePrime >= 0 && huePrime < 1) { red = chroma; green = secondary; blue = 0; }
    else if (huePrime < 2) { red = secondary; green = chroma; blue = 0; }
    else if (huePrime < 3) { red = 0; green = chroma; blue = secondary; }
    else if (huePrime < 4) { red = 0; green = secondary; blue = chroma; }
    else if (huePrime < 5) { red = secondary; green = 0; blue = chroma; }
    else { red = chroma; green = 0; blue = secondary; }

    const toByte = (channel: number): number => Math.round((channel + lightnessMatch) * 255);
    const colour = `#${[toByte(red), toByte(green), toByte(blue)]
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')}`;

    assignments.push({ slotId: slot.id, guideId: chosen.guideId, colour });
  }

  return { assignments, unfilled };
}
