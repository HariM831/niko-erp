import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

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
  const register = useCallback((next: SearchConfig | null) => {
    setConfig(next);
    setTerm("");
  }, []);

  const value = useMemo(
    () => ({ config, register, term, setTerm }),
    [config, register, term],
  );
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export const useSearchContext = () => useContext(SearchContext);
