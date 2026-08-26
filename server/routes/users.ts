import { Router } from "express";
import { randomBytes, scryptSync } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { roles, users } from "@shared/schema";
import { PERMISSION_MODULES, isAdminMap, sanitisePermissions } from "@shared/permissions";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { nonBlank, validateBody } from "../lib/validate";

export const usersRouter = Router();
export const rolesRouter = Router();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

const userSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/, {
    message: "Letters, numbers, dot, dash and underscore only",
  }),
  name: nonBlank(),
  email: z.string().email().optional().or(z.literal("")),
  roleId: z.string().uuid(),
  password: z.string().min(8).max(128),
});

const userPatchSchema = z.object({
  name: nonBlank().optional(),
  email: z.string().email().optional().or(z.literal("")),
  roleId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
});

const roleSchema = z.object({
  name: nonBlank(60),
  description: z.string().optional(),
  permissions: z.record(z.string(), z.array(z.string())),
});

/** How many active users would still hold full access without this one. */
async function otherActiveAdmins(excludeUserId?: string): Promise<number> {
  const rows = await db
    .select({ id: users.id, permissions: roles.permissions })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.isActive, true));
  return rows.filter((r) => r.id !== excludeUserId && isAdminMap(r.permissions)).length;
}

usersRouter.get("/", requirePermission("users", "manage"), async (_req, res) => {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      isActive: users.isActive,
      lockedUntil: users.lockedUntil,
      failedLoginAttempts: users.failedLoginAttempts,
      createdAt: users.createdAt,
      roleId: users.roleId,
      roleName: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .orderBy(asc(users.name));
  res.json(rows);
});

usersRouter.post(
  "/",
  requirePermission("users", "manage"),
  validateBody(userSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof userSchema>;
    // Case-insensitive: "Hari" and "hari" would otherwise sign in as two
    // different people while looking, to anyone reading a list, like the same
    // one twice.
    const existing = await db.query.users.findFirst({
      where: sql`lower(${users.username}) = lower(${body.username})`,
    });
    if (existing) return res.status(422).json({ error: "That username is taken" });

    const role = await db.query.roles.findFirst({ where: eq(roles.id, body.roleId) });
    if (!role) return res.status(422).json({ error: "Role not found" });

    const [row] = await db
      .insert(users)
      .values({
        username: body.username,
        name: body.name,
        email: body.email || null,
        roleId: body.roleId,
        passwordHash: hashPassword(body.password),
      })
      .returning({ id: users.id, username: users.username, name: users.name });
    res.status(201).json(row);
  },
);

usersRouter.patch(
  "/:id",
  requirePermission("users", "manage"),
  validateBody(userPatchSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof userPatchSchema>;
    const target = await db.query.users.findFirst({ where: eq(users.id, req.params.id!) });
    if (!target) return res.status(404).json({ error: "User not found" });

    const isSelf = target.id === req.session.user!.id;
    // Guard rails against locking yourself out of your own books.
    if (isSelf && body.isActive === false) {
      return res.status(422).json({ error: "You cannot deactivate your own account" });
    }
    if (isSelf && body.roleId && body.roleId !== target.roleId) {
      return res.status(422).json({ error: "You cannot change your own role" });
    }
    // Removing the last admin leaves nobody who can manage users again.
    const losingAdmin =
      body.isActive === false || (body.roleId && body.roleId !== target.roleId);
    if (losingAdmin && (await otherActiveAdmins(target.id)) === 0) {
      const currentRole = await db.query.roles.findFirst({ where: eq(roles.id, target.roleId) });
      if (currentRole && isAdminMap(currentRole.permissions)) {
        return res
          .status(422)
          .json({ error: "This is the last account with full access — promote someone else first" });
      }
    }
    if (body.roleId) {
      const role = await db.query.roles.findFirst({ where: eq(roles.id, body.roleId) });
      if (!role) return res.status(422).json({ error: "Role not found" });
    }

    const [updated] = await db
      .update(users)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.email !== undefined && { email: body.email || null }),
        ...(body.roleId !== undefined && { roleId: body.roleId }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, target.id))
      .returning({ id: users.id, name: users.name, isActive: users.isActive });
    res.json(updated);
  },
);

/** Admin-set password. The user should change it themselves after signing in. */
usersRouter.post(
  "/:id/reset-password",
  requirePermission("users", "manage"),
  validateBody(z.object({ password: z.string().min(8).max(128) })),
  async (req, res) => {
    const target = await db.query.users.findFirst({ where: eq(users.id, req.params.id!) });
    if (!target) return res.status(404).json({ error: "User not found" });
    await db
      .update(users)
      .set({
        passwordHash: hashPassword(req.body.password),
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, target.id));
    res.json({ ok: true });
  },
);

/** Clear a lockout after too many failed sign-ins, without touching the password. */
usersRouter.post(
  "/:id/unlock",
  requirePermission("users", "manage"),
  async (req, res) => {
    const [updated] = await db
      .update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(users.id, req.params.id!))
      .returning({ id: users.id });
    if (!updated) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true });
  },
);

rolesRouter.get("/", requirePermission("users", "manage"), async (_req, res) => {
  const rows = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
      permissions: roles.permissions,
      // ::int — postgres returns count() as bigint, which the driver hands back
      // as a string, and the client would then be doing string arithmetic.
      userCount: sql<number>`count(${users.id})::int`,
    })
    .from(roles)
    .leftJoin(users, eq(users.roleId, roles.id))
    .groupBy(roles.id)
    .orderBy(asc(roles.name));
  res.json(rows);
});

/** The module/action catalogue the editor renders. */
rolesRouter.get("/modules", requirePermission("users", "manage"), (_req, res) => {
  res.json(PERMISSION_MODULES);
});

rolesRouter.post(
  "/",
  requirePermission("users", "manage"),
  validateBody(roleSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof roleSchema>;
    const existing = await db.query.roles.findFirst({ where: eq(roles.name, body.name) });
    if (existing) return res.status(422).json({ error: "A role with that name exists" });
    const [row] = await db
      .insert(roles)
      .values({
        name: body.name,
        description: body.description,
        permissions: sanitisePermissions(body.permissions),
      })
      .returning();
    res.status(201).json(row);
  },
);

rolesRouter.patch(
  "/:id",
  requirePermission("users", "manage"),
  validateBody(roleSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof roleSchema>>;
    const role = await db.query.roles.findFirst({ where: eq(roles.id, req.params.id!) });
    if (!role) return res.status(404).json({ error: "Role not found" });
    // System roles keep their permissions: Admin must stay all-access, and the
    // seeded roles are what a fresh install is expected to look like.
    if (role.isSystem && body.permissions) {
      return res
        .status(422)
        .json({ error: `"${role.name}" is a built-in role — copy it to make a custom version` });
    }
    if (body.name && body.name !== role.name) {
      const clash = await db.query.roles.findFirst({
        where: and(eq(roles.name, body.name), ne(roles.id, role.id)),
      });
      if (clash) return res.status(422).json({ error: "A role with that name exists" });
    }
    const [updated] = await db
      .update(roles)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.permissions !== undefined && {
          permissions: sanitisePermissions(body.permissions),
        }),
      })
      .where(eq(roles.id, role.id))
      .returning();
    res.json(updated);
  },
);

rolesRouter.delete("/:id", requirePermission("users", "manage"), async (req, res) => {
  const role = await db.query.roles.findFirst({ where: eq(roles.id, req.params.id!) });
  if (!role) return res.status(404).json({ error: "Role not found" });
  if (role.isSystem) return res.status(422).json({ error: "Built-in roles cannot be deleted" });
  const [assigned] = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.roleId, role.id));
  const n = Number(assigned?.n ?? 0);
  if (n > 0) {
    return res
      .status(422)
      .json({ error: `${n} user${n === 1 ? "" : "s"} still assigned — move them first` });
  }
  await db.delete(roles).where(eq(roles.id, role.id));
  res.json({ ok: true });
});
