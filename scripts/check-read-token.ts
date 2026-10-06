/**
 * The read token's gate: off unless configured, and only the right token in.
 *
 * Run: npx tsx scripts/check-read-token.ts
 */
import crypto from "node:crypto";
import { checkReadToken } from "../server/routes/readonly";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};

const token = crypto.randomBytes(32).toString("hex");
const hash = crypto.createHash("sha256").update(token).digest("hex");

check("unset hash switches it off", checkReadToken(`Bearer ${token}`, undefined) === "off");
check("blank hash switches it off", checkReadToken(`Bearer ${token}`, "  ") === "off");
check("malformed hash switches it off", checkReadToken(`Bearer ${token}`, "abc") === "off");
check("the right token is let in", checkReadToken(`Bearer ${token}`, hash) === "ok");
check("an upper-case hash still matches", checkReadToken(`Bearer ${token}`, hash.toUpperCase()) === "ok");
check("no header is refused", checkReadToken(undefined, hash) === "denied");
check("a token without Bearer is refused", checkReadToken(token, hash) === "denied");
check("the hash itself is not a token", checkReadToken(`Bearer ${hash}`, hash) === "denied");
check("a wrong token is refused", checkReadToken(`Bearer ${"0".repeat(64)}`, hash) === "denied");
check("a short token is refused", checkReadToken("Bearer x", hash) === "denied");

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll passed");
