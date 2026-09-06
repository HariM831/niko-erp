/**
 * The five-minute heartbeat.
 *
 * Started once at server boot, only when a token is configured — a farm with
 * no BH_TOKEN is a farm that has chosen not to poll, and the server should say
 * so once rather than fail every five minutes.
 *
 * Polls never overlap: a slow one holds the next back rather than stacking. A
 * failed poll logs and waits its turn again — the vendor's API drops out
 * routinely, and a controller that is offline at 3am is usually back by 3:10.
 */
import { tokenExpiry } from "./bhfarm";
import { fillGaps, pollOnce } from "./store";
import { getCatalog, snapshotAll } from "./controls";
import { evaluateAll } from "./proposals";
import { db } from "../../db";
import { controllerSnapshots } from "@shared/schema";
import { desc } from "drizzle-orm";

const INTERVAL = () => Number(process.env.BH_POLL_MS ?? 300_000);
/** Long enough after boot that the first poll and the migrations are done with. */
const FILL_DELAY_MS = 90_000;
const FILL_EVERY_MS = 6 * 3_600_000;

let running = false;
let filling = false;
let timer: ReturnType<typeof setInterval> | null = null;
let fillTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Repair what the poller was not running to see.
 *
 * The poller only runs while the server does, so every restart, crash and
 * deploy leaves a hole — one of them cost fifteen hours of a night. The vendor
 * keeps about six weeks, so those holes are recoverable; this is what makes the
 * recovery automatic rather than a matter of someone noticing a flat line on a
 * chart weeks later.
 *
 * Runs shortly after boot, which is exactly when the hole a restart just made
 * is newest, and then a few times a day.
 */
async function fillTick(): Promise<void> {
  if (filling) return;
  filling = true;
  try {
    const r = await fillGaps();
    if (r.gaps) {
      console.log(`[iot] ${r.gaps} gap(s) found, ${r.filled} filled, ${r.readings} sample(s) recovered`);
    }
    for (const f of r.failed) console.warn(`[iot] gap fill failed: ${f}`);
  } catch (e) {
    console.error(`[iot] gap fill crashed: ${e instanceof Error ? e.message : e}`);
  } finally {
    filling = false;
  }
}

/**
 * The controllers' settings, kept once a night.
 *
 * At 02:30 IST, when nobody is on a panel and the vendor's API is quiet. Reads
 * every register of every house and records what changed since the night
 * before. Also runs shortly after boot when the newest snapshot is older than
 * a day, so a long outage does not leave a hole in the record of what the
 * sheds were set to. Skipped entirely until the catalogue exists.
 */
let snapping = false;
async function snapshotTick(): Promise<void> {
  if (snapping) return;
  snapping = true;
  try {
    if (!(await getCatalog())) return;
    const results = await snapshotAll();
    for (const r of results) {
      if (r.skipped) console.warn(`[controls] ${r.code}: snapshot skipped — ${r.skipped}`);
      else console.log(`[controls] ${r.code}: ${r.registers} register(s) kept, ${r.changes} changed since last`);
    }
    // With the settings freshly kept, ask the rules what the week says.
    for (const r of await evaluateAll()) {
      if (r.skipped) console.warn(`[rules] ${r.code}: ${r.skipped}`);
      else if (r.created || r.superseded) console.log(`[rules] ${r.code}: ${r.created} proposal(s) raised, ${r.superseded} withdrawn`);
    }
  } catch (e) {
    console.error(`[controls] snapshot crashed: ${e instanceof Error ? e.message : e}`);
  } finally {
    snapping = false;
  }
}

/** Milliseconds until the next 02:30 IST. */
function untilNightly(): number {
  const now = Date.now();
  const ist = new Date(now + 5.5 * 3_600_000);
  const next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 2, 30) - 5.5 * 3_600_000;
  return next > now ? next - now : next + 86_400_000 - now;
}

async function snapshotIsStale(): Promise<boolean> {
  const [last] = await db.select({ at: controllerSnapshots.takenAt }).from(controllerSnapshots).orderBy(desc(controllerSnapshots.takenAt)).limit(1);
  return !last || Date.now() - last.at.getTime() > 86_400_000;
}

async function tick(): Promise<void> {
  if (running) return; // the previous poll is still going — skip, not stack
  running = true;
  try {
    const r = await pollOnce();
    if (r.error) {
      console.error(`[iot] poll failed: ${r.error}`);
    } else {
      console.log(`[iot] ${r.houses} house(s), ${r.readings} reading(s)`);
      for (const s of r.skipped) console.log(`[iot] · ${s}`);
    }
  } catch (e) {
    console.error(`[iot] poll crashed: ${e instanceof Error ? e.message : e}`);
  } finally {
    running = false;
  }
}

export function startIotPolling(): void {
  if (!process.env.BH_TOKEN) {
    console.log("[iot] BH_TOKEN is not set — the sheds' instruments will not be read");
    return;
  }

  /**
   * Holding the token and polling on a timer are two different decisions.
   *
   * Staging needs to READ the sheds to be worth testing against, but a second
   * environment polling every five minutes doubles the load on a vendor API
   * that drops out on its own often enough. BH_POLL=off keeps the credential
   * and drops the timer; the Fetch now button still works, because that is a
   * person asking rather than a clock.
   */
  if (process.env.BH_POLL === "off") {
    console.log("[iot] BH_POLL=off — no timer; readings come from Fetch now only");
    return;
  }

  const exp = tokenExpiry();
  if (exp) {
    const days = Math.floor((exp.getTime() - Date.now()) / 86_400_000);
    if (days < 0) {
      console.error(`[iot] BH_TOKEN EXPIRED ${exp.toISOString().slice(0, 10)} — polling is pointless until it is renewed`);
      return;
    }
    // Said at every boot once inside a month, because an expired token looks
    // exactly like a farm with no sensors and nobody goes looking for it.
    if (days < 30) console.warn(`[iot] BH_TOKEN expires ${exp.toISOString().slice(0, 10)} — ${days} day(s) left`);
  }

  console.log(`[iot] polling every ${INTERVAL() / 1000}s`);
  void tick(); // first one now, not five minutes from now
  timer = setInterval(() => void tick(), INTERVAL());
  timer.unref?.(); // never the reason the process cannot exit

  const first = setTimeout(() => void fillTick(), FILL_DELAY_MS);
  first.unref?.();
  fillTimer = setInterval(() => void fillTick(), FILL_EVERY_MS);
  fillTimer.unref?.();

  const catchUp = setTimeout(async () => {
    if (await snapshotIsStale().catch(() => false)) void snapshotTick();
  }, FILL_DELAY_MS + 60_000);
  catchUp.unref?.();
  const nightly = setTimeout(() => {
    void snapshotTick();
    const daily = setInterval(() => void snapshotTick(), 86_400_000);
    daily.unref?.();
  }, untilNightly());
  nightly.unref?.();
}
