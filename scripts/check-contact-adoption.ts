/**
 * Checks that the Zoho contact loader recognises a party niko already holds.
 *
 * The 12 Oct 2026 catch-up on staging created a second vendor for ELITE
 * WINDOWS, LCGC BIOANALYTIC SOLUTIONS LLP, VAISHNAVI DRUG CORPORATION and
 * Rajendra Trading Company, because it decided what to insert from
 * `zoho_id_map` alone and those four had reached niko by another route. The
 * four cases below are those rows as they actually stood.
 *
 * The refusals matter as much as the matches: a wrong adoption puts one
 * party's bills on another party's ledger, and the only safe answer to
 * ambiguous evidence is to stop.
 *
 * Touches no database — `decideExisting` is pure and lives apart from the
 * loader for that reason, so this needs no connection and no fixtures.
 *
 * Run: npx tsx scripts/check-contact-adoption.ts
 */
import {
  decideExisting,
  indexExisting,
  type ExistingContact,
  type MatchableContact,
} from "./contact-identity";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};

/** A Zoho record, with only the fields matching looks at. */
const zoho = (name: string, gstin?: string): MatchableContact => ({
  contact_name: name,
  gst_no: gstin,
});

/** What `decideExisting` did, as one short string, or the refusal it threw. */
function outcome(group: MatchableContact[], existing: ExistingContact[]): string {
  try {
    const d = decideExisting(group, indexExisting(existing));
    return d.kind === "create" ? "create" : `adopt ${d.contact.id} on ${d.on}`;
  } catch (err) {
    return `refused: ${(err as Error).message}`;
  }
}

const refused = (s: string) => s.startsWith("refused: ");

// ── The four that went wrong on staging ────────────────────────────────────

// Hand-entered 9 Oct, no GSTIN either side: the name is all there is.
check(
  "ELITE WINDOWS — name only, no GSTIN anywhere",
  outcome([zoho("ELITE WINDOWS")], [{ id: "elite", displayName: "ELITE WINDOWS", gstin: null }]) ===
    "adopt elite on name",
  outcome([zoho("ELITE WINDOWS")], [{ id: "elite", displayName: "ELITE WINDOWS", gstin: null }]),
);

check(
  "LCGC BIOANALYTIC SOLUTIONS LLP — name only",
  outcome(
    [zoho("LCGC BIOANALYTIC SOLUTIONS LLP")],
    [{ id: "lcgc", displayName: "LCGC BIOANALYTIC SOLUTIONS LLP", gstin: null }],
  ) === "adopt lcgc on name",
);

// These two carry the same GSTIN on both sides, which settles it outright.
check(
  "Rajendra Trading Company — GSTIN on both sides",
  outcome(
    [zoho("Rajendra Trading Company", "18AEAPB9602F1ZX")],
    [{ id: "rajendra", displayName: "Rajendra Trading Company", gstin: "18AEAPB9602F1ZX" }],
  ) === "adopt rajendra on GSTIN",
);

check(
  "VAISHNAVI DRUG CORPORATION — GSTIN on both sides",
  outcome(
    [zoho("VAISHNAVI DRUG CORPORATION", "10AOKPK4121L2Z7")],
    [{ id: "vaishnavi", displayName: "VAISHNAVI DRUG CORPORATION", gstin: "10AOKPK4121L2Z7" }],
  ) === "adopt vaishnavi on GSTIN",
);

// ── GSTIN is decisive, and beats the name ──────────────────────────────────

// Renamed in Zoho, or trading under a different style: the registration is the
// party, so the rename follows rather than forking a second contact.
check(
  "GSTIN matches though the name has changed",
  outcome(
    [zoho("Rajendra Trading Co.", "18AEAPB9602F1ZX")],
    [{ id: "rajendra", displayName: "Rajendra Trading Company", gstin: "18AEAPB9602F1ZX" }],
  ) === "adopt rajendra on GSTIN",
);

check(
  "GSTIN spacing and case are not differences",
  outcome(
    [zoho("Rajendra Trading Company", " 18aeapb9602f1zx ")],
    [{ id: "rajendra", displayName: "Rajendra Trading Company", gstin: "18AEAPB9602F1ZX" }],
  ) === "adopt rajendra on GSTIN",
);

check(
  "name case and inner spacing are not differences",
  outcome(
    [zoho("elite   windows")],
    [{ id: "elite", displayName: "ELITE WINDOWS", gstin: null }],
  ) === "adopt elite on name",
);

// The pair a duplicate-display_name search does not find, and the reason the
// name rule compares shapes rather than spellings: only the spacing differs.
check(
  "GOYALPROTEINS LIMITED is Goyal Proteins Limited",
  outcome(
    [zoho("GOYALPROTEINS LIMITED")],
    [{ id: "goyal", displayName: "Goyal Proteins Limited", gstin: null }],
  ) === "adopt goyal on name",
);

check(
  "punctuation is not a difference",
  outcome(
    [zoho("R.K. Phosphates Pvt. Ltd.")],
    [{ id: "rk", displayName: "R K Phosphates Pvt Ltd", gstin: null }],
  ) === "adopt rk on name",
);

// The same convention create-vendors.ts applies, now from the same place.
check(
  "an M/S prefix is not a difference",
  outcome(
    [zoho("M/S Rajendra Trading Company")],
    [{ id: "rajendra", displayName: "Rajendra Trading Company", gstin: null }],
  ) === "adopt rajendra on name",
);

// Zoho knows a GSTIN niko never recorded. Still the same party by name, and
// the loader fills the blank rather than making a second row.
check(
  "name matches, niko holds no GSTIN to contradict Zoho's",
  outcome(
    [zoho("ELITE WINDOWS", "18ABCDE1234F1Z5")],
    [{ id: "elite", displayName: "ELITE WINDOWS", gstin: null }],
  ) === "adopt elite on name",
);

// ── Genuinely new parties ──────────────────────────────────────────────────

check(
  "a party niko has never heard of is created",
  outcome([zoho("BRAND NEW TRADERS", "18ZZZZZ9999Z1Z9")], [
    { id: "elite", displayName: "ELITE WINDOWS", gstin: null },
  ]) === "create",
);

check(
  "a near-miss name is not a match",
  outcome([zoho("ELITE WINDOWS AND DOORS")], [
    { id: "elite", displayName: "ELITE WINDOWS", gstin: null },
  ]) === "create",
);

// Worth stating outright, because dropping spacing is the aggressive part of
// the rule: two parties whose names differ only by a space are taken as one.
// That is the trade the shape rule makes, and what catches the Goyal pair.
check(
  "names differing only by a space are treated as one party",
  outcome([zoho("Sun Rise Traders")], [
    { id: "sunrise", displayName: "Sunrise Traders", gstin: null },
  ]) === "adopt sunrise on name",
);

// ── Refusals: doubtful evidence stops the run ──────────────────────────────

// The case that motivates the whole rule in reverse: one name, two
// registrations, so the loader's own name-merge is what is wrong.
check(
  "refuses one name carrying two GSTINs in the dump",
  refused(
    outcome(
      [zoho("Shared Name", "18AAAAA1111A1Z1"), zoho("Shared Name", "18BBBBB2222B1Z2")],
      [],
    ),
  ),
  outcome([zoho("Shared Name", "18AAAAA1111A1Z1"), zoho("Shared Name", "18BBBBB2222B1Z2")], []),
);

check(
  "refuses when niko holds two contacts of that name",
  refused(
    outcome([zoho("ELITE WINDOWS")], [
      { id: "a", displayName: "ELITE WINDOWS", gstin: null },
      { id: "b", displayName: "elite windows", gstin: null },
    ]),
  ),
);

check(
  "refuses when niko holds that GSTIN twice",
  refused(
    outcome([zoho("Rajendra Trading Company", "18AEAPB9602F1ZX")], [
      { id: "a", displayName: "Rajendra Trading Company", gstin: "18AEAPB9602F1ZX" },
      { id: "b", displayName: "Rajendra Trading Co", gstin: "18AEAPB9602F1ZX" },
    ]),
  ),
);

// GSTIN says one contact, name says another: one of the three records is
// wrong, and picking either would bury that.
check(
  "refuses when GSTIN and name point at different contacts",
  refused(
    outcome([zoho("ELITE WINDOWS", "18AEAPB9602F1ZX")], [
      { id: "rajendra", displayName: "Rajendra Trading Company", gstin: "18AEAPB9602F1ZX" },
      { id: "elite", displayName: "ELITE WINDOWS", gstin: null },
    ]),
  ),
  outcome([zoho("ELITE WINDOWS", "18AEAPB9602F1ZX")], [
    { id: "rajendra", displayName: "Rajendra Trading Company", gstin: "18AEAPB9602F1ZX" },
    { id: "elite", displayName: "ELITE WINDOWS", gstin: null },
  ]),
);

// Same name, two registrations — either niko's GSTIN is stale or these are two
// parties sharing a name, and those need opposite answers.
check(
  "refuses same name under a different registration",
  refused(
    outcome([zoho("VAISHNAVI DRUG CORPORATION", "10AOKPK4121L2Z7")], [
      { id: "v", displayName: "VAISHNAVI DRUG CORPORATION", gstin: "18ZZZZZ9999Z1Z9" },
    ]),
  ),
  outcome([zoho("VAISHNAVI DRUG CORPORATION", "10AOKPK4121L2Z7")], [
    { id: "v", displayName: "VAISHNAVI DRUG CORPORATION", gstin: "18ZZZZZ9999Z1Z9" },
  ]),
);

// ── The refusals name the party, so the output is actionable ───────────────

const message = outcome([zoho("VAISHNAVI DRUG CORPORATION", "10AOKPK4121L2Z7")], [
  { id: "v", displayName: "VAISHNAVI DRUG CORPORATION", gstin: "18ZZZZZ9999Z1Z9" },
]);
check(
  "a refusal names the party and both GSTINs",
  message.includes("VAISHNAVI DRUG CORPORATION") &&
    message.includes("10AOKPK4121L2Z7") &&
    message.includes("18ZZZZZ9999Z1Z9"),
);

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed ? 1 : 0);
