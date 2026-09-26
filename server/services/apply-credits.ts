/**
 * Settling a bill or an invoice with money already on the table.
 *
 * A vendor paid in advance, or a credit note raised against a return, leaves
 * the party's ledger carrying a balance in our favour. When the bill for it
 * finally arrives, the answer is to APPLY that balance — not to record a
 * second payment. niko used to offer only "Record Payment" from a bill, so
 * matching an advance meant creating a new payment for money that had already
 * left, and the vendor came out looking owed twice over.
 *
 * Zoho calls this "Apply Credits" and offers both kinds in one list — advance
 * payments and open credit notes — and so does this.
 *
 * No journal is posted either way. An advance already debited Accounts Payable
 * when it was paid, and a credit note already credited it when it was raised;
 * applying one is a reallocation inside AP, and posting anything here would
 * double the entry that exists.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  bills,
  creditNoteApplications,
  creditNotes,
  customerPayments,
  paymentApplications,
  invoices,
  vendorCreditApplications,
  vendorCredits,
  vendorPayments,
  vendorPaymentApplications,
} from "@shared/schema";
import { db } from "../db";
import { PostingError } from "./posting";
import { fromPaise, toPaise } from "./documents";
import type { db as Db } from "../db";

/** The handle inside db.transaction, the same alias every service here uses. */
type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export type Side = "vendor" | "customer";

/** One thing that can be put against a document. */
export interface Credit {
  kind: "advance" | "credit";
  id: string;
  number: string;
  date: string;
  /** What the payment or credit note was worth in full. */
  amount: string;
  /** What is still going spare, and so the most that can be applied. */
  available: string;
}

export interface CreditsOffer {
  /** The document's own number and what is still owed on it. */
  number: string;
  balanceDue: string;
  /** Everything spare on this party's ledger, oldest first — Zoho's order. */
  credits: Credit[];
  /** The sum of `available`, which is what the "Credits Available" bar shows. */
  total: string;
}

/**
 * What this bill or invoice could be settled with.
 *
 * Both kinds are asked for even when a page only expects one: a vendor who
 * paid in advance last month may also have a credit note from a short load,
 * and a screen that shows one and hides the other sends somebody to write a
 * cheque they did not need to write.
 */
export async function creditsFor(side: Side, documentId: string): Promise<CreditsOffer> {
  if (side === "vendor") {
    const bill = await db.query.bills.findFirst({ where: eq(bills.id, documentId) });
    if (!bill) throw new PostingError("Bill not found");
    const [advances, credits] = await Promise.all([
      db
        .select({
          id: vendorPayments.id,
          number: vendorPayments.number,
          date: vendorPayments.paymentDate,
          amount: vendorPayments.amount,
          available: vendorPayments.unappliedAmount,
        })
        .from(vendorPayments)
        .where(and(eq(vendorPayments.vendorId, bill.vendorId), gt(vendorPayments.unappliedAmount, "0")))
        .orderBy(vendorPayments.paymentDate),
      db
        .select({
          id: vendorCredits.id,
          number: vendorCredits.number,
          date: vendorCredits.creditDate,
          amount: vendorCredits.total,
          available: vendorCredits.balance,
        })
        .from(vendorCredits)
        .where(and(eq(vendorCredits.vendorId, bill.vendorId), eq(vendorCredits.status, "open"), gt(vendorCredits.balance, "0")))
        .orderBy(vendorCredits.creditDate),
    ]);
    return offer(bill.number, bill.balanceDue, advances, credits);
  }

  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, documentId) });
  if (!invoice) throw new PostingError("Invoice not found");
  const [advances, credits] = await Promise.all([
    db
      .select({
        id: customerPayments.id,
        number: customerPayments.number,
        date: customerPayments.paymentDate,
        amount: customerPayments.amount,
        available: customerPayments.unappliedAmount,
      })
      .from(customerPayments)
      .where(and(eq(customerPayments.customerId, invoice.customerId), gt(customerPayments.unappliedAmount, "0")))
      .orderBy(customerPayments.paymentDate),
    db
      .select({
        id: creditNotes.id,
        number: creditNotes.number,
        date: creditNotes.creditNoteDate,
        amount: creditNotes.total,
        available: creditNotes.balance,
      })
      .from(creditNotes)
      .where(and(eq(creditNotes.customerId, invoice.customerId), eq(creditNotes.status, "open"), gt(creditNotes.balance, "0")))
      .orderBy(creditNotes.creditNoteDate),
  ]);
  return offer(invoice.number, invoice.balanceDue, advances, credits);
}

type Row = { id: string; number: string; date: string; amount: string; available: string };

function offer(number: string, balanceDue: string, advances: Row[], credits: Row[]): CreditsOffer {
  const all: Credit[] = [
    ...advances.map((r) => ({ kind: "advance" as const, ...r })),
    ...credits.map((r) => ({ kind: "credit" as const, ...r })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const totalP = all.reduce((s, c) => s + toPaise(c.available), 0);
  return { number, balanceDue, credits: all, total: fromPaise(totalP) };
}

export interface Application {
  kind: "advance" | "credit";
  id: string;
  amount: string;
}

/**
 * Put the chosen credits against the document, in one transaction.
 *
 * Each one is checked against both ends — never more than the credit has
 * spare, never more than the document still owes — and the running balance is
 * carried through the loop, so two credits that each fit on their own cannot
 * together overshoot the bill.
 */
export async function applyCredits(
  tx: Tx,
  side: Side,
  documentId: string,
  applications: Application[],
): Promise<{ balanceDue: string; applied: string }> {
  if (!applications.length) throw new PostingError("Nothing chosen to apply");
  return side === "vendor"
    ? applyToBill(tx, documentId, applications)
    : applyToInvoice(tx, documentId, applications);
}

async function applyToBill(tx: Tx, billId: string, applications: Application[]) {
  const bill = await tx.query.bills.findFirst({ where: eq(bills.id, billId) });
  if (!bill) throw new PostingError("Bill not found");
  if (bill.status !== "open" && bill.status !== "partially_paid") {
    throw new PostingError(`Bill ${bill.number} is not open`);
  }

  let balanceP = toPaise(bill.balanceDue);
  let appliedP = 0;
  // A credit leaves the bill OPEN at a smaller balance while an advance makes
  // it partially paid — the same distinction the credit-note and payment paths
  // already draw, because "what have we actually paid this vendor" must stay
  // answerable from the status alone.
  let paidAny = bill.status === "partially_paid";

  for (const app of applications) {
    const amountP = toPaise(app.amount);
    if (amountP <= 0) throw new PostingError("Application amounts must be positive");
    if (amountP > balanceP) throw new PostingError(`Applied total exceeds the balance due on ${bill.number}`);

    if (app.kind === "advance") {
      const payment = await tx.query.vendorPayments.findFirst({ where: eq(vendorPayments.id, app.id) });
      if (!payment) throw new PostingError("Payment not found");
      if (payment.vendorId !== bill.vendorId) throw new PostingError(`Payment ${payment.number} belongs to a different vendor`);
      if (amountP > toPaise(payment.unappliedAmount)) {
        throw new PostingError(`${payment.number} has only ${payment.unappliedAmount} unapplied`);
      }
      await tx.insert(vendorPaymentApplications).values({
        paymentId: payment.id,
        billId: bill.id,
        amountApplied: app.amount,
      });
      await tx
        .update(vendorPayments)
        .set({ unappliedAmount: fromPaise(toPaise(payment.unappliedAmount) - amountP) })
        .where(eq(vendorPayments.id, payment.id));
      paidAny = true;
    } else {
      const credit = await tx.query.vendorCredits.findFirst({ where: eq(vendorCredits.id, app.id) });
      if (!credit) throw new PostingError("Vendor credit not found");
      if (credit.vendorId !== bill.vendorId) throw new PostingError(`Credit ${credit.number} belongs to a different vendor`);
      if (credit.status !== "open") throw new PostingError(`Credit ${credit.number} is not open`);
      if (amountP > toPaise(credit.balance)) {
        throw new PostingError(`${credit.number} has only ${credit.balance} left`);
      }
      await tx.insert(vendorCreditApplications).values({
        vendorCreditId: credit.id,
        billId: bill.id,
        amountApplied: app.amount,
      });
      const leftP = toPaise(credit.balance) - amountP;
      await tx
        .update(vendorCredits)
        .set({ balance: fromPaise(leftP), status: leftP === 0 ? "closed" : "open" })
        .where(eq(vendorCredits.id, credit.id));
    }

    balanceP -= amountP;
    appliedP += amountP;
  }

  const status = balanceP === 0 ? "paid" : paidAny ? "partially_paid" : "open";
  await tx
    .update(bills)
    .set({ balanceDue: fromPaise(balanceP), status, updatedAt: new Date() })
    .where(eq(bills.id, bill.id));
  return { balanceDue: fromPaise(balanceP), applied: fromPaise(appliedP) };
}

async function applyToInvoice(tx: Tx, invoiceId: string, applications: Application[]) {
  const invoice = await tx.query.invoices.findFirst({ where: eq(invoices.id, invoiceId) });
  if (!invoice) throw new PostingError("Invoice not found");
  if (invoice.status !== "sent" && invoice.status !== "partially_paid") {
    throw new PostingError(`Invoice ${invoice.number} is not open`);
  }

  let balanceP = toPaise(invoice.balanceDue);
  let appliedP = 0;
  let paidAny = invoice.status === "partially_paid";

  for (const app of applications) {
    const amountP = toPaise(app.amount);
    if (amountP <= 0) throw new PostingError("Application amounts must be positive");
    if (amountP > balanceP) throw new PostingError(`Applied total exceeds the balance due on ${invoice.number}`);

    if (app.kind === "advance") {
      const payment = await tx.query.customerPayments.findFirst({ where: eq(customerPayments.id, app.id) });
      if (!payment) throw new PostingError("Payment not found");
      if (payment.customerId !== invoice.customerId) {
        throw new PostingError(`Payment ${payment.number} belongs to a different customer`);
      }
      if (amountP > toPaise(payment.unappliedAmount)) {
        throw new PostingError(`${payment.number} has only ${payment.unappliedAmount} unapplied`);
      }
      await tx.insert(paymentApplications).values({
        paymentId: payment.id,
        invoiceId: invoice.id,
        amountApplied: app.amount,
      });
      await tx
        .update(customerPayments)
        .set({ unappliedAmount: fromPaise(toPaise(payment.unappliedAmount) - amountP) })
        .where(eq(customerPayments.id, payment.id));
      paidAny = true;
    } else {
      const note = await tx.query.creditNotes.findFirst({ where: eq(creditNotes.id, app.id) });
      if (!note) throw new PostingError("Credit note not found");
      if (note.customerId !== invoice.customerId) {
        throw new PostingError(`Credit note ${note.number} belongs to a different customer`);
      }
      if (note.status !== "open") throw new PostingError(`Credit note ${note.number} is not open`);
      if (amountP > toPaise(note.balance)) {
        throw new PostingError(`${note.number} has only ${note.balance} left`);
      }
      await tx.insert(creditNoteApplications).values({
        creditNoteId: note.id,
        invoiceId: invoice.id,
        amountApplied: app.amount,
      });
      const leftP = toPaise(note.balance) - amountP;
      await tx
        .update(creditNotes)
        .set({ balance: fromPaise(leftP), status: leftP === 0 ? "closed" : "open" })
        .where(eq(creditNotes.id, note.id));
    }

    balanceP -= amountP;
    appliedP += amountP;
  }

  const status = balanceP === 0 ? "paid" : paidAny ? "partially_paid" : "sent";
  await tx
    .update(invoices)
    .set({ balanceDue: fromPaise(balanceP), status, updatedAt: new Date() })
    .where(eq(invoices.id, invoice.id));
  return { balanceDue: fromPaise(balanceP), applied: fromPaise(appliedP) };
}


/* ── The whole party at once ───────────────────────────────────────────────
 *
 * Applying credits a document at a time is right when you are looking at the
 * document. It is the wrong shape for clearing a backlog: after the Zoho load
 * 26 customers and 23 vendors carried money on account against open documents
 * they plainly settled, and matching them one invoice at a time is sixty
 * screens of the same decision.
 *
 * So: propose the whole party's allocation, oldest credit against oldest
 * document, show it, and post it only when somebody says so. The proposal is
 * ARITHMETIC, not judgement — it never guesses which invoice a payment was
 * "really" for, it just fills the oldest debt first, which is what a ledger
 * does when nobody says otherwise. Anything it gets wrong is visible before
 * it is posted, and the per-document dialog is still there for the cases that
 * need a person.
 */

/** One open document a party's credit could go against. */
export interface OpenDocument {
  id: string;
  number: string;
  date: string;
  /** What is still owed on it before anything here is applied. */
  balanceDue: string;
}

/** One line of the proposal: this credit, that much, onto that document. */
export interface PlannedApplication {
  documentId: string;
  documentNumber: string;
  kind: "advance" | "credit";
  id: string;
  number: string;
  amount: string;
}

export interface CreditPlan {
  documents: OpenDocument[];
  credits: Credit[];
  /** Oldest credit against oldest document, in the order it would be posted. */
  plan: PlannedApplication[];
  /** Totals, so a person can check the arithmetic without adding it up. */
  totalOwed: string;
  totalAvailable: string;
  totalApplied: string;
  /** What is left on each side once the plan is posted. */
  owedAfter: string;
  availableAfter: string;
}

/** Everything of this party's that is open, oldest first. */
async function openDocuments(side: Side, contactId: string): Promise<OpenDocument[]> {
  if (side === "vendor") {
    const rows = await db
      .select({ id: bills.id, number: bills.number, date: bills.billDate, balanceDue: bills.balanceDue })
      .from(bills)
      .where(and(eq(bills.vendorId, contactId), inArray(bills.status, ["open", "partially_paid"]), gt(bills.balanceDue, "0")))
      .orderBy(bills.billDate, bills.number);
    return rows;
  }
  return db
    .select({ id: invoices.id, number: invoices.number, date: invoices.invoiceDate, balanceDue: invoices.balanceDue })
    .from(invoices)
    .where(and(eq(invoices.customerId, contactId), inArray(invoices.status, ["sent", "partially_paid"]), gt(invoices.balanceDue, "0")))
    .orderBy(invoices.invoiceDate, invoices.number);
}

/** Everything spare on this party's ledger, oldest first. */
async function partyCredits(side: Side, contactId: string): Promise<Credit[]> {
  const [advances, notes] =
    side === "vendor"
      ? await Promise.all([
          db
            .select({
              id: vendorPayments.id,
              number: vendorPayments.number,
              date: vendorPayments.paymentDate,
              amount: vendorPayments.amount,
              available: vendorPayments.unappliedAmount,
            })
            .from(vendorPayments)
            .where(and(eq(vendorPayments.vendorId, contactId), gt(vendorPayments.unappliedAmount, "0"))),
          db
            .select({
              id: vendorCredits.id,
              number: vendorCredits.number,
              date: vendorCredits.creditDate,
              amount: vendorCredits.total,
              available: vendorCredits.balance,
            })
            .from(vendorCredits)
            .where(and(eq(vendorCredits.vendorId, contactId), eq(vendorCredits.status, "open"), gt(vendorCredits.balance, "0"))),
        ])
      : await Promise.all([
          db
            .select({
              id: customerPayments.id,
              number: customerPayments.number,
              date: customerPayments.paymentDate,
              amount: customerPayments.amount,
              available: customerPayments.unappliedAmount,
            })
            .from(customerPayments)
            .where(and(eq(customerPayments.customerId, contactId), gt(customerPayments.unappliedAmount, "0"))),
          db
            .select({
              id: creditNotes.id,
              number: creditNotes.number,
              date: creditNotes.creditNoteDate,
              amount: creditNotes.total,
              available: creditNotes.balance,
            })
            .from(creditNotes)
            .where(and(eq(creditNotes.customerId, contactId), eq(creditNotes.status, "open"), gt(creditNotes.balance, "0"))),
        ]);

  return [
    ...advances.map((a) => ({ ...a, kind: "advance" as const })),
    ...notes.map((n) => ({ ...n, kind: "credit" as const })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}

/**
 * What applying this party's credit would do, without doing any of it.
 */
export async function creditPlanFor(side: Side, contactId: string): Promise<CreditPlan> {
  const [documents, credits] = await Promise.all([openDocuments(side, contactId), partyCredits(side, contactId)]);

  // Paise throughout: allocating in rupees leaves a stray paisa on a document
  // that then cannot be closed.
  const left = credits.map((c) => ({ c, leftP: toPaise(c.available) }));
  const plan: PlannedApplication[] = [];
  let appliedP = 0;

  for (const doc of documents) {
    let needP = toPaise(doc.balanceDue);
    for (const entry of left) {
      if (needP === 0) break;
      if (entry.leftP === 0) continue;
      const takeP = Math.min(needP, entry.leftP);
      plan.push({
        documentId: doc.id,
        documentNumber: doc.number,
        kind: entry.c.kind,
        id: entry.c.id,
        number: entry.c.number,
        amount: fromPaise(takeP),
      });
      entry.leftP -= takeP;
      needP -= takeP;
      appliedP += takeP;
    }
  }

  const owedP = documents.reduce((s, d) => s + toPaise(d.balanceDue), 0);
  const availableP = credits.reduce((s, c) => s + toPaise(c.available), 0);
  return {
    documents,
    credits,
    plan,
    totalOwed: fromPaise(owedP),
    totalAvailable: fromPaise(availableP),
    totalApplied: fromPaise(appliedP),
    owedAfter: fromPaise(owedP - appliedP),
    availableAfter: fromPaise(availableP - appliedP),
  };
}

/**
 * Post a plan, in one transaction.
 *
 * The lines are grouped back onto their documents and handed to the same
 * per-document path the dialog uses, so every guard it enforces — the credit
 * belongs to this party, the document is still open, nothing exceeds what is
 * available — is enforced here too. One bad line rolls the whole party back.
 */
export async function applyCreditPlan(
  tx: Tx,
  side: Side,
  lines: PlannedApplication[],
): Promise<{ documents: number; applied: string }> {
  if (!lines.length) throw new PostingError("Nothing chosen to apply");

  const byDocument = new Map<string, Application[]>();
  for (const l of lines) {
    const list = byDocument.get(l.documentId) ?? [];
    list.push({ kind: l.kind, id: l.id, amount: l.amount });
    byDocument.set(l.documentId, list);
  }

  let appliedP = 0;
  for (const [documentId, applications] of byDocument) {
    const out = await applyCredits(tx, side, documentId, applications);
    appliedP += toPaise(out.applied);
  }
  return { documents: byDocument.size, applied: fromPaise(appliedP) };
}
