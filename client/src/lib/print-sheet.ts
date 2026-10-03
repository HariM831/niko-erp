/**
 * Print one element — a document's A4 sheet — and nothing else.
 *
 * `window.print()` prints the whole app. The sheet sits inside a split view,
 * a scrolling panel and a zoom fitted to the screen, and the browser prints
 * that layout as it stands: the panel clips the sheet to one screenful, and
 * whatever chrome a print rule missed comes out on paper beside it. A bill
 * saved as PDF came out as a strip of app with the bill cut off.
 *
 * So the sheet is copied, with the page's own stylesheets, into a hidden
 * frame holding nothing else, and that frame is printed. What is on paper is
 * then exactly the sheet as it looks on screen, at A4, over as many pages as
 * it runs to. The frame's title becomes the PDF's suggested file name.
 */
export async function printSheet(el: HTMLElement, title: string): Promise<void> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);

  const doc = frame.contentDocument!;
  const styles = [...document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')]
    .map((n) => n.outerHTML)
    .join("\n");
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  doc.open();
  doc.write(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<base href="${escape(location.origin)}/">
<title>${escape(title)}</title>
${styles}
<style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* The screen's fit-to-width zoom, frame and shadow are not the document. */
  .a4-sheet { zoom: 1 !important; width: 210mm !important; margin: 0 !important; border: 0 !important; box-shadow: none !important; }
</style>
</head><body>${el.outerHTML}</body></html>`);
  doc.close();

  // Stylesheets and web fonts must be in before printing, or the PDF comes
  // out in the fallback font with the layout unstyled.
  await Promise.all(
    [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
      (l) =>
        new Promise<void>((resolve) => {
          if (l.sheet) return resolve();
          l.addEventListener("load", () => resolve(), { once: true });
          l.addEventListener("error", () => resolve(), { once: true });
          setTimeout(resolve, 3000);
        }),
    ),
  );
  try {
    await doc.fonts?.ready;
  } catch {
    // A font that never loads is not a reason not to print.
  }
  await Promise.all(
    [...doc.images].map((img) =>
      img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000); }),
    ),
  );

  const win = frame.contentWindow!;
  const cleanup = () => setTimeout(() => frame.remove(), 500);
  win.addEventListener("afterprint", cleanup, { once: true });
  win.focus();
  win.print();
  // Chrome's print() returns once the dialog closes; afterprint is the backstop.
  setTimeout(() => frame.isConnected && frame.remove(), 60_000);
}
