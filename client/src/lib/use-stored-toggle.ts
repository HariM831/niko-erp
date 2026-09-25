import { useCallback, useState } from "react";

/**
 * An on/off remembered in this browser, for a panel someone has chosen to
 * hide. Per browser rather than per user on purpose: a sidebar worth hiding
 * on a laptop is worth keeping on the office monitor. Storage can be blocked
 * (a private window), in which case it simply starts from the default.
 */
export function useStoredToggle(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* private window */
      }
    },
    [key],
  );
  return [value, set];
}
