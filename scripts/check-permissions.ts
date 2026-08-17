/**
 * Checks the permission catalogue resolves actions per module.
 *
 * The rule these guard: a module that names its own verbs (procurement's six
 * stations) must keep them through a save, and a wildcard must expand to that
 * module's verbs rather than the standard four. Both used to be resolved from
 * one global list, so a stored `gate_in` was silently dropped and `*` granted
 * create/edit/delete on a module that has no such thing.
 *
 * Run: npx tsx scripts/check-permissions.ts
 */
import { actionsFor, effectiveActions, sanitisePermissions } from "../shared/permissions";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const saved = sanitisePermissions({ procurement: ["view", "weighbridge"] });
check("custom actions survive a save", eq(saved, { procurement: ["view", "weighbridge"] }), JSON.stringify(saved));

const std = sanitisePermissions({ purchases: ["view", "create"] });
check("standard module unchanged", eq(std, { purchases: ["view", "create"] }), JSON.stringify(std));

const foreign = sanitisePermissions({ procurement: ["view", "delete"] });
check("action the module never had is dropped", eq(foreign, { procurement: ["view"] }), JSON.stringify(foreign));

const crossed = sanitisePermissions({ purchases: ["view", "gate_in"] });
check("station verb rejected on purchases", eq(crossed, { purchases: ["view"] }), JSON.stringify(crossed));

const unknown = sanitisePermissions({ nonesuch: ["view"] });
check("unknown module dropped", eq(unknown, {}), JSON.stringify(unknown));

// Counted from the module rather than written as a number, so adding a verb is
// a one-line edit to shared/permissions.ts and not a failing test as well.
const stationVerbs = actionsFor("procurement").map((a) => a.key);

const wild = effectiveActions({ procurement: ["*"] }, "procurement");
check(
  "wildcard expands to every station verb the module declares",
  wild.length === stationVerbs.length && wild.includes("settle") && wild.includes("override"),
  wild.join(","),
);

const admin = effectiveActions({ "*": ["*"] }, "procurement");
check("admin holds every station verb", admin.length === stationVerbs.length, admin.join(","));
check("admin on a standard module still gets four", effectiveActions({ "*": ["*"] }, "purchases").length === 4);

const gate = effectiveActions({ procurement: ["view", "gate_in"] }, "procurement");
check("a gate operator cannot settle", !gate.includes("settle"), gate.join(","));

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed ? 1 : 0);
