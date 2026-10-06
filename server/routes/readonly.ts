/**
 * Read-only house figures for a script or assistant, by bearer token.
 *
 * The alternative was opening Postgres to the internet so an off-site reader
 * could query it. The cluster's Trusted Sources stay the Droplet alone; what
 * leaves is these few answers, over the same HTTPS as the screens.
 *
 * The rules that keep it narrow:
 *
 *  - GET only, and only the routes below. Nothing here writes, and nothing
 *    proxies on to the rest of /api: the token is not a session.
 *  - The server holds the token's SHA-256, never the token. A leaked
 *    prod.env does not hand anyone a working token.
 *  - With NIKO_READ_TOKEN_SHA256 unset the whole router answers 404, so it
 *    is off until someone deliberately switches it on, and switched off again
 *    by deleting the line and restarting.
 *
 * Mounted outside requireAuth: the caller has no cookie, only the token.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import { db } from "../db";
import { dayBoard } from "../services/daily";
import { housesBoard } from "../services/houses-board";
import { houseDetail } from "../services/house-detail";
import { istDate } from "../services/day-resolution";
import { farmStatus } from "./iot";

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();

/**
 * Does this Authorization header carry the token whose hash is configured?
 * Pure, so scripts/check-read-token.ts can drive it without HTTP.
 */
export function checkReadToken(
  authorization: string | undefined,
  configuredHashHex: string | undefined,
): "off" | "ok" | "denied" {
  const want = (configuredHashHex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return "off";
  const auth = authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  // A short token is refused outright: this is meant for `openssl rand -hex 32`.
  if (token.length < 32) return "denied";
  return crypto.timingSafeEqual(sha256(token), Buffer.from(want, "hex")) ? "ok" : "denied";
}

function requireReadToken(req: Request, res: Response, next: NextFunction) {
  const verdict = checkReadToken(req.headers.authorization, process.env.NIKO_READ_TOKEN_SHA256);
  // Off looks exactly like a route that does not exist.
  if (verdict === "off") return res.status(404).json({ error: "No such endpoint" });
  if (verdict === "denied") {
    console.warn(`[readonly] refused ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: "Bad or missing read token" });
  }
  if (req.method !== "GET") return res.status(405).json({ error: "Read only" });
  res.set("Cache-Control", "no-store");
  next();
}

export const readonlyRouter = Router();
readonlyRouter.use(requireReadToken);

/** Every shed's verdict now and how its last 24 hours went — the IoT status screen. */
readonlyRouter.get("/houses/status", async (_req, res) => {
  res.json(await farmStatus());
});

/** Every open house on a day with what was recorded for it (default: today, IST). */
readonlyRouter.get("/houses/daily", async (req, res) => {
  const day = (req.query.date as string) || istDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(422).json({ error: "Use a YYYY-MM-DD date" });
  }
  res.json(await db.transaction((tx) => dayBoard(tx, day)));
});

/** The Houses screen: every house with its flock and running figures. */
readonlyRouter.get("/houses/board", async (_req, res) => {
  res.json(await db.transaction((tx) => housesBoard(tx)));
});

/** One house's page. */
readonlyRouter.get("/houses/:id/detail", async (req, res) => {
  const out = await db.transaction((tx) => houseDetail(tx, req.params.id!));
  if (!out) return res.status(404).json({ error: "House not found" });
  res.json(out);
});
