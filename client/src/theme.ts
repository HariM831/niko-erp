export type Accent = "yolk" | "crimson";

const KEY = "niko.accent";

export function getAccent(): Accent {
  return localStorage.getItem(KEY) === "crimson" ? "crimson" : "yolk";
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

/** Yolk is the default the stylesheet already defines, so it carries no attribute. */
export function applyAccent(accent: Accent) {
  const root = document.documentElement;
  if (accent === "crimson") root.setAttribute("data-accent", "crimson");
  else root.removeAttribute("data-accent");
}
