/**
 * Checks that the shortage allowance belongs to the vehicle, not the material.
 *
 * A truck carrying three materials gets ONE 50 kg allowance for the trip, not
 * three. Granting it per line would quietly hand a multi-material load three
 * times the tolerance for the same journey — and the more materials aboard,
 * the more weight a vendor could lose for free.
 *
 * Exercised against the arithmetic directly rather than the database, so the
 * apportionment is readable in one place.
 *
 * Run: npx tsx scripts/check-shortage-allowance.ts
 */
let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
};

/** The same split settlement performs: allowance once, then pro rata by shortfall. */
function apportion(
  lines: Array<{ name: string; shortKg: number; ratePerKg: number }>,
  allowanceKg: number,
) {
  const totalShort = Number(lines.reduce((s, l) => s + l.shortKg, 0).toFixed(3));
  const chargeableKg = Number(Math.max(0, totalShort - allowanceKg).toFixed(3));
  const out = lines
    .filter((l) => l.shortKg > 0)
    .map((l) => {
      const shareKg = totalShort > 0 ? Number(((l.shortKg / totalShort) * chargeableKg).toFixed(3)) : 0;
      return { ...l, shareKg, amount: Number((shareKg * l.ratePerKg).toFixed(2)) };
    })
    .filter((l) => l.amount > 0);
  return { totalShort, chargeableKg, lines: out, total: Number(out.reduce((s, l) => s + l.amount, 0).toFixed(2)) };
}

const ALLOWANCE = 50;

console.log("\n  ONE ALLOWANCE PER TRUCK\n");

// Inside the allowance: nothing is charged, however many materials are aboard.
const within = apportion(
  [
    { name: "Maize", shortKg: 25, ratePerKg: 23.1 },
    { name: "DORB", shortKg: 20, ratePerKg: 18.5 },
  ],
  ALLOWANCE,
);
check("45 kg short across two lines is free", within.total === 0, `${within.totalShort} kg short, nothing chargeable`);

// Per-line tolerance would have made this free too. It must not be.
const across = apportion(
  [
    { name: "Maize", shortKg: 40, ratePerKg: 23.1 },
    { name: "DORB", shortKg: 40, ratePerKg: 18.5 },
  ],
  ALLOWANCE,
);
check(
  "two lines 40 kg short each are NOT both under the allowance",
  across.chargeableKg === 30,
  `${across.totalShort} kg short − 50 = ${across.chargeableKg} kg chargeable`,
);
check(
  "the chargeable weight splits by how short each line ran",
  across.lines[0]!.shareKg === 15 && across.lines[1]!.shareKg === 15,
  across.lines.map((l) => `${l.name} ${l.shareKg} kg`).join(", "),
);
check(
  "each share is charged at its own material's rate",
  across.lines[0]!.amount === 346.5 && across.lines[1]!.amount === 277.5,
  across.lines.map((l) => `${l.name} ₹${l.amount}`).join(", "),
);

// Uneven shortfalls carry the allowance in proportion.
const uneven = apportion(
  [
    { name: "Maize", shortKg: 120, ratePerKg: 23.1 },
    { name: "DORB", shortKg: 30, ratePerKg: 18.5 },
  ],
  ALLOWANCE,
);
check(
  "an uneven load splits the chargeable weight in proportion",
  uneven.chargeableKg === 100 && uneven.lines[0]!.shareKg === 80 && uneven.lines[1]!.shareKg === 20,
  `${uneven.lines.map((l) => `${l.name} ${l.shareKg} kg`).join(", ")} of ${uneven.chargeableKg} kg`,
);
check(
  "the shares add back to the chargeable weight",
  Number(uneven.lines.reduce((s, l) => s + l.shareKg, 0).toFixed(3)) === uneven.chargeableKg,
);

// A single-material truck gets the same allowance, not a smaller one.
const single = apportion([{ name: "Maize", shortKg: 150, ratePerKg: 23.1 }], ALLOWANCE);
check("a single-material truck gets the same 50 kg", single.chargeableKg === 100, `₹${single.total}`);

// A line that arrived in full contributes nothing and is charged nothing.
const partial = apportion(
  [
    { name: "Maize", shortKg: 90, ratePerKg: 23.1 },
    { name: "DORB", shortKg: 0, ratePerKg: 18.5 },
  ],
  ALLOWANCE,
);
check(
  "a line that arrived in full is not charged",
  partial.lines.length === 1 && partial.lines[0]!.name === "Maize",
  `${partial.lines[0]!.shareKg} kg on maize only`,
);

console.log(failed === 0 ? "\n  All shortage-allowance checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
