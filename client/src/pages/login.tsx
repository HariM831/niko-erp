import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import logoMark from "../assets/logo-mark.png";

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
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-gradient-to-br from-sidebar via-soil-800 to-yolk-600">
      {/* Two quiet suns, not a texture — the same trick as the Home hero. */}
      <div className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-white/5" />
      <div className="pointer-events-none absolute -bottom-32 -right-16 h-[28rem] w-[28rem] rounded-full bg-yolk-400/20" />
      <form onSubmit={submit} className="relative w-[350px] rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-1 flex items-center">
          <img src={logoMark} alt="niko" className="h-10 w-auto" />
        </div>
        <p className="mb-6 text-[13px] text-gray-500">Sign in to manage your books</p>
        <label className="label">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          className="input mb-3 py-2"
        />
        <label className="label">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input mb-4 py-2"
        />
        {error && <p className="mb-3 text-xs text-red-600">{error}</p>}
        <button
          disabled={busy || !username || !password}
          className="btn-primary w-full py-2 text-sm"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
