/**
 * `apiRequest` — the call shape the ported screens are written against.
 *
 * Those pages talk to the farm app's routes: `/api/sheds`, `/api/daily-records/
 * :shedId`, and so on. Rather than edit a couple of thousand lines of JSX to
 * point somewhere else — every edit a chance to change a number on screen —
 * the URLs are translated here, once.
 *
 * Reads all come from one EGGSY endpoint per house, memoised for a moment so
 * that a page firing eight GETs at mount makes one request rather than eight.
 */
import { api } from "../api";

interface Detail {
  shed: unknown;
  allSheds: unknown[];
  stocks: unknown[];
  records: unknown[];
  weights: unknown[];
  breeds: unknown[];
  breedStandards: Record<string, unknown[]>;
  vaccineStandards: unknown[];
  vaccinationRecords: unknown[];
  batchHistory: unknown;
  formulaTransfers: unknown[];
}

/**
 * One in-flight promise per house, held briefly.
 *
 * A page mounting fires its eight reads in the same tick, so they all join the
 * same request. The entry is dropped a second later, which is short enough that
 * a refetch after a save gets fresh data.
 */
const inflight = new Map<string, Promise<Detail>>();

function detail(houseId: string): Promise<Detail> {
  const hit = inflight.get(houseId);
  if (hit) return hit;
  const p = api<Detail>(`/api/farms/houses/${houseId}/detail`);
  inflight.set(houseId, p);
  setTimeout(() => inflight.delete(houseId), 1000);
  return p;
}

/** Everything after the last slash, minus any query string. */
const tail = (url: string) => url.split("?")[0]!.split("/").filter(Boolean).pop()!;

class NotWired extends Error {
  constructor(method: string, url: string) {
    super(`${method} ${url} has no EGGSY equivalent`);
  }
}

/**
 * Mimics fetch's Response closely enough for the ported pages: they call
 * `.json()` and check `.ok`.
 */
function asResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    // `any`, deliberately: the real fetch Response types json() that way, and
    // the ported pages assign the result straight into typed state. Narrowing
    // it here would mean editing a couple of thousand lines of JSX to cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: async (): Promise<any> => body,
  };
}

export async function apiRequest(method: string, url: string, body?: unknown) {
  if (method === "GET") {
    if (url.startsWith("/api/sheds")) {
      return asResponse((await detail(await anyHouse())).allSheds);
    }
    if (url.startsWith("/api/breeds")) {
      return asResponse((await detail(await anyHouse())).breeds);
    }
    if (url.startsWith("/api/vaccine-standards")) {
      return asResponse((await detail(await anyHouse())).vaccineStandards);
    }
    if (url.startsWith("/api/breed-standards/")) {
      const breedId = tail(url);
      const d = await detail(await anyHouse());
      return asResponse(d.breedStandards[breedId] ?? []);
    }
    // The rest are all "…/:shedId" and answered from that house's payload.
    const houseId = tail(url);
    const d = await detail(houseId);
    if (url.startsWith("/api/bird-stock/")) return asResponse(d.stocks);
    if (url.startsWith("/api/daily-records/")) return asResponse(d.records);
    if (url.startsWith("/api/weekly-weights/")) return asResponse(d.weights);
    if (url.startsWith("/api/vaccination-records/")) return asResponse(d.vaccinationRecords);
    if (url.startsWith("/api/shed-batch-history/")) return asResponse(d.batchHistory);
    if (url.startsWith("/api/farm/iot")) return asResponse([]);
    throw new NotWired(method, url);
  }

  // ── Writes ──
  //
  // Same paths, translated onto EGGSY's services in server/routes/farms-compat.
  // The in-flight read cache is cleared so the refetch every save triggers sees
  // what was just written rather than the copy from a moment ago.
  inflight.clear();
  const target = url.replace(/^\/api\//, "/api/farms/compat/");
  const result = await api<unknown>(target, {
    method: method as "POST" | "PATCH" | "DELETE",
    body: body ?? undefined,
  });
  return asResponse(result);
}

/**
 * The house whose payload answers the app-wide reads (sheds, breeds, vaccine
 * standards). Any house returns the same lists, so the first one will do.
 */
let anyHouseId: string | null = null;
async function anyHouse(): Promise<string> {
  if (anyHouseId) return anyHouseId;
  const board = await api<{ sheds: Array<{ id: string }> }>("/api/farms/houses-board");
  anyHouseId = board.sheds[0]?.id ?? "";
  return anyHouseId;
}
