/**
 * Writing to a shed's controller, and knowing that it took.
 *
 * The vendor's write call answers with a status flag and nothing more. That is
 * not confirmation: the controller may refuse a value out of range, clamp it,
 * or be off the network with the platform still answering. So every write here
 * is bracketed — read the registers before, write, read them back — and the
 * record that comes out says what the controller reports, not what was sent.
 *
 * This is the only path a write may take. Nothing else in niko calls the
 * vendor's write endpoint.
 */
import { fetchDeviceStatus, readRegisters, writeRegisters, type BhWrite } from "./bhfarm";

export interface RegisterOutcome {
  fullName: string;
  before: string | null;
  sent: string;
  after: string | null;
  /** The controller reports the value that was sent. */
  took: boolean;
}

export interface WriteRecord {
  houseCode: string;
  startedAt: Date;
  finishedAt: Date;
  /** What the vendor answered, whole, for the log. */
  reply: unknown;
  /** The vendor's own refusal flag, when its reply carries one. */
  refused: boolean;
  registers: RegisterOutcome[];
  /** Every register reads back as sent. */
  confirmed: boolean;
}

export class ControllerOffline extends Error {
  constructor(houseCode: string) {
    super(`controller ${houseCode} is not reachable — nothing was written`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write a set of registers to one house and confirm them by readback.
 *
 * Refuses outright when the controller is not reachable. Reads before the
 * write so the record carries the old value, waits `settleMs` for the
 * controller to take the change, then reads again. A register that reads back
 * different from what was sent is reported as not taken; nothing is retried,
 * because a second attempt at a value the controller just declined is a
 * decision for a person.
 */
export async function writeAndConfirm(
  houseCode: string,
  changes: BhWrite[],
  opts: { settleMs?: number; holdMs?: number } = {},
): Promise<WriteRecord> {
  const startedAt = new Date();
  const status = await fetchDeviceStatus(houseCode);
  if (!status.isLiving) throw new ControllerOffline(houseCode);

  const names = changes.map((c) => c.key);
  const valueOf = (rows: Array<{ fullName: string; value: string }>) =>
    new Map(rows.map((r) => [r.fullName, r.value]));
  const before = valueOf(await readRegisters(names));

  const reply = await writeRegisters(changes);
  const refused =
    typeof reply === "object" && reply !== null && (reply as { status?: unknown }).status === false;

  /*
   * The vendor answers the write at once; the controller takes it later. On
   * 2026-09-06 four registers written to L2 still read their old values
   * three seconds after "status: true" and their new ones twenty seconds
   * after. So the readback is polled: every few seconds until every register
   * reports the value sent, or the patience runs out and the record says
   * which ones never did.
   */
  const took = (a: string | undefined, sent: string) => a != null && Number(a) === Number(sent);
  const patience = opts.settleMs ?? 90_000;
  const started = Date.now();
  let after = new Map<string, string>();
  for (;;) {
    await sleep(after.size ? 5000 : 3000);
    after = valueOf(await readRegisters(names));
    if (changes.every((c) => took(after.get(c.key), c.value))) break;
    if (Date.now() - started > patience) break;
  }
  /*
   * And once more, later. On 2026-09-12 a target of 28 read back as 28 at
   * 11:04 and the controller held 27 from then on: the platform had echoed
   * the write before the controller declined it. A value that is still there
   * after `holdMs` is one the controller has actually kept.
   */
  if (changes.every((c) => took(after.get(c.key), c.value))) {
    await sleep(opts.holdMs ?? 45_000);
    const again = valueOf(await readRegisters(names));
    for (const c of changes) if (again.has(c.key)) after.set(c.key, again.get(c.key)!);
  }

  const registers = changes.map((c) => {
    const a = after.get(c.key) ?? null;
    return {
      fullName: c.key,
      before: before.get(c.key) ?? null,
      sent: c.value,
      after: a,
      took: took(a ?? undefined, c.value),
    };
  });
  return {
    houseCode,
    startedAt,
    finishedAt: new Date(),
    reply,
    refused,
    registers,
    confirmed: !refused && registers.every((r) => r.took),
  };
}
