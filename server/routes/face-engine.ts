/**
 * The files the phone's face engine runs on (client/src/lib/face-engine.ts):
 * the two models and onnxruntime-web's WebAssembly runtime. Served from here
 * so a gate phone only ever talks to our own server.
 *
 * Only these three files, by name. Each URL the page asks for carries the
 * file's version (`?sha=` / `?v=`), so they are cached for a year; the page
 * also keeps them in Cache Storage.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { Router } from "express";
import { FACE_MODELS, type FaceModelName } from "@shared/face-engine";
import { modelBytes } from "../services/face-models";

export const faceEngineRouter = Router();

const YEAR = "public, max-age=31536000, immutable";

faceEngineRouter.get("/models/:file", async (req, res) => {
  const name = (Object.keys(FACE_MODELS) as FaceModelName[]).find((k) => FACE_MODELS[k].file === req.params.file);
  if (!name) return res.status(404).json({ error: "No such model" });
  try {
    const bytes = await modelBytes(name);
    res.set("Cache-Control", YEAR).type("application/octet-stream").send(bytes);
  } catch (e) {
    console.error("[faces] model unavailable:", e);
    res.status(503).json({ error: "The face engine's model could not be fetched. Punch by name for now." });
  }
});

/** onnxruntime-web's dist folder, wherever npm put it. */
const ortDist = path.dirname(createRequire(import.meta.url).resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"));
const RUNTIME_FILES = new Set(["ort-wasm-simd-threaded.wasm"]);

faceEngineRouter.get("/runtime/:file", (req, res) => {
  if (!RUNTIME_FILES.has(req.params.file)) return res.status(404).json({ error: "No such file" });
  res.set("Cache-Control", YEAR).type("application/wasm").sendFile(path.join(ortDist, req.params.file));
});
