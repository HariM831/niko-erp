/**
 * The Big Herdsman client (bhfarm.net).
 *
 * Talks to the controllers in the sheds: discovers which houses exist, which
 * tags the controller template reports, and reads current and historical
 * values. It knows nothing about niko — no database, no houses table — so it
 * can be pointed at the vendor and checked on its own.
 *
 * The protocol here is not guesswork and must not be "tidied": it is carried
 * verbatim from the Amino integration that has run against this farm for a
 * year. The API's shape is idiosyncratic — discovery is GET with query params,
 * live values are a POST whose body is a BARE ARRAY of tag ids, the tenant
 * header is literally named `__tenant`, and history comes back WIDE: one row
 * per (timestamp, house) with a column per tag, named `<tag>Value`.
 *
 * Two tag exclusions were each found the hard way:
 *
 *   · Some categories exist in every controller template but have no hardware
 *     on this farm — weather station, bird scale, egg counter, power meter.
 *     They answer with nulls forever; polling them writes dead rows.
 *
 *   · On 2026-07-16 the vendor renamed the feed and water family. The old
 *     names STILL ANSWER — with the value they held on the day of the rename.
 *     House 3 read a silo of 17,078 kg against a true 10,788 for weeks. They
 *     are excluded, never fallen back to: a stale number that looks fresh is
 *     worse than a missing one.
 *
 * Configuration, all optional except the token:
 *   BH_TOKEN     bearer token from bhfarm.net (raw JWT or "Bearer <jwt>")
 *   BH_TENANT    tenant header value
 *   BH_FARM_ID   farm override; discovered when absent
 *   BH_TIMEZONE  offset sent to the API (default "+05:30")
 *   BH_TAG_CHUNK max tag ids per live request (default 300)
 */

const BASE = "https://bhfarm.net/api";

const EP = {
  farmList: `${BASE}/Ops/farm/farm-list`,
  houseList: `${BASE}/IB/house/house-info-preview-list`,
  tagTree: `${BASE}/IB/monitoring-category/monitoring-category-and-tag-tree`,
  currentValues: `${BASE}/IB/current-tag/get-process-tag-value-list`,
  history: `${BASE}/IB/contrast-analysis/find-data-by-date-time`,
} as const;

const DEFAULT_TENANT = "3a212727-cd22-5ec7-d508-5decf119d32c";

/**
 * Tags renamed on 2026-07-16 whose old names still answer with frozen values.
 * Matched on the exact leaf so the numbered successors are not caught.
 */
const FROZEN_LEGACY_LEAVES = new Set([
  "基础数据.水料量.料塔实时重量",
  "基础数据.水料量.料塔本日累加料",
  "基础数据.水料量.今日用料量",
  "基础数据.水料量.今日用水量",
]);

/**
 * The same four, by bare name — history's wide rows only carry the display
 * name, so the exclusion has to work at that grain too.
 */
export const FROZEN_LEGACY_NAMES = new Set([
  "料塔实时重量",
  "料塔本日累加料",
  "今日用料量",
  "今日用水量",
]);

/** Categories with no hardware behind them on this farm. */
function isDeadTag(leaf: string): boolean {
  return (
    leaf.startsWith("基础数据.气象站.") || // weather station — not installed
    leaf.includes("鸡称") || //               bird scale — not installed
    leaf.startsWith("基础数据.数量.") || //    automatic egg count — none
    leaf.startsWith("其他数据.电能.") || //    energy metering — no meter
    FROZEN_LEGACY_LEAVES.has(leaf)
  );
}

/**
 * Each metric resolves as the aggregate tag first, else the sum of the
 * per-line tags. Deliberately NO fallback to the unnumbered name: a missing
 * value must read as null, never as the value it held in July.
 */
export const METRIC_TAGS = {
  siloKg: { total: "料塔当前总料量", lines: ["料塔实时重量1", "料塔实时重量2", "料塔实时重量3", "料塔实时重量4"] },
  feedKg: { total: "今日总用料量", lines: ["今日用料量1", "今日用料量2", "今日用料量3", "今日用料量4"] },
  waterL: { total: "今日总用水量", lines: ["今日用水量1", "今日用水量2", "今日用水量3", "今日用水量4"] },
} as const;

/**
 * The single-value tags worth naming, by their LAST path segment.
 *
 * By name rather than full path, because the two ways readings arrive disagree
 * about the path: a live poll carries the full `category.subcategory.name`
 * behind the device, while history's wide rows carry only the name. The names
 * are unique within the template, so the last segment is the honest join key.
 */
/**
 * A family's figure: the aggregate tag, unless its numbered lines add up to
 * more. A total can never be less than its parts, so when it is, the total is
 * the bad reading.
 *
 * On 2026-09-04 at 16:33 IST every COMPUTED tag on every controller read 0
 * for one poll — the totals, the silo, the per-bird figures — while every
 * MEASURED tag carried on: L3's water total said 0 against 37,900 L on line
 * 1, its silo 0 against 20,042 kg. The measured lines are the instrument; the
 * totals are the controller's arithmetic, and the arithmetic blinks. Taking
 * the larger of the two puts the sample right at the source, instead of
 * storing a dip that every chart, summary and board then has to explain
 * away. The same rule covers a line sensor that dies and takes a quarter off
 * the aggregate.
 *
 * Null only when neither the total nor any line answered.
 */
export function resolveMetric(
  get: (name: string) => number | null | undefined,
  spec: { total: string; lines: readonly string[] },
): number | null {
  const total = get(spec.total) ?? null;
  const parts = spec.lines.map((l) => get(l)).filter((x): x is number => x != null);
  const sum = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  if (total == null) return sum;
  if (sum == null) return total;
  return Math.max(total, sum);
}

/**
 * A per-bird figure the controller worked out from a total. Zero while the
 * total it comes from is not zero is the same blink as above: the
 * arithmetic missed a beat, and nothing was measured. Null says so.
 */
export function resolvePerBird(perBird: number | null | undefined, total: number | null): number | null {
  if (perBird == null) return null;
  if (perBird === 0 && total != null && total > 0) return null;
  return perBird;
}

export const SINGLE_TAGS = {
  tempC: "当前温度",
  targetTempC: "目标温度",
  humidityPct: "当前湿度",
  co2Ppm: "CO2",
  pressurePa: "当前负压",
  birdCount: "剩余数量",
  birdAgeDays: "当前日龄",
  feedPerBirdG: "只鸡耗料量",
  waterPerBirdMl: "只鸡饮水量",
} as const;

export interface BhDevice {
  /** The hex controller code — bhfarm calls it houseCode; it keys every tag. */
  houseCode: string;
  name: string;
  enabled: boolean;
}

export interface BhSubCategory {
  id: string;
  name: string;
}

export interface BhTagValue {
  tagId: string;
  value: string | null;
  quality: number;
  unit: string;
  /** Only set by history reads; a live read is "now". */
  recordedAt?: string;
}

export class BhError extends Error {}

/** 401/403: the credential died. Distinct because polling cannot recover. */
export class BhAuthError extends BhError {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "BhAuthError";
  }
}

function authHeader(): string {
  const raw = process.env.BH_TOKEN?.trim();
  if (!raw) throw new BhError("BH_TOKEN is not set — nothing can be read from bhfarm.net");
  return raw.toLowerCase().startsWith("bearer ") ? raw : `Bearer ${raw}`;
}

/** The headers bhfarm actually expects — `__tenant`, not anything saner. */
function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: authHeader(),
    Accept: "application/json",
    __tenant: process.env.BH_TENANT ?? DEFAULT_TENANT,
    __timezone: process.env.BH_TIMEZONE ?? "+05:30",
    Origin: "https://bhfarm.net",
    Referer: "https://bhfarm.net/group.html",
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

function check(res: Response, method: string, url: string, text: string): never {
  if (res.status === 401 || res.status === 403) {
    const exp = tokenExpiry();
    throw new BhAuthError(
      res.status,
      `bhfarm rejected the credential (${res.status}). BH_TOKEN is expired or revoked` +
        (exp ? ` (token exp ${exp.toISOString().slice(0, 10)})` : "") +
        ` — polling cannot recover without a new token.`,
    );
  }
  throw new BhError(`bhfarm ${method} ${url.replace(BASE, "")} → ${res.status}: ${text.slice(0, 200)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry the vendor's own bad days, but never its refusals.
 *
 * The history endpoint answers 504 through its nginx when a query asks for more
 * than it can gather in time, and the same query put again a moment later
 * usually succeeds. A 401 is the opposite: the credential is dead and no number
 * of attempts will revive it, so `check` throws straight through.
 */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

async function send<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt * 4000);
    try {
      const res = await fetch(url, {
        method,
        headers: headers(body !== undefined),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text();
      if (!TRANSIENT.has(res.status)) check(res, method, url, text);
      last = new BhError(`bhfarm ${method} ${url.replace(BASE, "")} → ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      // A dead credential is not worth a second attempt.
      if (e instanceof BhAuthError) throw e;
      last = e;
    }
  }
  throw last;
}

const get = <T>(url: string): Promise<T> => send<T>("GET", url);
const post = <T>(url: string, body: unknown): Promise<T> => send<T>("POST", url, body);

/**
 * When the token dies. Read out of the JWT rather than configured, because a
 * token that quietly expired looks exactly like a farm with no sensors.
 */
export function tokenExpiry(): Date | null {
  const raw = (process.env.BH_TOKEN ?? "").replace(/^bearer\s+/i, "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

let farmIdCache: string | null = null;

export async function discoverFarmId(): Promise<string> {
  if (process.env.BH_FARM_ID) return process.env.BH_FARM_ID;
  if (farmIdCache) return farmIdCache;
  const data = await get<unknown>(EP.farmList);
  const arr = (Array.isArray(data)
    ? data
    : ((data as { items?: unknown[]; data?: unknown[] }).items ??
      (data as { data?: unknown[] }).data ??
      [])) as Array<{ id?: string }>;
  const id = arr[0]?.id;
  if (!id) throw new BhError("bhfarm returned no farm for this account");
  farmIdCache = id;
  return id;
}

/** Which controllers the account can see. */
export async function discoverDevices(): Promise<BhDevice[]> {
  const farmId = await discoverFarmId();
  const url = `${EP.houseList}?OnlyCurrentUserPermission=true&FarmId=${farmId}&SkipCount=0&MaxResultCount=999`;
  const data = await get<{ items?: Array<{ houseCode?: string; name?: string; enabled?: boolean }> }>(url);
  const items = data.items ?? (Array.isArray(data) ? (data as never) : []);
  return (items as Array<{ houseCode?: string; name?: string; enabled?: boolean }>)
    .filter((h) => h.houseCode)
    .map((h) => ({
      houseCode: h.houseCode!,
      name: String(h.name ?? h.houseCode),
      enabled: h.enabled !== false,
    }));
}

/**
 * The controller template, shared by every house: the tag leaves (as
 * fullDictCode paths) and the subcategories the history endpoint filters by.
 *
 * One tree for the whole farm — it is a template, not a per-device inventory —
 * so it is fetched once and cached for the process.
 */
let treeCache: { leaves: string[]; subcategories: BhSubCategory[] } | null = null;

export async function discoverTagTree(): Promise<{ leaves: string[]; subcategories: BhSubCategory[] }> {
  if (treeCache) return treeCache;
  const root = await get<unknown>(EP.tagTree);

  const leaves: string[] = [];
  const subcategories: BhSubCategory[] = [];
  const walk = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const n = node as {
      children?: unknown[];
      fullDictCode?: string;
      id?: string;
      displayText?: string;
    };
    const kids = (n.children ?? []) as Array<{ children?: unknown[] }>;
    if (!kids.length) {
      if (n.fullDictCode) leaves.push(n.fullDictCode);
      return;
    }
    // A node whose children are all leaves is a subcategory — the unit the
    // history endpoint understands.
    if (kids.every((k) => !k.children?.length) && n.id) {
      subcategories.push({ id: n.id, name: String(n.displayText ?? "") });
    }
    kids.forEach(walk);
  };
  walk((root as { children?: unknown[] }).children ?? root);

  treeCache = {
    leaves: [...new Set(leaves)].filter((l) => !isDeadTag(l)),
    subcategories,
  };
  return treeCache;
}

/** Every live tag id for one device: `houseCode.fullDictCode`. */
export async function tagIdsFor(houseCode: string): Promise<string[]> {
  const { leaves } = await discoverTagTree();
  return leaves.map((leaf) => `${houseCode}.${leaf}`);
}

const CHUNK = () => Number(process.env.BH_TAG_CHUNK ?? 300);

/** Current values. The request body is the bare array — that is the API. */
export async function fetchCurrentValues(tagIds: string[]): Promise<BhTagValue[]> {
  const out: BhTagValue[] = [];
  for (let i = 0; i < tagIds.length; i += CHUNK()) {
    const data = await post<unknown>(EP.currentValues, tagIds.slice(i, i + CHUNK()));
    out.push(...parseTagValues(data));
  }
  return out;
}

/** The response wraps values in an array whose first element holds the reading. */
function parseTagValues(data: unknown): BhTagValue[] {
  const arr = (Array.isArray(data)
    ? data
    : ((data as { data?: unknown[]; result?: unknown[]; items?: unknown[]; list?: unknown[] }).data ??
      (data as { result?: unknown[] }).result ??
      (data as { items?: unknown[] }).items ??
      (data as { list?: unknown[] }).list ??
      [])) as Array<Record<string, unknown>>;
  return arr.map((item) => {
    const tagId = String(item.key ?? item.tagId ?? item.TagId ?? item.id ?? "");
    const first = Array.isArray(item.value) ? (item.value[0] as Record<string, unknown> | undefined) : undefined;
    let raw: unknown = null;
    for (const c of [first?.val, item.val]) {
      if (c !== undefined && c !== null && typeof c !== "object") {
        raw = c;
        break;
      }
    }
    return {
      tagId,
      value: raw == null ? null : String(raw),
      quality: Number(first?.quality ?? first?.Quality ?? item.quality ?? item.Quality ?? 0),
      unit: String(first?.unit ?? item.unit ?? "") || guessUnit(tagId),
    };
  });
}

/** The API takes wall-clock time in the farm's own offset, not UTC. */
function wallClockIso(d: Date): string {
  const tz = process.env.BH_TIMEZONE ?? "+05:30";
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
  const offsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const suffix = m ? `${m[1]}${m[2]}:${m[3]}` : "Z";
  return new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 19) + suffix;
}

/**
 * The vendor's own stored history for one house, every page followed.
 *
 * WIDE rows: one per (timestamp, house), a column per tag named `<tag>Value`,
 * with `time` carrying the instant. This is the endpoint the six-week
 * retention window is about — it stops answering for anything older.
 */
export async function fetchHistoryRows(opts: {
  houseCode: string;
  from: Date;
  to: Date;
  spanMinutes?: number;
}): Promise<Array<Record<string, unknown>>> {
  const { subcategories } = await discoverTagTree();
  const cats = subcategories.map((s) => ({ subCategoryId: s.id, subCategoryName: s.name }));
  const pageSize = 1000;

  const all: Array<Record<string, unknown>> = [];
  let skip = 0;
  for (;;) {
    const data = await post<{ totalCount?: number; items?: Array<Record<string, unknown>> }>(EP.history, {
      skipCount: skip,
      maxResultCount: pageSize,
      startTime: wallClockIso(opts.from),
      endTime: wallClockIso(opts.to),
      houseCodes: [opts.houseCode],
      monitoringCategories: cats,
      spanMinutes: opts.spanMinutes ?? 5,
    });
    const items = data.items ?? [];
    all.push(...items);
    skip += items.length;
    const total = data.totalCount ?? items.length;
    if (!items.length || skip >= total) break;
  }
  return all;
}

/**
 * Unpack one wide history row into readings.
 *
 * The wide format only carries display names, so the tag id is
 * `houseCode.name` — shallower than the live poller's full path, which is why
 * everything downstream joins on the LAST segment. The frozen July names are
 * dropped here too; they are as stale in history as they are live.
 */
export function unpackHistoryRow(houseCode: string, row: Record<string, unknown>): BhTagValue[] {
  const ts = row.time ?? row.Time;
  if (!ts) return [];
  const out: BhTagValue[] = [];
  for (const [key, raw] of Object.entries(row)) {
    if (!key.endsWith("Value") || raw == null || raw === "") continue;
    const name = key.slice(0, -"Value".length);
    if (FROZEN_LEGACY_NAMES.has(name)) continue;
    out.push({
      tagId: `${houseCode}.${name}`,
      value: String(raw),
      quality: 0,
      unit: guessUnit(name),
      recordedAt: String(ts),
    });
  }
  return out;
}

/** The controller does not send units, so they are inferred from the tag. */
function guessUnit(tagId: string): string {
  if (tagId.includes("CO2")) return "ppm";
  if (tagId.includes("NH3")) return "ppm";
  if (tagId.includes("温度")) return "°C";
  if (tagId.includes("湿度")) return "%";
  if (tagId.includes("负压")) return "Pa";
  if (tagId.includes("用水量") || tagId.includes("饮水量")) return "L";
  if (tagId.includes("用料量") || tagId.includes("耗料量") || tagId.includes("重量") || tagId.includes("料量")) {
    return "kg";
  }
  if (tagId.includes("日龄")) return "days";
  if (tagId.includes("数量")) return "birds";
  if (tagId.includes("角度")) return "°";
  return "";
}

/** The last path segment — the join key everything matches tags on. */
export const nameOf = (tagId: string) => tagId.split(".").pop() ?? "";

/**
 * The tags worth KEEPING A HISTORY of — and the column each one is stored in.
 *
 * Every tag the controller reports lands in `iot_readings`, which is one row
 * per tag overwritten in place and therefore costs nothing to hold. History is
 * different: at 3,469 live tags across six houses, polled every five minutes,
 * storing all of them writes 999,072 rows a day — 0.4 GB a day, about 146 GB a
 * year. Nobody will ever plot the opening angle of curtain 2 on fan bank 14.
 *
 * So history keeps the readings a person might actually chart: the conditions,
 * the consumption, and the per-line tags the aggregates are built from.
 *
 * These are COLUMNS, not rows. `iot_house_sample` holds one row per house per
 * instant with a column each, which is the difference between 126 MB a year and
 * 4.9 GB: a tall table re-states the house, the instant and the tag name for
 * every single measurement, then indexes all three again — 288 bytes of
 * bookkeeping around 4 bytes of reading. A wide row pays that once per instant.
 * It is also the shape the vendor's own history endpoint answers in.
 *
 * The order here IS the column order of the insert, and the keys ARE the column
 * names in `iot_house_sample`. Adding one means a migration and a schema entry;
 * its history starts that day, and nothing recovers the period before — which is
 * the argument for keeping the list a little wider than today's screens need.
 */
export const SAMPLE_COLUMNS = {
  temp_c: SINGLE_TAGS.tempC,
  target_temp_c: SINGLE_TAGS.targetTempC,
  humidity_pct: SINGLE_TAGS.humidityPct,
  co2_ppm: SINGLE_TAGS.co2Ppm,
  pressure_pa: SINGLE_TAGS.pressurePa,
  bird_count: SINGLE_TAGS.birdCount,
  bird_age_days: SINGLE_TAGS.birdAgeDays,
  feed_per_bird_g: SINGLE_TAGS.feedPerBirdG,
  water_per_bird_ml: SINGLE_TAGS.waterPerBirdMl,

  // The aggregates, and the per-line tags they are built from. Both are stored:
  // the aggregate is what gets read, the lines are what diagnoses it when a
  // silo sensor dies and the aggregate quietly drops by a quarter.
  silo_kg: METRIC_TAGS.siloKg.total,
  silo_kg_1: METRIC_TAGS.siloKg.lines[0],
  silo_kg_2: METRIC_TAGS.siloKg.lines[1],
  silo_kg_3: METRIC_TAGS.siloKg.lines[2],
  silo_kg_4: METRIC_TAGS.siloKg.lines[3],
  feed_kg: METRIC_TAGS.feedKg.total,
  feed_kg_1: METRIC_TAGS.feedKg.lines[0],
  feed_kg_2: METRIC_TAGS.feedKg.lines[1],
  feed_kg_3: METRIC_TAGS.feedKg.lines[2],
  feed_kg_4: METRIC_TAGS.feedKg.lines[3],
  water_l: METRIC_TAGS.waterL.total,
  water_l_1: METRIC_TAGS.waterL.lines[0],
  water_l_2: METRIC_TAGS.waterL.lines[1],
  water_l_3: METRIC_TAGS.waterL.lines[2],
  water_l_4: METRIC_TAGS.waterL.lines[3],

  // Worth keeping even though nothing plots them yet: they are what a vet or an
  // engineer asks for after the fact, and after the fact is too late.
  vent_level: "通风级别",
  vent_rate: "通风量",
  mortality_today: "新增死淘",
} as const;

/** The column order used by every insert and by the migration's pivot. */
export const SAMPLE_COLUMN_NAMES = Object.keys(SAMPLE_COLUMNS) as (keyof typeof SAMPLE_COLUMNS)[];

/** Tag name → the column it lands in. One tag, one column. */
export const COLUMN_OF_TAG: ReadonlyMap<string, string> = new Map(
  Object.entries(SAMPLE_COLUMNS).map(([column, tag]) => [tag, column]),
);

export const HISTORY_TAGS: ReadonlySet<string> = new Set(Object.values(SAMPLE_COLUMNS));

/** Is this reading one to keep beyond "the current value"? */
export const keepHistory = (tagId: string) => HISTORY_TAGS.has(nameOf(tagId));
