import { Router } from "express";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { roles, users } from "@shared/schema";
import { db } from "../db";
import { requireAuth } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const authRouter = Router();

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  const { username, password } = req.body as z.infer<typeof loginSchema>;

  const user = await db.query.users.findFirst({
    where: eq(users.username, username),
  });
  // Uniform error for unknown user / bad password / inactive — no enumeration.
  const fail = () => res.status(401).json({ error: "Invalid credentials" });

  if (!user || !user.isActive || !user.passwordHash) return fail();
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return res.status(429).json({ error: "Account locked. Try again later." });
  }

  const [salt, storedHash] = user.passwordHash.split(":");
  if (!salt || !storedHash) return fail();
  const candidate = scryptSync(password, salt, 64);
  const stored = Buffer.from(storedHash, "hex");
  const ok = stored.length === candidate.length && timingSafeEqual(candidate, stored);

  if (!ok) {
    const attempts = user.failedLoginAttempts + 1;
    await db
      .update(users)
      .set({
        failedLoginAttempts: attempts,
        lockedUntil:
          attempts >= MAX_ATTEMPTS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
      })
      .where(eq(users.id, user.id));
    return fail();
  }

  await db
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null })
    .where(eq(users.id, user.id));

  const role = await db.query.roles.findFirst({ where: eq(roles.id, user.roleId) });

  // Regenerate the session on privilege change (fixation guard).
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Session error" });
    req.session.user = {
      id: user.id,
      name: user.name,
      username: user.username,
      roleName: role?.name ?? "",
      permissions: role?.permissions ?? {},
    };
    res.json({ user: req.session.user });
  });
});

authRouter.post("/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

authRouter.post(
  "/change-password",
  requireAuth,
  validateBody(changePasswordSchema),
  async (req, res) => {
    const { currentPassword, newPassword } = req.body as z.infer<
      typeof changePasswordSchema
    >;
    const user = await db.query.users.findFirst({
      where: eq(users.id, req.session.user!.id),
    });
    if (!user?.passwordHash) return res.status(400).json({ error: "No password set" });
    const [salt, storedHash] = user.passwordHash.split(":");
    if (!salt || !storedHash) return res.status(400).json({ error: "Corrupt hash" });
    const candidate = scryptSync(currentPassword, salt, 64);
    const stored = Buffer.from(storedHash, "hex");
    if (stored.length !== candidate.length || !timingSafeEqual(candidate, stored)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    const newSalt = randomBytes(16).toString("hex");
    const newHash = scryptSync(newPassword, newSalt, 64).toString("hex");
    await db
      .update(users)
      .set({ passwordHash: `${newSalt}:${newHash}`, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    res.json({ ok: true });
  },
);
