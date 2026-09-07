/**
 * The sidebar and the page registry must describe the same app.
 *
 * `shared/pages.ts` is what the role editor names when it says "ticking this
 * reveals these screens". If a menu entry drifts from it — a path moves, a
 * right changes, a page is added to one and not the other — the editor starts
 * lying about what a role grants, and nothing else notices, because both files
 * keep compiling perfectly well apart.
 *
 * Run: npx tsx scripts/check-pages.ts
 */
import { NAV } from "../client/src/nav";
import { APP_PAGES } from "../shared/pages";
import { PERMISSION_MODULES, actionsFor } from "../shared/permissions";

interface Flat {
  label: string;
  path: string;
  perm: string | null;
  anyPerm: string[] | null;
}

const flat: Flat[] = [];
for (const item of NAV) {
  if (item.path) {
    flat.push({
      label: item.label,
      path: item.path,
      perm: item.perm ? `${item.perm[0]}.${item.perm[1]}` : null,
      anyPerm: null,
    });
  }
  for (const child of item.children ?? []) {
    flat.push({
      label: child.label,
      path: child.path,
      perm: child.perm ? `${child.perm[0]}.${child.perm[1]}` : null,
      anyPerm: child.anyPerm ? child.anyPerm.map(([m, a]) => `${m}.${a}`) : null,
    });
  }
}

const problems: string[] = [];
const visible = APP_PAGES.filter((p) => !p.hidden);
const byPath = new Map(visible.map((p) => [p.path, p]));

for (const nav of flat) {
  const page = byPath.get(nav.path);
  if (!page) {
    problems.push(`Sidebar has "${nav.label}" (${nav.path}) with no entry in APP_PAGES.`);
    continue;
  }
  if (page.label !== nav.label) {
    problems.push(`"${nav.path}" is "${nav.label}" in the sidebar but "${page.label}" in APP_PAGES.`);
  }
  if (nav.anyPerm) {
    const registry = new Set((page.anyOf ?? []).map(([m, a]) => `${m}.${a}`));
    const missing = nav.anyPerm.filter((p) => !registry.has(p));
    const extra = [...registry].filter((p) => !nav.anyPerm!.includes(p));
    if (missing.length || extra.length) {
      problems.push(
        `"${nav.label}" anyPerm differs — sidebar only: [${missing}], registry only: [${extra}].`,
      );
    }
  } else if (nav.perm && nav.perm !== `${page.module}.${page.action}`) {
    problems.push(
      `"${nav.label}" needs ${nav.perm} in the sidebar but ${page.module}.${page.action} in APP_PAGES.`,
    );
  }
}

const navPaths = new Set(flat.map((f) => f.path));
for (const page of visible) {
  if (!navPaths.has(page.path)) {
    problems.push(`APP_PAGES has "${page.label}" (${page.path}) with no sidebar entry.`);
  }
}

// A page pointing at a right that does not exist reveals nothing, for ever.
const modules = new Set(PERMISSION_MODULES.map((m) => m.key));
for (const page of APP_PAGES) {
  for (const [module, action] of [
    [page.module, page.action] as const,
    ...(page.anyOf ?? []),
  ]) {
    if (!modules.has(module)) {
      problems.push(`"${page.label}" names module "${module}", which is not in PERMISSION_MODULES.`);
      continue;
    }
    if (!actionsFor(module).some((a) => a.key === action)) {
      problems.push(`"${page.label}" names ${module}.${action}, which that module does not define.`);
    }
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`OK — ${visible.length} pages, sidebar and registry agree.`);
