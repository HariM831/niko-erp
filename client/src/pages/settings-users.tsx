import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PermissionModule,
  actionsFor,
  effectiveActions,
  isAdminMap,
} from "@shared/permissions";
import { overviewPagesForModule, pagesForAction } from "@shared/pages";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  Badge,
  Banner,
  EmptyRow,
  Modal,
  NameCell,
  RowAction,
  RowActions,
  SettingsHeader,
  SettingsTable,
} from "../components/settings-ui";

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
  msg ? <Banner tone="error">{msg}</Banner> : null;

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
      <SettingsHeader
        title="Users"
        actions={
          <button onClick={() => setAdding(true)} className="btn-primary">
            + New User
          </button>
        }
      />

      <Err msg={error} />

      <SettingsTable
        columns={[
          { label: "Name" },
          { label: "Username" },
          { label: "Role", width: "w-48" },
          { label: "Status", width: "w-32" },
          { label: "", align: "right" },
        ]}
      >
        {!users?.length && <EmptyRow colSpan={5}>No users yet.</EmptyRow>}
        {users?.map((u) => (
          <tr key={u.id} className="s-row">
            <td className="s-td">
              <NameCell
                name={u.name}
                sub={u.email}
                after={
                  u.id === me?.id ? <span className="text-[12px] text-gray-400">(you)</span> : null
                }
              />
            </td>
            <td className="s-td text-gray-600">{u.username}</td>
            <td className="s-td">
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
                className="w-full rounded border border-gray-200 px-2 py-1 text-[13px] disabled:border-transparent disabled:bg-transparent disabled:text-gray-500"
              >
                {roles?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </td>
            <td className="s-td">
              {!u.isActive ? (
                <Badge tone="gray">Inactive</Badge>
              ) : isLocked(u) ? (
                <Badge tone="amber">Locked out</Badge>
              ) : (
                <Badge tone="green">Active</Badge>
              )}
            </td>
            <td className="s-td">
              <RowActions>
                {isLocked(u) && (
                  <RowAction
                    onClick={() => act(() => api(`/api/users/${u.id}/unlock`, { method: "POST" }))}
                  >
                    Unlock
                  </RowAction>
                )}
                <RowAction onClick={() => setResetting(u)}>Reset password</RowAction>
                {u.id !== me?.id && (
                  <RowAction
                    tone="danger"
                    onClick={() =>
                      act(() =>
                        api(`/api/users/${u.id}`, {
                          method: "PATCH",
                          body: { isActive: !u.isActive },
                        }),
                      )
                    }
                  >
                    {u.isActive ? "Deactivate" : "Activate"}
                  </RowAction>
                )}
              </RowActions>
            </td>
          </tr>
        ))}
      </SettingsTable>

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
    <Modal
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
    </Modal>
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
    <Modal
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
    </Modal>
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
      <SettingsHeader
        title="Roles"
        actions={
          <button onClick={() => setEditing("new")} className="btn-primary">
            + New Role
          </button>
        }
      />

      <Err msg={error} />

      <SettingsTable
        columns={[
          { label: "Role", width: "w-64" },
          { label: "Access" },
          { label: "Users", align: "right", width: "w-20" },
          { label: "", align: "right", width: "w-32" },
        ]}
      >
        {!roles?.length && <EmptyRow colSpan={4}>No roles yet.</EmptyRow>}
        {roles?.map((r) => (
          <tr key={r.id} className="s-row">
            <td className="s-td">
              <NameCell
                name={r.name}
                locked={r.isSystem}
                onClick={() => setEditing(r)}
                sub={r.description}
              />
            </td>
            <td className="s-td text-gray-600">
              {isAdminMap(r.permissions)
                ? "Everything"
                : (modules ?? [])
                    .filter((m) => effectiveActions(r.permissions, m.key).length > 0)
                    .map((m) => m.label)
                    .join(", ") || "No access"}
            </td>
            <td className="s-td text-right tabular-nums">{r.userCount}</td>
            <td className="s-td">
              <RowActions>
                <RowAction onClick={() => setEditing(r)}>{r.isSystem ? "View" : "Edit"}</RowAction>
                {!r.isSystem && (
                  <RowAction tone="danger" onClick={() => remove(r)}>
                    Delete
                  </RowAction>
                )}
              </RowActions>
            </td>
          </tr>
        ))}
      </SettingsTable>

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
      if (on) next[module] = actionsFor(module).map((a) => a.key);
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
    <Modal
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

      {/*
        Modules, but read as screens.

        The grid this replaced listed verbs — "Run the formulator", "Manage
        deduction rules" — and never said which page any of them opened, so
        building a role meant ticking something and going to look. Each right
        now names the screens it reveals.

        Where several screens share one right they are listed together and the
        row says so. That is the honest shape of it outside Feed Mill and
        Payroll: every Sales screen rides one `view`, and a row that named only
        Invoices while quietly revealing seven more would be worse than the
        verbs were.
      */}
      {!admin && (
        <div className="space-y-2">
          {modules.map((m) => {
            const actions = perms[m.key] ?? [];
            const own = actionsFor(m.key);
            const all = own.every((a) => actions.includes(a.key));
            const opens = own.filter((a) => pagesForAction(m.key, a.key).length > 0);
            const verbs = own.filter((a) => pagesForAction(m.key, a.key).length === 0);
            const overviews = overviewPagesForModule(m.key);
            return (
              <div key={m.key} className="rounded-lg border border-gray-200 p-3">
                <div className="mb-2 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-gray-900">{m.label}</div>
                    <div className="text-[11px] text-gray-400">{m.description}</div>
                  </div>
                  <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-gray-500">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={all}
                      onChange={(e) => toggleModule(m.key, e.target.checked)}
                    />
                    Everything
                  </label>
                </div>

                {opens.length > 0 && (
                  <div className="mb-2">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      Pages
                    </div>
                    <div className="space-y-1">
                      {opens.map((a) => {
                        const pages = pagesForAction(m.key, a.key);
                        return (
                          <label key={a.key} className="flex items-start gap-2 text-[12px]">
                            <input
                              type="checkbox"
                              className="mt-[3px]"
                              disabled={readOnly}
                              checked={actions.includes(a.key)}
                              onChange={() => toggle(m.key, a.key)}
                            />
                            <span className="min-w-0">
                              <span className="text-gray-800">
                                {pages.map((pg) => pg.label).join(" · ")}
                              </span>
                              {pages.length > 1 && (
                                <span className="text-gray-400">
                                  {" "}
                                  — {pages.length} screens on one right, so they are granted together
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {verbs.length > 0 && (
                  <div>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      {opens.length ? "Also allowed" : "Allowed"}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {verbs.map((a) => (
                        <label
                          key={a.key}
                          className="inline-flex items-center gap-1.5 text-[12px] text-gray-600"
                        >
                          <input
                            type="checkbox"
                            disabled={readOnly}
                            checked={actions.includes(a.key)}
                            onChange={() => toggle(m.key, a.key)}
                          />
                          {a.label}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {overviews.length > 0 && (
                  <p className="mt-2 text-[11px] text-gray-400">
                    {overviews.map((pg) => pg.label).join(", ")} opens for anyone holding any
                    right in this menu.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!admin && (
        <p className="mt-3 text-[12px] text-gray-500">
          {granted === 0
            ? "No modules granted — this role can sign in but see nothing."
            : `Access to ${granted} of ${modules.length} modules. Ticking any action also grants View.`}
        </p>
      )}
    </Modal>
  );
}
