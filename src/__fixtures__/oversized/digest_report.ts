// Reporting fixture (TASK-030, Phase 6b A/B corpus).
//
// A single deliberately oversized function. Its HEAD assembles a fixed-width text
// report (grouping, aggregation, column padding). Its TAIL is a second, unrelated
// routine that suggests a correction for an unknown category label; it sits well
// beyond the first 512 tokens, so it is retrievable only when oversized-symbol
// windowing splits the symbol. The tail concept is named only inside the tail.

type LedgerEntry = { category: string; label: string; amountCents: number };

export function renderDigestReport(
  entries: LedgerEntry[],
  knownCategories: string[],
): { report: string; suggestions: Array<{ unknown: string; didYouMean: string; distance: number }> } {
  // ===== SECTION 1 (HEAD): grouping, aggregation, fixed-width formatting =======
  // Bucket entries by category, summing amounts and counting line items. The
  // report is a stable, sorted, fixed-width table so diffs between runs are clean.
  const buckets = new Map<string, { total: number; count: number; labels: string[] }>();
  const unknownCategories = new Set<string>();
  const known = new Set(knownCategories);

  for (const entry of entries) {
    const category = (entry.category || 'uncategorized').trim().toLowerCase();
    if (!known.has(category)) unknownCategories.add(category);

    const bucket = buckets.get(category) ?? { total: 0, count: 0, labels: [] };
    bucket.total += Number.isFinite(entry.amountCents) ? entry.amountCents : 0;
    bucket.count += 1;
    if (entry.label && bucket.labels.length < 3) bucket.labels.push(entry.label.trim());
    buckets.set(category, bucket);
  }

  // Sort categories by descending total so the biggest spend leads the report;
  // ties broken alphabetically for a deterministic ordering.
  const rows = [...buckets.entries()].sort(
    (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
  );

  // Compute column widths from the data so every cell aligns. Currency is right
  // aligned; the category and sample-label columns are left aligned and padded.
  const formatMoney = (cents: number): string => {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const dollars = Math.floor(abs / 100);
    const remainder = (abs % 100).toString().padStart(2, '0');
    return `${sign}$${dollars}.${remainder}`;
  };

  const categoryWidth = Math.max(8, ...rows.map(([category]) => category.length));
  const moneyWidth = Math.max(6, ...rows.map(([, b]) => formatMoney(b.total).length));

  const lines: string[] = [];
  lines.push(`${'CATEGORY'.padEnd(categoryWidth)}  ${'TOTAL'.padStart(moneyWidth)}  COUNT  SAMPLES`);
  lines.push(`${'-'.repeat(categoryWidth)}  ${'-'.repeat(moneyWidth)}  -----  -------`);

  let grandTotal = 0;
  for (const [category, bucket] of rows) {
    grandTotal += bucket.total;
    const left = category.padEnd(categoryWidth);
    const money = formatMoney(bucket.total).padStart(moneyWidth);
    const count = bucket.count.toString().padStart(5);
    const samples = bucket.labels.join(', ');
    lines.push(`${left}  ${money}  ${count}  ${samples}`);
  }
  lines.push(`${'-'.repeat(categoryWidth)}  ${'-'.repeat(moneyWidth)}  -----  -------`);
  lines.push(`${'TOTAL'.padEnd(categoryWidth)}  ${formatMoney(grandTotal).padStart(moneyWidth)}`);
  const report = lines.join('\n');

  // ===== SECTION 2 (TAIL): Levenshtein edit distance ==========================
  // For every unknown category, suggest the closest known category by Levenshtein
  // edit distance — the minimum number of single-character insertions, deletions
  // and substitutions to turn one string into the other. Classic dynamic program:
  // a (m+1) x (n+1) matrix where cell[i][j] is the edit distance between the first
  // i chars of a and the first j chars of b; we keep only the previous row to run
  // in O(min(m, n)) memory.
  const editDistance = (a: string, b: string): number => {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let previousRow = Array.from({ length: b.length + 1 }, (_, j) => j);
    let currentRow = new Array<number>(b.length + 1).fill(0);

    for (let i = 1; i <= a.length; i++) {
      currentRow[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
        const deletion = (previousRow[j] ?? 0) + 1;
        const insertion = (currentRow[j - 1] ?? 0) + 1;
        const substitution = (previousRow[j - 1] ?? 0) + substitutionCost;
        currentRow[j] = Math.min(deletion, insertion, substitution);
      }
      [previousRow, currentRow] = [currentRow, previousRow];
    }
    return previousRow[b.length] ?? 0;
  };

  const suggestions: Array<{ unknown: string; didYouMean: string; distance: number }> = [];
  for (const unknown of unknownCategories) {
    let best = '';
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of known) {
      const distance = editDistance(unknown, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    if (best !== '') suggestions.push({ unknown, didYouMean: best, distance: bestDistance });
  }

  return { report, suggestions };
}
