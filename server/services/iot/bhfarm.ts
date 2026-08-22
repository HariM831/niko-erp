/**
 * The Big Herdsman client (bhfarm.net).
 *
 * Talks to the controllers in the sheds: discovers which houses exist, which
 * tags each reports, and reads their current and historical values. It knows
 * nothing about EGGSY — no database, no houses table — so it can be pointed at
 * the vendor and checked on its own.
 *
 * The tag knowledge here is not guesswork. It is carried over from the Amino
 * integration that has been running against this farm for a year, and the two
 * exclusions below were each found the hard way:
 *
 *   · Some tag categories exist in every controller template but have no
 *     hardware behind them on this farm — a weather station, a bird scale, an
 *     automatic egg counter, a power meter. They answer the API with nulls
 *     forever, and polling them writes dead rows every five minutes.
 *
 *   · On 2026-07-16 Big Herdsman renamed the feed and water family, replacing
 *     the unnumbered tags with per-line and aggregate variants. The old names
 *     STILL ANSWER — with the value they held on the day of the rename. House 3
 *     read a silo weight of 17,078 kg against a true 10,788 for weeks. They are
 *     excluded rather than preferred, because a stale number that looks fresh
 *     is worse than a missing one.
 *
 * Configuration, all optional except the token:
 *   BH_TOKEN     the bearer token from bhfarm.net (raw JWT or "Bearer <jwt>")
 *   BH_TENANT    tenant header
 *   BH_FARM_ID   farm override; discovered when absent
 *   BH_TIMEZONE  offset sent to the API (default "+05:30")
 *   BH_TAG_CHUNK max tag ids per request (default 300)
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
 *
 * Matched on the exact leaf so the numbered successors are not caught: it is
 * "料塔实时重量" that is dead, not "料塔实时重量1".
 */
const FROZEN_LEGACY_TAGS = new Set([
  "基础数据.水料量.料塔实时重量",
  "基础数据.水料量.料塔本日累加料",
  "基础数据.水料量.今日用料量",
  "基础数据.水料量.今日用水量",
]);

/** Categories with no hardware behind them on this farm. */
function isDeadTag(leaf: string): boolean {
  return (
    leaf.startsWith("基础数据.气象站.") || // weather station — not installed
    leaf.includes("鸡称") || //               bird scale — not installed
    leaf.startsWith("基础数据.数量.") || //    automatic egg count — none
    leaf.startsWith("其他数据.电能.") || //    energy metering — no meter
    FROZEN_LEGACY_TAGS.has(leaf)
  );
}

/**
 * Each of these resolves as the aggregate tag first, else the sum of the
 * per-line tags. There is deliberately NO fallback to the unnumbered name: a
 * missing value must read as null, never as the value it held in July.
 */
export const METRIC_TAGS = {
  siloKg: { total: "料塔当前总料量", lines: ["料塔实时重量1", "料塔实时重量2", "料塔实时重量3", "料塔实时重量4"] },
  feedKg: { total: "今日总用料量", lines: ["今日用料量1", "今日用料量2", "今日用料量3", "今日用料量4"] },
  waterL: { total: "今日总用水量", lines: ["今日用水量1", "今日用水量2", "今日用水量3", "今日用水量4"] },
} as const;

/** The single-value tags worth naming, so the rollup is not a wall of Chinese. */
export const SINGLE_TAGS = {
  tempC: "基础数据.温度.当前温度",
  targetTempC: "基础数据.温度.目标温度",
  humidityPct: "基础数据.湿度.当前湿度",
  co2Ppm: "工艺数据.气体.CO2",
  pressurePa: "基础数据.负压.当前负压",
  birdCount: "基础数据.鸡只数量.剩余数量",
  birdAgeDays: "基础数据.日龄.当前日龄",
  feedPerBirdG: "基础数据.只鸡数据.只鸡耗料量",
  waterPerBirdMl: "基础数据.只鸡数据.只鸡饮水量",
} as const;

export interface BhDevice {
  deviceId: string;
  houseName: string;
  online: boolean;
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

function token(): string {
  const raw = process.env.BH_TOKEN?.trim();
  if (!raw) throw new BhError("BH_TOKEN is not set — nothing can be read from bhfarm.net");
  return raw.toLowerCase().startsWith("bearer ") ? raw : `Bearer ${raw}`;
}

/**
 * When the token dies.
 *
 * Read out of the JWT rather than configured, because a token that has quietly
 * expired looks exactly like a farm with no sensors. The expiry is worth
 * surfacing long before it arrives.
 */
export function tokenExpiry(): Date | null {
  const raw = process.env.BH_TOKEN?.replace(/^bearer\s+/i, "").trim();
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token(),
      TenantId: process.env.BH_TENANT ?? DEFAULT_TENANT,
      TimeZone: process.env.BH_TIMEZONE ?? "+05:30",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BhError(`bhfarm ${res.status} on ${url.replace(BASE, "")}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

let farmIdCache: string | null = null;

export async function discoverFarmId(): Promise<string> {
  if (process.env.BH_FARM_ID) return process.env.BH_FARM_ID;
  if (farmIdCache) return farmIdCache;
  const r = await post<{ data?: Array<{ id?: string; farmId?: string }> }>(EP.farmList, {});
  const id = r.data?.[0]?.id ?? r.data?.[0]?.farmId;
  if (!id) throw new BhError("bhfarm returned no farm for this account");
  farmIdCache = id;
  return id;
}

/** Which houses the account can see, and whether each is talking. */
export async function discoverDevices(): Promise<BhDevice[]> {
  const farmId = await discoverFarmId();
  const r = await post<{
    data?: Array<{ deviceId?: string; deviceCode?: string; houseName?: string; name?: string; online?: boolean; isOnline?: boolean }>;
  }>(EP.houseList, { farmId });
  return (r.data ?? [])
    .map((h) => ({
      deviceId: h.deviceId ?? h.deviceCode ?? "",
      houseName: h.houseName ?? h.name ?? "",
      online: h.online ?? h.isOnline ?? false,
    }))
    .filter((d) => d.deviceId);
}

/**
 * Every tag one device reports, minus the ones known to be dead.
 *
 * Discovered rather than listed: the controller template runs to several
 * hundred tags and a hand-kept list goes stale the first time the vendor adds
 * one — which is exactly how the July rename went unnoticed.
 */
export async function discoverTags(deviceId: string): Promise<string[]> {
  const farmId = await discoverFarmId();
  const r = await post<{
    data?: Array<{ children?: unknown[]; name?: string; tagName?: string; fullName?: string }>;
  }>(EP.tagTree, { farmId, deviceId });

  const leaves: string[] = [];
  const walk = (nodes: unknown[], trail: string[]) => {
    for (const raw of nodes) {
      const n = raw as { children?: unknown[]; name?: string; tagName?: string };
      const label = n.tagName ?? n.name ?? "";
      if (!label) continue;
      if (n.children?.length) walk(n.children, [...trail, label]);
      else leaves.push([...trail, label].join("."));
    }
  };
  walk(r.data ?? [], []);

  return leaves.filter((leaf) => !isDeadTag(leaf)).map((leaf) => `${deviceId}.${leaf}`);
}

const CHUNK = () => Number(process.env.BH_TAG_CHUNK ?? 300);

/** Current values. Chunked, because the endpoint refuses very long tag lists. */
export async function fetchCurrentValues(tagIds: string[]): Promise<BhTagValue[]> {
  const out: BhTagValue[] = [];
  for (let i = 0; i < tagIds.length; i += CHUNK()) {
    const slice = tagIds.slice(i, i + CHUNK());
    const r = await post<{
      data?: Array<{ tagId?: string; id?: string; value?: unknown; quality?: number; unit?: string }>;
    }>(EP.currentValues, { tagIdList: slice });
    for (const row of r.data ?? []) {
      const tagId = row.tagId ?? row.id;
      if (!tagId) continue;
      out.push({
        tagId,
        value: row.value == null ? null : String(row.value),
        quality: row.quality ?? 0,
        unit: row.unit ?? guessUnit(tagId),
      });
    }
  }
  return out;
}

/**
 * The vendor's OWN stored history.
 *
 * This is the endpoint the six-week window is about: it is the only way to get
 * at readings from before EGGSY started polling, and it stops answering for
 * anything older than roughly six weeks.
 */
export async function fetchHistory(opts: {
  deviceId: string;
  tagIds: string[];
  from: string;
  to: string;
}): Promise<BhTagValue[]> {
  const out: BhTagValue[] = [];
  for (let i = 0; i < opts.tagIds.length; i += CHUNK()) {
    const slice = opts.tagIds.slice(i, i + CHUNK());
    const r = await post<{
      data?: Array<{
        tagId?: string;
        id?: string;
        dataList?: Array<{ time?: string; dateTime?: string; value?: unknown; quality?: number }>;
      }>;
    }>(EP.history, {
      deviceId: opts.deviceId,
      tagIdList: slice,
      startTime: opts.from,
      endTime: opts.to,
    });
    for (const row of r.data ?? []) {
      const tagId = row.tagId ?? row.id;
      if (!tagId) continue;
      for (const p of row.dataList ?? []) {
        const at = p.time ?? p.dateTime;
        if (!at) continue;
        out.push({
          tagId,
          value: p.value == null ? null : String(p.value),
          quality: p.quality ?? 0,
          unit: guessUnit(tagId),
          recordedAt: at,
        });
      }
    }
  }
  return out;
}

/** The controller does not send units, so they are inferred from the tag. */
function guessUnit(tagId: string): string {
  if (tagId.includes(".CO2")) return "ppm";
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

/** The leaf of a tag id — everything after the device. */
export const leafOf = (tagId: string) => tagId.split(".").slice(1).join(".");
/** The last segment, which is what the metric maps are keyed on. */
export const nameOf = (tagId: string) => tagId.split(".").pop() ?? "";
