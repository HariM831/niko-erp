/**
 * Checks the account-head suggestions (docs/account-head-suggestion-plan.md)
 * against the real database — then rolls back.
 *
 * Every vendor, account, item and bill it reads is made here, inside the
 * transaction, and the line text uses made-up words so nothing already in the
 * books can match it. The model is a stub: one that answers with labels it
 * was never given, and one that fails outright.
 *
 * Run: npx tsx scripts/check-account-suggestions.ts
 */
import { eq } from "drizzle-orm";
import { accounts, contacts, items, users } from "@shared/schema";
import { db } from "../server/db";
import { createBill, loadVendor } from "../server/services/purchases";
import { istDate } from "../server/services/day-resolution";
import {
  allowedAccounts,
  fromHistory,
  parseAnswers,
  suggestAccounts,
  words,
  type AskModel,
} from "../server/services/account-suggestions";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};

class Rollback extends Error {}

async function main() {
  const [actor] = await db.select({ id: users.id }).from(users).limit(1);
  if (!actor) throw new Error("No user to attribute the documents to");

  // ── Pure rules, no database ──
  console.log("History rules");
  const row = (vendorId: string | null, text: string, accountId: string, date = "2026-09-01") => {
    const w = words(text);
    return { vendorId, words: w, key: w.join(" "), accountId, date };
  };
  const all = new Set(["A", "B", "C", "S"]);
  const hist = [
    row("v1", "Zqx genset repair", "A"),
    row("v1", "Zqx genset repair", "A"),
    row("v1", "Zqx genset repair", "B", "2026-09-20"),
    row("v1", "Zqx belt for genset motor", "C"),
    row("v2", "Plorb cleaning", "B"),
    row("v3", "Plorb cleaning", "B"),
    row("v4", "Wibble one", "C"),
    row("v4", "Wibble two", "C"),
    row("v4", "Wibble three", "C"),
    row("v5", "Stocky", "S"),
  ];
  const h1 = fromHistory(hist, all, "v1", "zqx GENSET repair 20 ltr");
  check("H1 same vendor same text → most used", h1?.accountId === "A", h1?.reason);
  check("H1 shows the split", h1?.reason === "History · 2 of 3 times for this vendor", h1?.reason);
  const h2 = fromHistory(hist, all, "v1", "zqx genset motor belt replaced");
  check("H2 similar text from the vendor", h2?.accountId === "C" && /similar/.test(h2.reason), h2?.reason);
  const h3 = fromHistory(hist, all, "v9", "Plorb cleaning");
  check("H3 same text across vendors, twice", h3?.accountId === "B" && /across vendors/.test(h3.reason), h3?.reason);
  const h4 = fromHistory(hist, all, "v4", "something new entirely");
  check("H4 the vendor's usual head", h4?.accountId === "C" && /usual head/.test(h4.reason), h4?.reason);
  const h4blank = fromHistory(hist, all, "v4", "");
  check("H4 answers with no text at all", h4blank?.accountId === "C", h4blank?.reason);
  check("nothing for an unknown vendor and new text", fromHistory(hist, all, "v9", "brand new words") === null);
  const tie = fromHistory(
    [row("v1", "Tie", "A", "2026-08-01"), row("v1", "Tie", "B", "2026-09-01")],
    all,
    "v1",
    "Tie",
  );
  check("a tie goes to the most recent", tie?.accountId === "B", tie?.reason);
  check(
    "history on a head that may not be offered is ignored",
    fromHistory(hist, new Set(["A", "B", "C"]), "v5", "Stocky") === null,
  );

  console.log("Model answers");
  const allowedStub = [
    { id: "id-1", code: "6001", name: "Repairs" },
    { id: "id-2", code: "6002", name: "Fuel" },
  ];
  const parsed = parseAnswers(
    '```json\n{"answers":[{"key":"x","label":"A9999","reason":"made up"},{"key":"y","label":"A2","reason":"diesel"},{"key":"z","label":null},{"key":"stranger","label":"A1"}]}\n```',
    allowedStub,
    new Set(["x", "y", "z"]),
  );
  check("a label never given is discarded", !parsed.has("x"));
  check("a given label maps to its account", parsed.get("y")?.accountId === "id-2", parsed.get("y")?.reason);
  check("null stays empty", !parsed.has("z"));
  check("an answer for a line never asked is discarded", !parsed.has("stranger"));
  check("garbage is no answer", parseAnswers("not json at all", allowedStub, new Set(["x"])).size === 0);

  // ── Against the database, with our own fixtures ──
  try {
    await db.transaction(async (tx) => {
      console.log("Allowed heads");
      const mk = async (code: string, name: string, type: "expense" | "asset" | "liability", subtype: string) => {
        const [a] = await tx
          .insert(accounts)
          .values({ code, name, type, subtype: subtype as never })
          .returning({ id: accounts.id });
        return a!.id;
      };
      const repairs = await mk("ZT9001", "Zt Repairs", "expense", "expense");
      const fuel = await mk("ZT9002", "Zt Fuel", "expense", "expense");
      const machine = await mk("ZT9003", "Zt Machinery", "asset", "fixed_asset");
      const stockSub = await mk("ZT9004", "Zt Feed Stock", "asset", "stock");
      const itemStock = await mk("ZT9005", "Zt Maize Stock", "asset", "other_current_asset");
      const gst = await mk("ZT9006", "Zt GST Input", "liability", "other_current_liability");
      await tx.insert(items).values({
        name: "Zt Maize fixture",
        unit: "kg",
        trackInventory: true,
        inventoryAccountId: itemStock,
      });

      const forBill = new Set((await allowedAccounts(tx, "bill")).map((a) => a.id));
      const forExpense = new Set((await allowedAccounts(tx, "expense")).map((a) => a.id));
      check("bill offers expense heads", forBill.has(repairs) && forBill.has(fuel));
      check("bill offers fixed assets", forBill.has(machine));
      check("bill never offers a stock-subtype head", !forBill.has(stockSub));
      check("bill never offers an item's stock head", !forBill.has(itemStock));
      check("bill never offers a tax head", !forBill.has(gst));
      check("expense offers expense heads only", forExpense.has(repairs) && !forExpense.has(machine));
      check("expense never offers stock", !forExpense.has(stockSub) && !forExpense.has(itemStock));

      console.log("Suggestions end to end");
      const [v] = await tx
        .insert(contacts)
        .values({ type: "vendor", displayName: "Zt Fixture Vendor" })
        .returning({ id: contacts.id });
      const vendor = await loadVendor(tx, v!.id);
      const today = istDate();
      const line = (name: string, accountId: string) => ({ accountId, name, quantity: "1", rate: "100" });
      for (let i = 0; i < 3; i++) {
        await createBill(tx, { vendor, billDate: today, lines: [line("Qwrbl genset service", repairs)], postedBy: actor.id });
      }
      await createBill(tx, { vendor, billDate: today, lines: [line("Qwrbl genset service", fuel)], postedBy: actor.id });

      let asked = 0;
      const stub: AskModel = async (prompt) => {
        asked++;
        const label = prompt.split("\n").find((l) => l.includes("| ZT9002 |"))?.split(" | ")[0];
        return JSON.stringify({
          answers: [
            { key: "new", label, reason: "looks like fuel" },
            { key: "bogus", label: "A99999", reason: "made up" },
          ],
        });
      };
      const got = await suggestAccounts(
        tx,
        {
          docType: "bill",
          vendorId: vendor.id,
          lines: [
            { key: "hist", text: "Qwrbl genset service" },
            { key: "new", text: "Glarbo blorp" },
            { key: "bogus", text: "Snorf" },
            { key: "empty", text: "  " },
          ],
        },
        stub,
      );
      const by = new Map(got.map((g) => [g.key, g]));
      check("history answers first", by.get("hist")?.accountId === repairs && by.get("hist")?.source === "history", by.get("hist")?.reason);
      check("the split is shown", by.get("hist")?.reason === "History · 3 of 4 times for this vendor", by.get("hist")?.reason);
      check("one model call covers the misses", asked === 1, String(asked));
      check("the model fills a miss", by.get("new")?.accountId === fuel && by.get("new")?.source === "ai", by.get("new")?.reason);
      check("an id the model invented is dropped", by.get("bogus")?.accountId === null, by.get("bogus")?.reason);
      check("an empty line gets nothing", by.get("empty")?.accountId === null);

      const failing: AskModel = async () => {
        throw new Error("503 unavailable");
      };
      const down = await suggestAccounts(
        tx,
        { docType: "bill", vendorId: vendor.id, lines: [{ key: "hist", text: "Qwrbl genset service" }, { key: "new", text: "Glarbo blorp" }] },
        failing,
      );
      check("with the model down, history still answers", down[0]?.accountId === repairs);
      check("with the model down, a miss stays blank", down[1]?.accountId === null && down[1]?.reason === "No suggestion");
      const noKey = await suggestAccounts(tx, { docType: "bill", vendorId: vendor.id, lines: [{ key: "new", text: "Glarbo blorp" }] }, null);
      check("with no key, a miss stays blank", noKey[0]?.accountId === null);

      // The bill's repair history must not hand an expense a head it may not take.
      await tx.update(accounts).set({ isActive: false }).where(eq(accounts.id, repairs));
      const inactive = await suggestAccounts(tx, { docType: "bill", vendorId: vendor.id, lines: [{ key: "h", text: "Qwrbl genset service" }] }, null);
      check("an inactive head is skipped for the next rule", inactive[0]?.accountId === fuel, inactive[0]?.reason);

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed (rolled back)");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
