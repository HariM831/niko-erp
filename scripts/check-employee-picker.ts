/**
 * The employee picker's match rule, and the "recent joiner" cutoff.
 *
 * Run: npx tsx scripts/check-employee-picker.ts
 */
import { matchesTerms, monthsBefore } from "@shared/search";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

const rows = ["AF0114 Ram Kumar Das", "AF0141 Ramen Boro", "AF1014 Modo Basumatary", "AF0027 Kumar Ram Nath", "W-0014 Rina Das"];
const find = (q: string) => rows.filter((r) => matchesTerms(r, q));

console.log("");
ok("a code finds the codes that contain it, and nothing else", find("0114").join("|") === "AF0114 Ram Kumar Das", find("0114").join(" | "));
ok("every word typed has to be there", find("ram 0114").length === 1 && find("ram das").length === 1);
ok("in any order", find("das ram").length === 1);
ok("any part of a name, not just its start", find("umar").length === 2);
ok("case does not matter", find("RAM").length === 3);
ok("letters merely falling in order are not a match", find("rmd").length === 0);
ok("nothing typed finds everyone", find("  ").length === rows.length);

ok("two months before September is 1 July", monthsBefore(2026, 9, 2) === "2026-07-01", monthsBefore(2026, 9, 2));
ok("two months before January wraps the year", monthsBefore(2027, 1, 2) === "2026-11-01", monthsBefore(2027, 1, 2));
ok("two months before February wraps it too", monthsBefore(2027, 2, 2) === "2026-12-01", monthsBefore(2027, 2, 2));

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
