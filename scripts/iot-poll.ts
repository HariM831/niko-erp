/**
 * Drive the shed controllers by hand.
 *
 * The server polls on its own every five minutes while it is running (see
 * server/services/iot/scheduler.ts); this is for everything else — the first
 * poll after the token lands, the 42-day backfill of the vendor's own history,
 * and finding out why a quiet integration is quiet.
 *
 *   npx tsx scripts/iot-poll.ts               one poll, now
 *   npx tsx scripts/iot-poll.ts --backfill    pull the vendor's stored history
 *   npx tsx scripts/iot-poll.ts --status      the last polls and the token
 */
import { tokenExpiry } from "../server/services/iot/bhfarm";
import { backfill, housesByDevice, pollOnce, recentPolls } from "../server/services/iot/store";

const num = (v: number) => v.toLocaleString("en-IN");

/**
 * The token's runway, said out loud every run.
 *
 * A token that quietly expired looks exactly like a farm with no sensors, and
 * this one dies on a known date — the warning has to be louder than the
 * failure will be.
 */
function tokenReport(): boolean {
  if (!process.env.BH_TOKEN) {
    console.log("\n  BH_TOKEN is not set. Put it in .env — the name is in .env.example.\n");
    return false;
  }
  const exp = tokenExpiry();
  if (!exp) {
    console.log("  ! BH_TOKEN does not parse as a JWT — its expiry cannot be watched");
    return true;
  }
  const days = Math.floor((exp.getTime() - Date.now()) / 86_400_000);
  const line = `  token expires ${exp.toISOString().slice(0, 10)} — ${days} day(s) left`;
  if (days < 0) {
    console.log(`  ! ${line.trim()} — IT IS DEAD. Get a fresh one from bhfarm.net.`);
    return false;
  }
  console.log(days < 30 ? `  ! ${line.trim()} — renew it soon` : line);
  return true;
}

const mode = process.argv.includes("--backfill")
  ? "backfill"
  : process.argv.includes("--status")
    ? "status"
    : "poll";

console.log("");
if (mode === "status") {
  tokenReport();
  const mapped = await housesByDevice();
  console.log(`  ${mapped.size} house(s) name a controller: ${[...mapped.values()].map((h) => h.code).join(" ")}`);
  const polls = await recentPolls(10);
  if (!polls.length) {
    console.log("  no polls have run yet\n");
    process.exit(0);
  }
  console.log("\n  last polls");
  for (const p of polls) {
    const when = p.startedAt.toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `   ${when}  ${p.ok ? "ok " : "FAIL"}  ${p.houses} house(s), ${num(p.readings)} reading(s)` +
        (p.error ? `  — ${p.error.slice(0, 90)}` : ""),
    );
  }
  console.log("");
  process.exit(0);
}

if (!tokenReport()) process.exit(1);

if (mode === "backfill") {
  // The operation the six-week window is about: the vendor discards anything
  // older, so this is the once chance to capture what came before EGGSY.
  console.log("  pulling the vendor's stored history — this takes a while\n");
  const r = await backfill(42);
  console.log(`  ${r.houses} house(s), ${num(r.readings)} sample(s) kept, from ${r.from}`);
  // Said out loud rather than swallowed: a window the vendor would not answer
  // is a stretch of history that is gone in six weeks, and it is worth another
  // run today rather than a discovery in November.
  for (const f of r.failed) console.log(`  ! ${f}`);
  console.log("");
  process.exit(r.failed.length ? 1 : 0);
}

const r = await pollOnce();
if (r.error) {
  console.log(`  poll FAILED: ${r.error}\n`);
  process.exit(1);
}
console.log(`  ${r.houses} house(s) · ${num(r.tags)} tag(s) · ${num(r.readings)} reading(s) kept`);
for (const s of r.skipped) console.log(`  · ${s}`);
console.log("");
process.exit(0);
