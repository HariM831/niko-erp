import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-gray-100">
      <form onSubmit={submit} className="w-80 rounded-lg bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded bg-brand-500 text-lg font-bold text-white">
            E
          </span>
          <span className="text-lg font-semibold">Eggsy Books</span>
        </div>
        <label className="mb-1 block text-xs font-medium text-gray-600">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          className="mb-3 w-full rounded-md border px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <label className="mb-1 block text-xs font-medium text-gray-600">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-md border px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        {error && <p className="mb-3 text-xs text-red-600">{error}</p>}
        <button
          disabled={busy || !username || !password}
          className="w-full rounded-md bg-brand-500 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
