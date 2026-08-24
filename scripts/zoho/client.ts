/**
 * A read-only client for the Zoho Books API, used to migrate the live books
 * into niko.
 *
 * Three things this has to survive, because the pull runs for an hour or more
 * unattended: access tokens expire after an hour, the API rate-limits, and a
 * transient 5xx should not lose an hour of work. All three are handled here so
 * the scripts on top can be written as if the network were reliable.
 *
 * Nothing here writes to Zoho. There is no POST, PATCH or DELETE in this file
 * and there should never be one — the live books stay the system of record
 * until cutover.
 */

try {
  process.loadEnvFile();
} catch {
  /* no .env file — variables may come from the environment instead */
}

/** India data centre. The `.com` hosts in most documentation are wrong for this org. */
const ACCOUNTS_HOST = "https://accounts.zoho.in";
const API_HOST = "https://www.zohoapis.in/books/v3";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Add it to .env — see scripts/zoho/README or ask for the setup steps.`,
    );
  }
  return v;
}

export const ORG_ID = () => required("ZOHO_ORG_ID");

// ---------- Access tokens ----------

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Exchange the refresh token for an access token, reusing the current one until
 * it is nearly expired. Refreshed a minute early: a token that expires while a
 * request is in flight would fail a page in the middle of a long pull.
 */
async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const params = new URLSearchParams({
    refresh_token: required("ZOHO_REFRESH_TOKEN"),
    client_id: required("ZOHO_CLIENT_ID"),
    client_secret: required("ZOHO_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });

  // Retried for the same reason the API calls are: this runs mid-pull, once an
  // hour, and a momentary network fault here would end the run.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token?${params}`, { method: "POST" });
      break;
    } catch (err) {
      if (attempt === 5) throw new Error(`Token refresh unreachable: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }

  const body = (await res!.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!res!.ok || !body.access_token) {
    // Zoho answers 200 with an error body for bad credentials, so the status
    // alone is not enough to go on.
    throw new Error(
      `Could not get an access token: ${body.error ?? res!.statusText}. ` +
        `Check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN in .env, ` +
        `and that the self-client was created in the .in data centre.`,
    );
  }

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
  };
  return cachedToken.value;
}

// ---------- Throttled, retrying GET ----------

const MIN_GAP_MS = 700; // Comfortably inside Zoho's per-minute allowance.
let lastCall = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pace() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

export interface ZohoError extends Error {
  status?: number;
  zohoCode?: number;
}

/**
 * GET a Books endpoint. `path` is relative, e.g. "invoices" or "invoices/123".
 *
 * Retries rate limits and server errors with a widening backoff; a 401 refreshes
 * the token once and tries again. Anything else — a 404, a bad request — is
 * raised immediately, because retrying will not fix it.
 */
async function zohoFetch(
  path: string,
  params: Record<string, string | number> = {},
  attempt = 0,
): Promise<Response> {
  await pace();

  const query = new URLSearchParams({ organization_id: ORG_ID() });
  for (const [k, v] of Object.entries(params)) query.set(k, String(v));

  let res: Response;
  try {
    res = await fetch(`${API_HOST}/${path}?${query}`, {
      headers: { Authorization: `Zoho-oauthtoken ${await accessToken()}` },
    });
  } catch (err) {
    // A dropped socket, a DNS blip, a reset connection. These surface as a
    // thrown TypeError with no status, so the checks below never see them —
    // which is how an eight-thousand-request pull died at request 3,000 with
    // "fetch failed". Transient by nature, so they get the same backoff, with
    // more attempts than an HTTP error because the cause is usually momentary.
    if (attempt < 8) {
      const backoff = Math.min(2000 * 2 ** attempt, 60_000);
      console.warn(
        `  network error on ${path} (${(err as Error).message}) — retrying in ${backoff / 1000}s`,
      );
      await sleep(backoff);
      return zohoFetch(path, params, attempt + 1);
    }
    throw new Error(`GET ${path}: network unreachable after ${attempt} retries`);
  }

  if (res.status === 401 && attempt === 0) {
    cachedToken = null;
    return zohoFetch(path, params, attempt + 1);
  }

  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const backoff = 2000 * 2 ** attempt;
    console.warn(`  ${res.status} on ${path} — retrying in ${backoff / 1000}s`);
    await sleep(backoff);
    return zohoFetch(path, params, attempt + 1);
  }

  return res;
}

export async function zohoGet<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const res = await zohoFetch(path, params);

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    code?: number;
    message?: string;
  };

  if (!res.ok) {
    const err = new Error(
      `GET ${path} failed: ${res.status} ${body.message ?? res.statusText}`,
    ) as ZohoError;
    err.status = res.status;
    err.zohoCode = body.code;
    throw err;
  }
  return body as T;
}

/**
 * The bytes behind an attachment, rather than a JSON body.
 *
 * Shares the pacing, backoff and token refresh above, because a run fetching
 * three thousand files needs them more than a run fetching a few hundred pages.
 * A failure still answers in JSON even on a file endpoint, so the error path
 * reads the body the same way.
 */
export async function zohoGetFile(
  path: string,
  params: Record<string, string | number> = {},
): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await zohoFetch(path, params);

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
    const err = new Error(
      `GET ${path} failed: ${res.status} ${body.message ?? res.statusText}`,
    ) as ZohoError;
    err.status = res.status;
    err.zohoCode = body.code;
    throw err;
  }

  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!,
  };
}

// ---------- Paging ----------

interface PageContext {
  page: number;
  per_page: number;
  has_more_page: boolean;
  total?: number;
}

/**
 * Every record from a list endpoint, a page at a time.
 *
 * Yielded page by page rather than returned as one array so a caller can write
 * each page to disk as it arrives — a pull that dies at record 4,000 should not
 * lose the first 3,999.
 */
export async function* zohoPages<T = Record<string, unknown>>(
  path: string,
  collection: string,
  params: Record<string, string | number> = {},
): AsyncGenerator<{ page: number; records: T[]; hasMore: boolean }> {
  let page = 1;
  for (;;) {
    const body = await zohoGet<Record<string, unknown>>(path, {
      ...params,
      page,
      per_page: 200,
    });
    const records = (body[collection] ?? []) as T[];
    const ctx = (body.page_context ?? {}) as PageContext;
    const hasMore = Boolean(ctx.has_more_page);

    yield { page, records, hasMore };
    if (!hasMore || records.length === 0) return;
    page += 1;
  }
}
