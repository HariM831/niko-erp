import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  roleName: string;
  permissions: Record<string, string[]>;
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
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    const d = await api<{ user: SessionUser }>("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    setUser(d.user);
  };

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
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
