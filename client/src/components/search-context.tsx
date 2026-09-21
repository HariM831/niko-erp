import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Which list the top bar is searching.
 *
 * Zoho puts the search box in the top bar and points it at whatever list is
 * open — "Search in Bills" on Bills, "Search in Invoices" on Invoices. The box
 * therefore lives far away from the list it searches, so the list registers
 * itself here on mount and the top bar reads it back.
 *
 * The term lives here too rather than in the list. Both ends need it — the top
 * bar to show it, the list to filter by it — and one owner avoids the two
 * copies drifting apart.
 */
export interface SearchConfig {
  /** Plural module name, e.g. "Bills". */
  title: string;
  endpoint: string;
  /** Params for the active saved view, so the preview respects it. */
  params?: Record<string, string>;
  rowPath?: (row: Record<string, unknown>) => string;
  onOpen?: (row: Record<string, unknown>) => void;
  /**
   * Filter the list with every key pressed instead of previewing ten rows and
   * waiting for Enter. For lists of names, where the eye scans by first
   * letters: A, then Ag, then Agr, the list narrowing each time.
   */
  live?: boolean;
}

interface SearchContextValue {
  config: SearchConfig | null;
  register: (config: SearchConfig | null) => void;
  term: string;
  setTerm: (term: string) => void;
}

const SearchContext = createContext<SearchContextValue>({
  config: null,
  register: () => {},
  term: "",
  setTerm: () => {},
});

export function SearchProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SearchConfig | null>(null);
  const [term, setTerm] = useState("");

  // Registering is how a list says "I am what the box searches now". Moving
  // from Bills to Invoices clears the term with it — carrying a bill number
  // over to the invoice list would silently show nothing.
  //
  // The same list registering again keeps it: Vendors hands over to a vendor's
  // page, whose left rail is the same list, and a filter typed on one should
  // still hold on the other. Leaving a list unregisters it first, so the term
  // is only dropped once nothing has claimed the box by the next tick.
  const last = useRef<string | null>(null);
  const pendingClear = useRef<ReturnType<typeof setTimeout> | null>(null);
  const register = useCallback((next: SearchConfig | null) => {
    setConfig(next);
    if (pendingClear.current) clearTimeout(pendingClear.current);
    pendingClear.current = null;
    if (!next) {
      pendingClear.current = setTimeout(() => {
        last.current = null;
        setTerm("");
      }, 0);
      return;
    }
    if (next.endpoint !== last.current) setTerm("");
    last.current = next.endpoint;
  }, []);

  const value = useMemo(
    () => ({ config, register, term, setTerm }),
    [config, register, term],
  );
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export const useSearchContext = () => useContext(SearchContext);

/**
 * Claim the top-bar search for a list the page filters itself — one it already
 * holds whole, so there is nothing to ask the server. `key` stands in for the
 * endpoint: it decides whether the term survives moving between pages. A
 * null key offers no box at all.
 */
export function useLocalSearch(title: string, key: string | null): string {
  const { register, term } = useSearchContext();
  // A null key: this view has nothing to search, so no box is offered.
  useEffect(() => {
    if (key === null) return;
    register({ title, endpoint: key, live: true });
    return () => register(null);
  }, [register, title, key]);
  return key === null ? "" : term;
}
