#!/usr/bin/env node
/**
 * The cabin's camera relay.
 *
 * niko is served over HTTPS from a droplet; the cameras are plain HTTP on the
 * farm LAN behind digest auth. A browser cannot bridge that, and the reasons
 * are not going to soften: an HTTPS page may not fetch http://, the cameras
 * send no CORS headers, an <img> tag cannot do digest, and no browser plays
 * RTSP. Every one of those is fatal on its own.
 *
 * So this sits between them. It runs on the weighbridge desktop, fetches
 * snapshots from the cameras over the LAN — server to server, where none of
 * the browser's rules apply — and hands them to the page on localhost, which
 * IS reachable from an HTTPS origin because 127.0.0.1 counts as a trustworthy
 * origin in its own right.
 *
 * It must run on the SAME machine as the browser. A relay on another LAN
 * address is http://192.168.x.x to the page, which lands back under the
 * mixed-content rule this exists to escape.
 *
 * No dependencies. Node 18 or newer:
 *
 *     node weighbridge-cameras.mjs
 *
 * Open http://127.0.0.1:9099/ in a browser on that machine to see what every
 * camera is looking at — which is the first thing worth knowing, because a
 * number plate is legible or not because of where the camera points and what
 * lens is on it, far more than how many pixels it has.
 */
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 9099);

/**
 * Origins allowed to ask for a picture.
 *
 * Named rather than "*", because this service holds camera passwords and
 * answers from inside the farm's network. Any page the operator happens to
 * have open should not be able to photograph the yard.
 */
const ALLOWED_ORIGINS = new Set([
  "https://aminofarms.com",
  "https://staging.aminofarms.com",
]);

/**
 * Plus any page served from this same desktop, on whatever port a dev server
 * happened to take. Not a widening of much: anything already running here can
 * read cameras.json off the disk, so refusing it a JPEG protects nothing.
 */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const allowed = (origin) => ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin);

let cameras = [];
try {
  cameras = JSON.parse(readFileSync(join(HERE, "cameras.json"), "utf8")).cameras ?? [];
} catch {
  console.error(
    "No cameras.json beside this script. Copy cameras.example.json to cameras.json and fill it in.",
  );
  process.exit(1);
}

const md5 = (s) => createHash("md5").update(s).digest("hex");

/**
 * One HTTP GET, with digest auth if the camera asks for it.
 *
 * Hikvision and most of its imitators answer the first request with a 401 and
 * a nonce, and expect the credentials hashed against it. Basic is accepted as
 * a fallback because some older cameras only speak that.
 */
function fetchSnapshot(cam) {
  const opts = {
    host: cam.host,
    port: cam.port ?? 80,
    path: cam.path ?? "/ISAPI/Streaming/channels/101/picture",
    method: "GET",
    timeout: cam.timeoutMs ?? 8000,
  };

  const once = (headers) =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ ...opts, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on("timeout", () => req.destroy(new Error("The camera did not answer in time")));
      req.on("error", reject);
      req.end();
    });

  return (async () => {
    let res = await once({ Accept: "image/jpeg" });
    if (res.status !== 401) return res;

    const challenge = String(res.headers["www-authenticate"] ?? "");
    if (/^Basic/i.test(challenge)) {
      const basic = Buffer.from(`${cam.user}:${cam.password}`).toString("base64");
      return once({ Accept: "image/jpeg", Authorization: `Basic ${basic}` });
    }

    const field = (name) =>
      new RegExp(`${name}="?([^",]+)"?`).exec(challenge)?.[1] ?? "";
    const realm = field("realm");
    const nonce = field("nonce");
    const qop = field("qop");
    const opaque = field("opaque");
    const cnonce = randomBytes(8).toString("hex");
    const nc = "00000001";

    const ha1 = md5(`${cam.user}:${realm}:${cam.password}`);
    const ha2 = md5(`GET:${opts.path}`);
    const response = qop
      ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
      : md5(`${ha1}:${nonce}:${ha2}`);

    const auth =
      `Digest username="${cam.user}", realm="${realm}", nonce="${nonce}", ` +
      `uri="${opts.path}", response="${response}"` +
      (qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : "") +
      (opaque ? `, opaque="${opaque}"` : "");

    return once({ Accept: "image/jpeg", Authorization: auth });
  })();
}

/**
 * Network failures as something a person in a cabin can act on.
 *
 * "connect ECONNREFUSED 192.168.1.65:80" is precise and useless to the operator
 * who has to decide whether to go and look at the camera or carry on weighing.
 */
function plainly(e, cam) {
  const code = e && typeof e === "object" ? e.code : undefined;
  const where = `${cam.host}:${cam.port ?? 80}`;
  if (code === "ECONNREFUSED") return `Nothing is answering at ${where} — is the camera powered on?`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH")
    return `Cannot reach ${where} — check the camera is on this network.`;
  if (code === "ETIMEDOUT" || /timed? out/i.test(String(e?.message)))
    return `${where} did not answer in time.`;
  if (code === "ENOTFOUND") return `No such address as ${cam.host}.`;
  return e instanceof Error ? e.message : "Could not reach the camera";
}

/**
 * CORS, plus the header Chrome demands before a public page may touch a
 * private address at all. Without `Access-Control-Allow-Private-Network` the
 * preflight fails and the page never gets as far as asking for a picture.
 */
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/cameras") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Names and labels only. The passwords stay in this process.
    return res.end(
      JSON.stringify({
        cameras: cameras.map((c) => ({ name: c.name, label: c.label ?? c.name })),
      }),
    );
  }

  const shot = /^\/snapshot\/(.+)$/.exec(url.pathname);
  if (shot) {
    const cam = cameras.find((c) => c.name === decodeURIComponent(shot[1]));
    if (!cam) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "No camera by that name" }));
    }
    try {
      const out = await fetchSnapshot(cam);
      if (out.status !== 200) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: `The camera answered ${out.status}${
              out.status === 401 ? " — check the username and password" : ""
            }`,
          }),
        );
      }
      res.writeHead(200, {
        "Content-Type": out.headers["content-type"] ?? "image/jpeg",
        "Cache-Control": "no-store",
      });
      return res.end(out.body);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: plainly(e, cam) }));
    }
  }

  // A page to point a browser at, so "is this camera any good" is one click.
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta charset="utf-8">
<title>Weighbridge cameras</title>
<style>body{font:14px system-ui;margin:24px;background:#f7f7f8}
h1{font-size:18px}figure{margin:0 0 24px}img{max-width:100%;border:1px solid #ddd;background:#fff}
figcaption{color:#666;margin:6px 0}button{font:inherit;padding:4px 10px}</style>
<h1>Weighbridge cameras</h1>
<p>Serving ${cameras.length} camera(s) on port ${PORT}. Look at a number plate in
these before deciding anything — legibility is about where the camera points and
what lens it has, not how many pixels it claims.</p>
${cameras
  .map(
    (c) => `<figure>
<figcaption><strong>${c.label ?? c.name}</strong> — ${c.host}:${c.port ?? 80}
<button onclick="document.getElementById('i-${c.name}').src='/snapshot/${encodeURIComponent(
      c.name,
    )}?t='+Date.now()">Refresh</button></figcaption>
<img id="i-${c.name}" src="/snapshot/${encodeURIComponent(c.name)}" alt="no image">
</figure>`,
  )
  .join("\n")}`);
  }

  res.writeHead(404).end();
});

// Bound to loopback only. Nothing outside this desktop can ask it for a
// picture, which matters for a service holding camera passwords.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Weighbridge cameras on http://127.0.0.1:${PORT}`);
  console.log(`  ${cameras.length} camera(s): ${cameras.map((c) => c.name).join(", ") || "none"}`);
  console.log(`  Open http://127.0.0.1:${PORT}/ to see what each one is looking at.`);
});
