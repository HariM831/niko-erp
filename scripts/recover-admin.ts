/**
 * Account recovery — the way back in when nobody can sign in.
 *
 * Deliberately a shell script, not an HTTP route: the security boundary is
 * "you already have access to the server", so there is nothing to attack over
 * the network. Passwords are typed at a hidden prompt rather than passed as
 * arguments or environment variables, so they never reach shell history,
 * the process list, or a CI log.
 *
 *   npm run admin:recover -- --list
 *   npm run admin:recover -- --user admin
 *   npm run admin:recover -- --user hari --create --role Admin
 */
import { createInterface } from "node:readline";
import { randomBytes, scryptSync } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { roles, users } from "@shared/schema";
import { isAdminMap } from "@shared/permissions";
import { db, pool } from "../server/db";

const MIN_LENGTH = 8;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Not a terminal — run this directly in a shell so the password can be typed without being echoed.",
    );
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Echo the prompt but nothing the user types.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.startsWith(prompt)) rl.output!.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.output!.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function readNewPassword(): Promise<string> {
  const first = await askHidden("New password: ");
  if (first.length < MIN_LENGTH) {
    throw new Error(`Password must be at least ${MIN_LENGTH} characters.`);
  }
  const second = await askHidden("Confirm password: ");
  if (first !== second) throw new Error("Passwords did not match.");
  return first;
}

function hash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

async function list() {
  const rows = await db
    .select({
      username: users.username,
      name: users.name,
      isActive: users.isActive,
      lockedUntil: users.lockedUntil,
      role: roles.name,
      permissions: roles.permissions,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .orderBy(asc(users.username));

  if (!rows.length) {
    console.log("No users exist. Run: npm run db:seed");
    return;
  }
  console.log("\nUsername            Role            Status      Full access");
  console.log("─".repeat(66));
  for (const r of rows) {
    const locked = r.lockedUntil && r.lockedUntil > new Date();
    const status = !r.isActive ? "inactive" : locked ? "locked" : "active";
    console.log(
      `${r.username.padEnd(20)}${r.role.padEnd(16)}${status.padEnd(12)}${
        isAdminMap(r.permissions) ? "yes" : "no"
      }`,
    );
  }
  const admins = rows.filter((r) => r.isActive && isAdminMap(r.permissions));
  console.log(
    `\n${admins.length} active account${admins.length === 1 ? "" : "s"} with full access.`,
  );
  if (admins.length < 2) {
    console.log(
      "Only one way in — create a second full-access account so a forgotten\n" +
        "password can be fixed from the app instead of from here.",
    );
  }
}

async function main() {
  if (has("list")) return list();

  const username = arg("user");
  if (!username) {
    console.log(
      "Usage:\n" +
        "  npm run admin:recover -- --list\n" +
        "  npm run admin:recover -- --user <username>\n" +
        "  npm run admin:recover -- --user <username> --create --role <role name>\n",
    );
    process.exitCode = 1;
    return;
  }

  const existing = await db.query.users.findFirst({ where: eq(users.username, username) });

  if (has("create")) {
    if (existing) throw new Error(`"${username}" already exists — omit --create to reset it.`);
    const roleName = arg("role") ?? "Admin";
    const role = await db.query.roles.findFirst({ where: eq(roles.name, roleName) });
    if (!role) throw new Error(`No role named "${roleName}". Try --list to see what exists.`);
    const password = await readNewPassword();
    await db.insert(users).values({
      username,
      name: arg("name") ?? username,
      roleId: role.id,
      passwordHash: hash(password),
    });
    console.log(`Created "${username}" with the ${role.name} role.`);
    return;
  }

  if (!existing) {
    throw new Error(`No user "${username}". Add --create to make one, or --list to see users.`);
  }
  const password = await readNewPassword();
  await db
    .update(users)
    .set({
      passwordHash: hash(password),
      failedLoginAttempts: 0,
      lockedUntil: null,
      isActive: true,
      updatedAt: new Date(),
    })
    .where(eq(users.id, existing.id));
  console.log(`Password reset for "${username}". Any lockout has been cleared.`);
}

try {
  await main();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
