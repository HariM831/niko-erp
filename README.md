# niko v3

Farm ERP rebuilt on a Zoho Books-style accounting core. Books first; operational
modules (feed mill, farms, egg sales, payroll) get ported on top afterwards.

## Foundation rules (non-negotiable)

These exist because the previous codebase violated every one of them:

1. **All money is `numeric(14,2)`** (strings in TS). Never `real`/`float`.
2. **Every multi-write flow runs in `db.transaction()`.** Documents and their
   journal entries commit or roll back together.
3. **Everything posts to the GL** through `server/services/posting.ts` — no
   document mutates balances directly, and there is no stored `balance` column
   anywhere; balances are always SQL aggregations of `journal_entry_lines`.
4. **Document numbers** come from `nextDocumentNumber()` (atomic per-series
   counter), never `count(*) + 1`.
5. **Every write route uses `validateBody(zodSchema)`** — parsed output replaces
   `req.body`, so mass assignment is impossible.
6. **Every route is gated by `requirePermission(module, action)`**, not just
   session checks.
7. **Schema changes ship as migrations** (`npm run db:generate` → commit the SQL
   in `migrations/`), never `drizzle-kit push`.
8. Statuses are PG enums; cross-references are real foreign keys.

## Stack

Express + Drizzle + Postgres (server), React + Vite (client, coming next).
Sessions in Postgres, scrypt passwords with lockout.

## Setup

```
npm install
set DATABASE_URL=postgres://...
set SESSION_SECRET=...
npm run db:generate   # after schema changes
npm run db:migrate
npm run db:seed       # CoA, series, taxes, roles, admin user (SEED_ADMIN_PASSWORD)
npm run dev
```

## Account recovery

Password resets normally happen in the app: an admin opens Settings → Users
and resets someone's password, or clears a lockout after failed sign-ins.
There is no self-service "forgot password" — no email is sent anywhere,
because the app has no mail infrastructure.

That leaves one hole: **if the only full-access account forgets its password,
nobody can get in.** Re-running `db:seed` will not help — the admin row is
inserted with `onConflictDoNothing`, so an existing account keeps its old
password.

Two things guard against it:

1. **Keep at least two full-access accounts.** Then a forgotten password is
   fixed from Settings → Users rather than from a shell.
2. **`npm run admin:recover`** — the way back in when nobody can sign in.
   Requires shell access on the server, which is the whole security boundary;
   there is no HTTP route to attack. Passwords are typed at a hidden prompt,
   never passed as arguments or environment variables, so they stay out of
   shell history, the process list, and CI logs.

```
npm run admin:recover -- --list                                  # who can get in
npm run admin:recover -- --user admin                            # reset a password
npm run admin:recover -- --user hari --create --role Admin       # add a full-access account
```

## Module plan (Zoho Books parity)

- [x] Foundation: schema, posting engine, numbering, RBAC, validation, auth
- [x] Accountant: chart of accounts, manual journals, reversal, trial balance, ledger
- [ ] Contacts (customers/vendors) + Items + Taxes routes
- [ ] Sales: Invoices → Payments Received → Credit Notes
- [ ] Purchases: POs → Bills → Payments Made → Vendor Credits → Expenses
- [ ] Banking: statement import, matching, reconciliation
- [ ] Reports: P&L, Balance Sheet, Cash Flow, AR/AP aging, GSTR-1/3B
- [ ] Client: Zoho-style UI kit (list + split detail view, line-item forms)
- [ ] Port operational modules from Niko (feed mill, farms, egg sales, payroll)
