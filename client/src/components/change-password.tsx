import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Modal } from "./settings-ui";

/**
 * Change your own password.
 *
 * Deliberately not in Settings: that whole section is behind the `settings`
 * permission, so putting it there would leave everyone who is not an admin
 * with no way to change their own password — which is the gap this closes.
 * It hangs off the sidebar's account footer instead, next to Sign out, where
 * every signed-in user can reach it.
 *
 * The admin "Reset password" action in Settings → Users is a different thing
 * and stays as it is: that one sets someone else's password without knowing
 * the old one. This one proves you know the current password first.
 */
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Checked here only to catch a typo before a round trip; the server is what
  // enforces the length, and the current password is only ever verified there.
  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= 8 && next === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal
        title="Password changed"
        onClose={onClose}
        width="w-[420px]"
        footer={
          <button onClick={onClose} className="btn-primary">
            Done
          </button>
        }
      >
        <p className="text-[13px] text-gray-600">
          Your password has been changed. You are still signed in here — you will need the
          new one next time you sign in.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Change password"
      onClose={onClose}
      width="w-[420px]"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button onClick={submit} className="btn-primary" disabled={!ready || busy}>
            {busy ? "Changing…" : "Change password"}
          </button>
        </>
      }
    >
      {/* A form so Enter submits and password managers recognise the fields. */}
      <form onSubmit={submit}>
        <label className="label">Current password</label>
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoFocus
          className="input mb-3 py-2"
        />

        <label className="label">New password</label>
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="input py-2"
        />
        <p className={`mb-3 mt-1 text-[12px] ${tooShort ? "text-destructive" : "text-gray-500"}`}>
          At least 8 characters.
        </p>

        <label className="label">Confirm new password</label>
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="input py-2"
        />
        {mismatch && <p className="mt-1 text-[12px] text-destructive">The two do not match.</p>}

        {error && (
          <p className="mt-3 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}

        {/* Lets Enter submit without a visible second button. */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
