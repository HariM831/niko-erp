# EGGSY v3

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

## Module plan (Zoho Books parity)

- [x] Foundation: schema, posting engine, numbering, RBAC, validation, auth
- [x] Accountant: chart of accounts, manual journals, reversal, trial balance, ledger
- [ ] Contacts (customers/vendors) + Items + Taxes routes
- [ ] Sales: Estimates → Sales Orders → Invoices → Payments Received → Credit Notes
- [ ] Purchases: POs → Bills → Payments Made → Vendor Credits → Expenses
- [ ] Banking: statement import, matching, reconciliation
- [ ] Reports: P&L, Balance Sheet, Cash Flow, AR/AP aging, GSTR-1/3B
- [ ] Client: Zoho-style UI kit (list + split detail view, line-item forms)
- [ ] Port operational modules from Niko (feed mill, farms, egg sales, payroll)
