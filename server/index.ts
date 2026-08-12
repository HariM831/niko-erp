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
import { rolesRouter, usersRouter } from "./routes/users";
import { bulkUpdateRouter } from "./routes/bulk-update";
import { contactsRouter } from "./routes/contacts";
import { contactInsightsRouter } from "./routes/contact-insights";
import { itemsRouter, taxesRouter } from "./routes/items";
import { salesRouter } from "./routes/sales";
import { salesDocumentsRouter } from "./routes/sales-documents";
import { purchasesRouter } from "./routes/purchases";
import { bankingRouter } from "./routes/banking";
import { reportsRouter } from "./routes/reports";
import { settingsRouter } from "./routes/settings";
import { attachmentsRouter } from "./routes/attachments";
import { commentsRouter } from "./routes/comments";
import { activityRouter } from "./routes/activity";
import { activityLogger } from "./lib/activity";
import { requireAuth } from "./lib/rbac";

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) throw new Error("SESSION_SECRET must be set");

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("trust proxy", 1);
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
app.use("/api/users", requireAuth, usersRouter);
app.use("/api/roles", requireAuth, rolesRouter);
app.use("/api/budgets", requireAuth, budgetsRouter);
app.use("/api/bulk-update", requireAuth, bulkUpdateRouter);
app.use("/api/contacts", requireAuth, contactInsightsRouter);
app.use("/api/contacts", requireAuth, contactsRouter);
app.use("/api/items", requireAuth, itemsRouter);
app.use("/api/taxes", requireAuth, taxesRouter);
app.use("/api/sales", requireAuth, salesRouter);
app.use("/api/sales", requireAuth, salesDocumentsRouter);
app.use("/api/purchases", requireAuth, purchasesRouter);
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

// Express 4 doesn't forward errors thrown in async handlers, so an unexpected
// rejection would otherwise reach Node's default handler and kill the process.
// Log it loudly and keep serving; the offending request simply gets no reply.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection — request abandoned, server still up:", reason);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`eggsy server listening on :${port}`));
