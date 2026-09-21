/**
 * Where an open picker's list is drawn.
 *
 * Drawn in place, an absolutely positioned list is cropped by any box around
 * it that scrolls or hides overflow — a line grid that scrolls sideways, a
 * dialog body, a table cell in an overflow-x container — and the choice the
 * user is looking for sits under the edge. So the list is portalled out of
 * those boxes and fixed to the viewport, under its field, or above it when
 * there is not room below.
 *
 * Inside a dialog it is portalled into the dialog rather than the body: a
 * click on it must count as inside the dialog, or the dialog closes on it and
 * its focus trap refuses the search box. A dialog positioned with a transform
 * becomes the reference for `fixed`, so its own offset is taken off.
 */
import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

/** Tall enough for a search box and eight rows; below this, open upwards if that is roomier. */
const WANTED = 320;

export function useFloatingPanel(open: boolean, anchor: RefObject<HTMLElement | null>, minWidth = 288) {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current) {
      setStyle(null);
      return;
    }
    const el = anchor.current;
    const target = (el.closest('[role="dialog"]') as HTMLElement | null) ?? document.body;
    setHost(target);

    const place = () => {
      const r = el.getBoundingClientRect();
      let ox = 0;
      let oy = 0;
      if (target !== document.body && getComputedStyle(target).transform !== "none") {
        const h = target.getBoundingClientRect();
        ox = h.left;
        oy = h.top;
      }
      const width = Math.max(r.width, minWidth);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      const up = below < WANTED && above > below;
      setStyle({
        position: "fixed",
        zIndex: 60,
        left: left - ox,
        width,
        top: (up ? r.top - 4 : r.bottom + 4) - oy,
        transform: up ? "translateY(-100%)" : undefined,
      });
    };
    place();
    // Follow the field when anything scrolls or the window resizes.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, minWidth]);

  return { style, host };
}
