/**
 * Read back the text a generated PDF will actually show.
 *
 * The statements are built on the server and nobody sees them before they are
 * attached to a posted document, so "it produced a file" is not evidence that
 * it produced a readable one. This inflates the content streams and prints the
 * text-showing operators, which is what the page will really display.
 *
 *   npx tsx scripts/read-pdf-text.ts "tmp-statements/Luit ... feed.pdf"
 */
import { inflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) {
  console.log("\n  give me a path to a PDF\n");
  process.exit(1);
}

const buf = await readFile(file);
const raw = buf.toString("latin1");

let content = "";
let at = 0;
for (;;) {
  const s = raw.indexOf("stream", at);
  if (s === -1) break;
  const e = raw.indexOf("endstream", s);
  if (e === -1) break;
  const body = raw.slice(s + 6, e).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  try {
    content += inflateSync(Buffer.from(body, "latin1")).toString("latin1");
  } catch {
    // Not a Flate stream — an uncompressed one, or a font. Take it as it is.
    content += body;
  }
  at = e + 9;
}

/**
 * PDFKit writes each line as a kerned array of HEX strings:
 *
 *     [<536f6c642062> 20 <79202f20746f> 0] TJ
 *
 * so the readable text is the hex chunks of one array joined back together.
 * Literal "(text) Tj" is handled too, since that is what most other producers
 * emit and this script is worth pointing at a PDF from anywhere.
 */
const runs: string[] = [];
for (const m of content.matchAll(/\[((?:\s*(?:<[0-9A-Fa-f]*>|-?[\d.]+))*)\s*\]\s*TJ/g)) {
  const line = [...m[1]!.matchAll(/<([0-9A-Fa-f]*)>/g)]
    .map((h) => Buffer.from(h[1]!, "hex").toString("latin1"))
    .join("");
  if (line.trim()) runs.push(line);
}
for (const m of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
  const line = m[1]!.replace(/\\([()\\])/g, "$1");
  if (line.trim()) runs.push(line);
}

console.log(`\n  ${file}`);
console.log(`  ${buf.length} bytes · ${runs.length} text runs\n`);
for (const r of runs) console.log(`  ${r}`);
console.log("");
process.exit(0);
