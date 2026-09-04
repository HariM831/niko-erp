/**
 * How often the gate fails to recognise a face, printed now.
 *
 * Reads only. The answer is already in the punch rows — a guard picks a name
 * off the list only when the camera missed, so `method = 'manual'` is the
 * failure rate — and until this existed nobody had ever read it.
 *
 * Run: npx tsx scripts/report-face-scans.ts [days]
 */
import { buildFaceHealth, formatFaceHealth } from "../server/services/face-health";
import { db, pool } from "../server/db";

const days = Number(process.argv[2]) || 30;
const report = await buildFaceHealth(db, days);
console.log(formatFaceHealth(report));
await pool.end();
