import { clearRosters } from "./lib/roster-cache";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { DEFAULT_ACCENT, getAccent, isAccent, setAccent } from "./theme";

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  roleName: string;
  permissions: Record<string, string[]>;
  /** Their Settings › Appearance choice; null when they never chose. */
  accent?: string | null;
}

// The account, not the browser, decides the accent: a shared office PC takes
// on whoever signs in, and a new device shows the choice made elsewhere. The
// browser copy is only for painting before /me answers.
function takeAccount(user: SessionUser) {
  const want = isAccent(user.accent) ? user.accent : DEFAULT_ACCENT;
  if (want !== getAccent() || document.documentElement.getAttribute("data-accent") !== (want === "yolk" ? null : want)) {
    setAccent(want);
  }
}

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (module: string, action: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ user: SessionUser }>("/api/auth/me")
      .then((d) => {
        takeAccount(d.user);
        setUser(d.user);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    const d = await api<{ user: SessionUser }>("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    takeAccount(d.user);
    setUser(d.user);
  };

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    // The gate keeps its face roster in this browser; it leaves with the session.
    await clearRosters();
    setUser(null);
  };

  const can = (module: string, action: string) => {
    const p = user?.permissions ?? {};
    return (
      p["*"]?.includes("*") || p[module]?.includes("*") || p[module]?.includes(action) || false
    );
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
