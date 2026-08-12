import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PERMISSION_ACTIONS,
  type PermissionModule,
  effectiveActions,
  isAdminMap,
} from "@shared/permissions";
import { api, formatDate } from "../api";
import { useAuth } from "../auth";

interface UserRow {
  id: string;
  username: string;
  name: string;
  email: string | null;
  isActive: boolean;
  lockedUntil: string | null;
  createdAt: string;
  roleId: string;
  roleName: string;
}

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: Record<string, string[]>;
  userCount: number;
}

const Err = ({ msg }: { msg: string | null }) =>
  msg ? (
    <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
      {msg}
    </div>
  ) : null;

export function UsersSection() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);

  const { data: users } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<UserRow[]>("/api/users"),
  });
  const { data: roles } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api<RoleRow[]>("/api/roles"),
  });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const isLocked = (u: UserRow) => u.lockedUntil && new Date(u.lockedUntil) > new Date();

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Users</h2>
          <p className="mt-0.5 text-[13px] text-gray-500">
            Everyone who can sign in. A user's role decides what they may do.
          </p>
        </div>
        <button onClick={() => setAdding(true)} className="btn-primary">
          + New User
        </button>
      </div>

      <Err msg={error} />

      <table className="w-full text-[13px]">
        <thead className="table-head">
          <tr>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-left">Username</th>
            <th className="px-3 py-2 text-left">Role</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id} className="border-b border-gray-100">
              <td className="px-3 py-2">
                {u.name}
                {u.id === me?.id && <span className="ml-2 text-[11px] text-gray-400">(you)</span>}
                {u.email && <div className="text-[11px] text-gray-400">{u.email}</div>}
              </td>
              <td className="px-3 py-2 text-gray-600">{u.username}</td>
              <td className="px-3 py-2">
                <select
                  value={u.roleId}
                  disabled={u.id === me?.id}
                  onChange={(e) =>
                    act(() =>
                      api(`/api/users/${u.id}`, {
                        method: "PATCH",
                        body: { roleId: e.target.value },
                      }),
                    )
                  }
                  className="rounded border border-gray-200 px-2 py-1 text-[13px] disabled:bg-gray-50 disabled:text-gray-400"
                >
                  {roles?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                {!u.isActive ? (
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                    Inactive
                  </span>
                ) : isLocked(u) ? (
                  <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    Locked out
                  </span>
                ) : (
                  <span className="rounded bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                    Active
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                <div className="flex justify-end gap-3">
                  {isLocked(u) && (
                    <button
                      onClick={() => act(() => api(`/api/users/${u.id}/unlock`, { method: "POST" }))}
                      className="text-brand-600 hover:underline"
                    >
                      Unlock
                    </button>
                  )}
                  <button onClick={() => setResetting(u)} className="text-brand-600 hover:underline">
                    Reset password
                  </button>
                  {u.id !== me?.id && (
                    <button
                      onClick={() =>
                        act(() =>
                          api(`/api/users/${u.id}`, {
                            method: "PATCH",
                            body: { isActive: !u.isActive },
                          }),
                        )
                      }
                      className="text-gray-500 hover:underline"
                    >
                      {u.isActive ? "Deactivate" : "Activate"}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {adding && (
        <NewUserDialog
          roles={roles ?? []}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            qc.invalidateQueries();
          }}
        />
      )}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            qc.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}

function Dialog({
  title,
  children,
  onClose,
  footer,
  width = "w-[480px]",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer: React.ReactNode;
  width?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className={`${width} rounded-lg bg-white shadow-lg`}>
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="text-xl text-gray-400 hover:text-gray-700">
            ×
          </button>
        </header>
        <div className="p-5">{children}</div>
        <footer className="flex justify-end gap-2 border-t px-5 py-3">{footer}</footer>
      </div>
    </div>
  );
}

function NewUserDialog({
  roles,
  onClose,
  onDone,
}: {
  roles: RoleRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    username: "",
    name: "",
    email: "",
    roleId: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/users", {
        method: "POST",
        body: { ...form, email: form.email || undefined },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create user");
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New User"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={
              busy ||
              !form.username ||
              !form.name ||
              !form.roleId ||
              form.password.length < 8
            }
            className="btn-primary"
          >
            Create User
          </button>
        </>
      }
    >
      <Err msg={error} />
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label-required">Full Name *</label>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} className="input" />
        </div>
        <div>
          <label className="label-required">Username *</label>
          <input
            value={form.username}
            onChange={(e) => set({ username: e.target.value })}
            className="input"
          />
        </div>
        <div>
          <label className="label">Email</label>
          <input value={form.email} onChange={(e) => set({ email: e.target.value })} className="input" />
        </div>
        <div>
          <label className="label-required">Role *</label>
          <select value={form.roleId} onChange={(e) => set({ roleId: e.target.value })} className="input">
            <option value="">Select role…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label className="label-required">Initial Password *</label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => set({ password: e.target.value })}
            className="input"
          />
          <p className="mt-1 text-[11px] text-gray-400">
            At least 8 characters. Share it with them and ask them to change it from their own
            account once they sign in.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: UserRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/users/${user.id}/reset-password`, { method: "POST", body: { password } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset password");
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Reset password — ${user.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button onClick={submit} disabled={busy || password.length < 8} className="btn-primary">
            Set Password
          </button>
        </>
      }
    >
      <Err msg={error} />
      <label className="label-required">New Password *</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="input"
      />
      <p className="mt-1 text-[11px] text-gray-400">
        At least 8 characters. This also clears any lockout from failed sign-ins.
      </p>
    </Dialog>
  );
}

export function RolesSection() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoleRow | "new" | null>(null);

  const { data: roles } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api<RoleRow[]>("/api/roles"),
  });
  const { data: modules } = useQuery({
    queryKey: ["permission-modules"],
    queryFn: () => api<PermissionModule[]>("/api/roles/modules"),
  });

  const remove = async (r: RoleRow) => {
    if (!confirm(`Delete the "${r.name}" role?`)) return;
    setError(null);
    try {
      await api(`/api/roles/${r.id}`, { method: "DELETE" });
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Roles</h2>
          <p className="mt-0.5 text-[13px] text-gray-500">
            What each role may do, per module. Built-in roles cannot be edited — copy one to make
            a custom version.
          </p>
        </div>
        <button onClick={() => setEditing("new")} className="btn-primary">
          + New Role
        </button>
      </div>

      <Err msg={error} />

      <table className="w-full text-[13px]">
        <thead className="table-head">
          <tr>
            <th className="px-3 py-2 text-left">Role</th>
            <th className="px-3 py-2 text-left">Access</th>
            <th className="px-3 py-2 text-right">Users</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {roles?.map((r) => (
            <tr key={r.id} className="border-b border-gray-100">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  {r.name}
                  {r.isSystem && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                      Built-in
                    </span>
                  )}
                </div>
                {r.description && (
                  <div className="text-[11px] text-gray-400">{r.description}</div>
                )}
              </td>
              <td className="px-3 py-2 text-gray-600">
                {isAdminMap(r.permissions)
                  ? "Everything"
                  : (modules ?? [])
                      .filter((m) => effectiveActions(r.permissions, m.key).length > 0)
                      .map((m) => m.label)
                      .join(", ") || "No access"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.userCount}</td>
              <td className="px-3 py-2 text-right">
                <div className="flex justify-end gap-3">
                  <button onClick={() => setEditing(r)} className="text-brand-600 hover:underline">
                    {r.isSystem ? "View" : "Edit"}
                  </button>
                  {!r.isSystem && (
                    <button onClick={() => remove(r)} className="text-gray-500 hover:underline">
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && modules && (
        <RoleEditor
          role={editing === "new" ? null : editing}
          modules={modules}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            qc.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}

function RoleEditor({
  role,
  modules,
  onClose,
  onDone,
}: {
  role: RoleRow | null;
  modules: PermissionModule[];
  onClose: () => void;
  onDone: () => void;
}) {
  const readOnly = role?.isSystem ?? false;
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [perms, setPerms] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const start: Record<string, string[]> = {};
    for (const m of modules) {
      const actions = role ? effectiveActions(role.permissions, m.key) : [];
      if (actions.length) start[m.key] = actions;
    }
    setPerms(start);
  }, [role, modules]);

  const admin = role ? isAdminMap(role.permissions) : false;

  const toggle = (module: string, action: string) => {
    setPerms((p) => {
      const current = new Set(p[module] ?? []);
      if (current.has(action)) {
        current.delete(action);
        // View is the floor: without it the others are unreachable anyway.
        if (action === "view") current.clear();
      } else {
        current.add(action);
        if (action !== "view") current.add("view");
      }
      const next = { ...p };
      if (current.size) next[module] = [...current];
      else delete next[module];
      return next;
    });
  };

  const toggleModule = (module: string, on: boolean) =>
    setPerms((p) => {
      const next = { ...p };
      if (on) next[module] = PERMISSION_ACTIONS.map((a) => a.key);
      else delete next[module];
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (role) {
        await api(`/api/roles/${role.id}`, {
          method: "PATCH",
          body: { name, description: description || undefined, permissions: perms },
        });
      } else {
        await api("/api/roles", {
          method: "POST",
          body: { name, description: description || undefined, permissions: perms },
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save role");
      setBusy(false);
    }
  };

  const granted = useMemo(
    () => modules.filter((m) => (perms[m.key] ?? []).length > 0).length,
    [modules, perms],
  );

  return (
    <Dialog
      title={role ? (readOnly ? `${role.name} (built-in)` : `Edit ${role.name}`) : "New Role"}
      onClose={onClose}
      width="w-[720px]"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button onClick={submit} disabled={busy || !name.trim()} className="btn-primary">
              Save Role
            </button>
          )}
        </>
      }
    >
      <Err msg={error} />

      {admin && (
        <p className="mb-4 rounded bg-gray-50 px-3 py-2 text-[13px] text-gray-600">
          This role grants unrestricted access to every module, including future ones.
        </p>
      )}

      <div className="mb-4 grid grid-cols-3 gap-4">
        <div>
          <label className="label-required">Role Name *</label>
          <input
            value={name}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
            className="input disabled:bg-gray-50"
          />
        </div>
        <div className="col-span-2">
          <label className="label">Description</label>
          <input
            value={description}
            disabled={readOnly}
            onChange={(e) => setDescription(e.target.value)}
            className="input disabled:bg-gray-50"
          />
        </div>
      </div>

      {!admin && (
        <table className="w-full text-[13px]">
          <thead className="table-head">
            <tr>
              <th className="px-3 py-2 text-left">Module</th>
              {PERMISSION_ACTIONS.map((a) => (
                <th key={a.key} className="w-20 px-2 py-2 text-center">
                  {a.label}
                </th>
              ))}
              <th className="w-16 px-2 py-2 text-center">All</th>
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => {
              const actions = perms[m.key] ?? [];
              const all = PERMISSION_ACTIONS.every((a) => actions.includes(a.key));
              return (
                <tr key={m.key} className="border-b border-gray-100">
                  <td className="px-3 py-2">
                    <div>{m.label}</div>
                    <div className="text-[11px] text-gray-400">{m.description}</div>
                  </td>
                  {PERMISSION_ACTIONS.map((a) => (
                    <td key={a.key} className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={actions.includes(a.key)}
                        onChange={() => toggle(m.key, a.key)}
                      />
                    </td>
                  ))}
                  <td className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={all}
                      onChange={(e) => toggleModule(m.key, e.target.checked)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!admin && (
        <p className="mt-3 text-[12px] text-gray-500">
          {granted === 0
            ? "No modules granted — this role can sign in but see nothing."
            : `Access to ${granted} of ${modules.length} modules. Ticking any action also grants View.`}
        </p>
      )}
    </Dialog>
  );
}
