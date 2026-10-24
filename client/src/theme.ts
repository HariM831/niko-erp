/**
 * Yolk is the palette the stylesheet defines on :root, so it is the one
 * accent that carries no attribute. Every other name here must have a
 * matching [data-accent="..."] block in index.css.
 */
export const ACCENTS = ["yolk", "crimson", "niko", "terracotta", "forest", "teal", "indigo"] as const;

export type Accent = (typeof ACCENTS)[number];

// What a user who never chose sees (Niko red since 24 Oct 2026). index.html
// carries the same name for the first paint.
export const DEFAULT_ACCENT: Accent = "niko";

const KEY = "niko.accent";

export function isAccent(v: string | null | undefined): v is Accent {
  return !!v && (ACCENTS as readonly string[]).includes(v);
}

export function getAccent(): Accent {
  const stored = localStorage.getItem(KEY);
  // Anything unrecognised (an older build's name, a hand-edited value) falls
  // back rather than leaving the app with an accent that has no CSS behind it.
  return isAccent(stored) ? stored : DEFAULT_ACCENT;
}

export function setAccent(accent: Accent) {
  localStorage.setItem(KEY, accent);

  // Chrome won't re-resolve a transitioned property when the custom property
  // behind it changes, so every element carrying `transition` (most buttons
  // and nav items here) would keep the old accent until it next repainted for
  // some other reason. Suppressing transitions across the swap forces them all
  // to take the new colour at once.
  const root = document.documentElement;
  root.classList.add("accent-swapping");
  applyAccent(accent);
  void root.offsetWidth;
  requestAnimationFrame(() => root.classList.remove("accent-swapping"));
}

export function applyAccent(accent: Accent) {
  const root = document.documentElement;
  if (accent === "yolk") root.removeAttribute("data-accent");
  else root.setAttribute("data-accent", accent);
}
