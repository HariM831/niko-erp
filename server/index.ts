import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { authRouter } from "./routes/auth";
import { accountingRouter } from "./routes/accounting";
import { assetsRouter } from "./routes/assets";
import { budgetsRouter } from "./routes/budgets";
import { inventoryRouter } from "./routes/inventory";
import { locationsRouter } from "./routes/locations";
import { reportingTagsRouter } from "./routes/reporting-tags";
import { customFieldsRouter } from "./routes/custom-fields";
import { rolesRouter, usersRouter } from "./routes/users";
import { bulkUpdateRouter } from "./routes/bulk-update";
import { contactsRouter } from "./routes/contacts";
import { contactInsightsRouter } from "./routes/contact-insights";
import { itemsRouter, taxesRouter } from "./routes/items";
import { qualitySpecsRouter } from "./routes/item-quality";
import { salesRouter } from "./routes/sales";
import { salesDocumentsRouter } from "./routes/sales-documents";
import { purchasesRouter } from "./routes/purchases";
import { officeRouter } from "./routes/office";
import { deductionRulesRouter } from "./routes/deduction-rules";
import { farmsRouter } from "./routes/farms";
import { farmsFlockRouter } from "./routes/farms-flocks";
import { farmsCompatRouter } from "./routes/farms-compat";
import { officeSitesRouter } from "./routes/office-sites";
import { feedNutrientsRouter } from "./routes/feed-nutrients";
import { feedStandardsRouter } from "./routes/feed-standards";
import { feedFormulasRouter } from "./routes/feed-formulas";
import { feedFormulatorRouter } from "./routes/feed-formulator";
import { feedProductionRouter } from "./routes/feed-production";
import { bankingRouter } from "./routes/banking";
import { reportsRouter } from "./routes/reports";
import { settingsRouter } from "./routes/settings";
import { attachmentsRouter } from "./routes/attachments";
import { commentsRouter } from "./routes/comments";
import { activityRouter } from "./routes/activity";
import { activityLogger } from "./lib/activity";
import { forwardAsyncErrors } from "./lib/async-errors";
import { requireAuth } from "./lib/rbac";

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) throw new Error("SESSION_SECRET must be set");

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("trust proxy", 1);
// Before anything is mounted: patches Layer, so every route registered below
// has its rejections forwarded to the error handler instead of hanging.
forwardAsyncErrors();

app.use(express.json({ limit: "2mb" }));

const PgStore = connectPgSimple(session);
app.use(
  session({
    store: new PgStore({ pool, tableName: "user_sessions", createTableIfMissing: true }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    },
  }),
);

// Origin check for state-changing requests. Unlike Niko, a missing Origin
// header on a mutating request is rejected (browsers always send it;
// API clients must set it or use a token flow added later).
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.origin ?? req.headers.referer;
    if (!origin) return res.status(403).json({ error: "Missing Origin header" });
    const host = req.headers.host;
    try {
      if (new URL(origin).host !== host) {
        return res.status(403).json({ error: "Cross-origin request rejected" });
      }
    } catch {
      return res.status(403).json({ error: "Invalid Origin header" });
    }
  }
  next();
});

app.use("/api", activityLogger);
app.use("/api/auth", authRouter);
app.use("/api/activity-log", activityRouter);
app.use("/api/accounting", requireAuth, accountingRouter);
app.use("/api/assets", requireAuth, assetsRouter);
app.use("/api/inventory", requireAuth, inventoryRouter);
app.use("/api/locations", requireAuth, locationsRouter);
app.use("/api/reporting-tags", requireAuth, reportingTagsRouter);
app.use("/api/custom-fields", requireAuth, customFieldsRouter);
app.use("/api/users", requireAuth, usersRouter);
app.use("/api/roles", requireAuth, rolesRouter);
app.use("/api/budgets", requireAuth, budgetsRouter);
app.use("/api/bulk-update", requireAuth, bulkUpdateRouter);
app.use("/api/contacts", requireAuth, contactInsightsRouter);
app.use("/api/contacts", requireAuth, contactsRouter);
app.use("/api/items", requireAuth, itemsRouter);
app.use("/api/taxes", requireAuth, taxesRouter);
app.use("/api/quality-specs", requireAuth, qualitySpecsRouter);
app.use("/api/sales", requireAuth, salesRouter);
app.use("/api/sales", requireAuth, salesDocumentsRouter);
app.use("/api/purchases", requireAuth, purchasesRouter);
app.use("/api/office", requireAuth, officeRouter);
app.use("/api/deduction-rules", requireAuth, deductionRulesRouter);
app.use("/api/office-sites", requireAuth, officeSitesRouter);
app.use("/api/farms", requireAuth, farmsRouter);
app.use("/api/farms", requireAuth, farmsFlockRouter);
// The ported screens post in the farm app's shapes; translated in the router.
app.use("/api/farms/compat", requireAuth, farmsCompatRouter);
app.use("/api/feed/nutrients", requireAuth, feedNutrientsRouter);
app.use("/api/feed/standards", requireAuth, feedStandardsRouter);
app.use("/api/feed/formulas", requireAuth, feedFormulasRouter);
app.use("/api/feed/formulator", requireAuth, feedFormulatorRouter);
app.use("/api/feed/production", requireAuth, feedProductionRouter);
app.use("/api/banking", requireAuth, bankingRouter);
app.use("/api/reports", requireAuth, reportsRouter);
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/attachments", attachmentsRouter);
app.use("/api/comments", commentsRouter);

// Central error handler — no stack/message leaks.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  },
);

// A rejection from a route handler now reaches the error handler above and is
// answered with a 500 — see lib/async-errors. This stays as the backstop for a
// rejection with no request behind it: a timer, a listener, a stray void call.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection outside a request — server still up:", reason);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`eggsy server listening on :${port}`));
