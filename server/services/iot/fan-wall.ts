/**
 * The layer houses' fan wall, as the vendor's "Ventilation Fan Layout
 * Diagram" draws it: twelve columns by four rows, 48 fans, 22 groups. Groups
 * are mirrored pairs numbered from the centre outward — group 1 is the two
 * middle fans of the lower rows, 2 the middle of the upper rows, 3 to 6 the
 * next column out, and so on to 19 and 20 at the second column from each
 * edge; 21 and 22 are four-fan groups on the outer columns.
 *
 * So left-right symmetry is built in whatever order the ladder brings groups
 * in, and uniformity across the width is about the six column-pairs, edge to
 * centre, each holding eight fans when the wall is full. Seen on 13 September
 * 2026: L2's original order lit the centre and the outer columns and left the
 * two pairs between them dark until step 14; L3's order fills a gap at every
 * step.
 */
export const LAYER_WALL: number[][] = [
  [22, 21, 18, 14, 10, 6, 2, 6, 10, 14, 18, 21],
  [22, 21, 17, 13, 9, 5, 2, 5, 9, 13, 17, 21],
  [22, 20, 16, 12, 8, 4, 1, 4, 8, 12, 16, 20],
  [22, 19, 15, 11, 7, 3, 1, 3, 7, 11, 15, 19],
];

export interface WallCoverage {
  fans: number;
  /** Fans running in each column-pair, outer edge to centre. A full wall has eight in each. */
  pairs: number[];
  /** Fans running in each row, top to bottom. */
  rows: number[];
  emptyPairs: number;
  /** 100 when the running fans are spread across the width exactly as a full wall is; 0 when all sit in one pair. */
  even: number;
}

/** How evenly a set of running groups covers the wall. */
export function wallCoverage(groupsOn: Iterable<number>): WallCoverage {
  const on = new Set(groupsOn);
  const cols = new Array<number>(12).fill(0);
  const rows = new Array<number>(4).fill(0);
  let fans = 0;
  LAYER_WALL.forEach((row, r) =>
    row.forEach((g, c) => {
      if (on.has(g)) {
        cols[c]!++;
        rows[r]!++;
        fans++;
      }
    }),
  );
  const pairs = [0, 1, 2, 3, 4, 5].map((i) => cols[i]! + cols[11 - i]!);
  const emptyPairs = pairs.filter((x) => x === 0).length;
  // rms deviation of each pair's share of the running fans from the one-sixth a full wall gives it
  const dev = fans ? Math.sqrt(pairs.reduce((s, x) => s + (x / fans - 1 / 6) ** 2, 0) / 6) : 0;
  const even = fans ? Math.max(0, Math.round((1 - dev / (1 / 6)) * 100)) : 0;
  return { fans, pairs, rows, emptyPairs, even };
}
