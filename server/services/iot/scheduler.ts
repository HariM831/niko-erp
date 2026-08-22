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
import { pollOnce } from "./store";

const INTERVAL = () => Number(process.env.BH_POLL_MS ?? 300_000);

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

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
}
