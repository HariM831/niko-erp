/**
 * Is this screen running the code the server is handing out now?
 *
 * A screen keeps the code it loaded until somebody reloads it, and a gate
 * phone sits on one page all day. On 26 Sep 2026 the fix for the gate
 * offering IN to people already inside shipped at 17:24, and at 18:28 the
 * phones were still on the old code — the server refused each wrong IN, and
 * the old screen offered IN again. The server says which build it serves
 * (GET /api/version, the hashed main script); this compares it with the
 * script this page was loaded from.
 */
import { useQuery } from "@tanstack/react-query";

/** The main script this page loaded — "dev" under the dev server, which serves source. */
const loadedBuild = (() => {
  const src = document.querySelector('script[type="module"][src^="/assets/"]')?.getAttribute("src");
  return src ?? "dev";
})();

export function useAppOutdated(): boolean {
  const q = useQuery({
    queryKey: ["app-version"],
    queryFn: async () => {
      const r = await fetch("/api/version", { cache: "no-store" });
      if (!r.ok) throw new Error(`version ${r.status}`);
      return (await r.json()) as { build: string };
    },
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const served = q.data?.build;
  // "unknown" is a server that could not read its own page: no evidence either way.
  return !!served && served !== "unknown" && loadedBuild !== "dev" && served !== loadedBuild;
}
