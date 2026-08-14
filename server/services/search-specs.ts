/**
 * What each document list exposes to search, in one place.
 *
 * Declared together rather than beside each route so the nine lists can be
 * compared at a glance — it is otherwise very easy to give bills a field and
 * quietly leave invoices without it.
 *
 * The quick search matches text only. Amounts are a range in the advanced
 * search: "36841" is not a sensible substring match against 36,841.00, and
 * Zoho does not treat it as one either.
 */
import {
  billLines,
  bills,
  contacts,
  creditNoteLines,
  creditNotes,
  customerPayments,
  expenses,
  invoiceLines,
  invoices,
  journalEntries,
  journalEntryLines,
  purchaseOrderLines,
  purchaseOrders,
  vendorCreditLines,
  vendorCredits,
  vendorPayments,
} from "@shared/schema";
import type { DocumentSearch } from "./document-search";

export const billSearch: DocumentSearch = {
  id: bills.id,
  text: [bills.number, bills.vendorBillNumber, bills.reference, bills.notes],
  contactId: bills.vendorId,
  lines: {
    table: billLines,
    documentId: billLines.billId,
    text: [billLines.name, billLines.description],
    accountId: billLines.accountId,
    itemId: billLines.itemId,
  },
  advanced: {
    number: { kind: "text", col: bills.number },
    vendorBillNumber: { kind: "text", col: bills.vendorBillNumber },
    reference: { kind: "text", col: bills.reference },
    notes: { kind: "text", col: bills.notes },
    status: { kind: "eq", col: bills.status },
    vendorId: { kind: "eq", col: bills.vendorId },
    vendorPan: { kind: "contactText", on: contacts.pan },
    date: { kind: "dateRange", col: bills.billDate },
    dueDate: { kind: "dateRange", col: bills.dueDate },
    created: { kind: "dateRange", col: bills.createdAt },
    total: { kind: "numberRange", col: bills.total },
    itemId: { kind: "lineItem" },
    itemDescription: { kind: "lineText", on: billLines.description },
    account: { kind: "accountName" },
  },
};

export const invoiceSearch: DocumentSearch = {
  id: invoices.id,
  text: [invoices.number, invoices.reference, invoices.customerNotes],
  contactId: invoices.customerId,
  lines: {
    table: invoiceLines,
    documentId: invoiceLines.invoiceId,
    text: [invoiceLines.name, invoiceLines.description],
    accountId: invoiceLines.accountId,
    itemId: invoiceLines.itemId,
  },
  advanced: {
    number: { kind: "text", col: invoices.number },
    reference: { kind: "text", col: invoices.reference },
    notes: { kind: "text", col: invoices.customerNotes },
    status: { kind: "eq", col: invoices.status },
    customerId: { kind: "eq", col: invoices.customerId },
    customerGstin: { kind: "contactText", on: contacts.gstin },
    date: { kind: "dateRange", col: invoices.invoiceDate },
    dueDate: { kind: "dateRange", col: invoices.dueDate },
    created: { kind: "dateRange", col: invoices.createdAt },
    total: { kind: "numberRange", col: invoices.total },
    itemId: { kind: "lineItem" },
    itemDescription: { kind: "lineText", on: invoiceLines.description },
    account: { kind: "accountName" },
  },
};

/**
 * An expense has no lines — it posts to a single account — so the account name
 * is searched on the document itself rather than through a line.
 */
export const expenseSearch: DocumentSearch = {
  id: expenses.id,
  text: [expenses.number, expenses.reference, expenses.notes],
  contactId: expenses.vendorId,
  accountId: expenses.expenseAccountId,
  advanced: {
    number: { kind: "text", col: expenses.number },
    reference: { kind: "text", col: expenses.reference },
    notes: { kind: "text", col: expenses.notes },
    vendorId: { kind: "eq", col: expenses.vendorId },
    date: { kind: "dateRange", col: expenses.expenseDate },
    created: { kind: "dateRange", col: expenses.createdAt },
    total: { kind: "numberRange", col: expenses.amount },
    account: { kind: "accountName" },
  },
};

export const purchaseOrderSearch: DocumentSearch = {
  id: purchaseOrders.id,
  text: [purchaseOrders.number, purchaseOrders.reference],
  contactId: purchaseOrders.vendorId,
  lines: {
    table: purchaseOrderLines,
    documentId: purchaseOrderLines.purchaseOrderId,
    text: [purchaseOrderLines.name, purchaseOrderLines.description],
    accountId: purchaseOrderLines.accountId,
    itemId: purchaseOrderLines.itemId,
  },
  advanced: {
    number: { kind: "text", col: purchaseOrders.number },
    reference: { kind: "text", col: purchaseOrders.reference },
    status: { kind: "eq", col: purchaseOrders.status },
    vendorId: { kind: "eq", col: purchaseOrders.vendorId },
    created: { kind: "dateRange", col: purchaseOrders.createdAt },
    total: { kind: "numberRange", col: purchaseOrders.total },
    itemId: { kind: "lineItem" },
    account: { kind: "accountName" },
  },
};

export const vendorCreditSearch: DocumentSearch = {
  id: vendorCredits.id,
  text: [vendorCredits.number, vendorCredits.reference, vendorCredits.notes],
  contactId: vendorCredits.vendorId,
  lines: {
    table: vendorCreditLines,
    documentId: vendorCreditLines.vendorCreditId,
    text: [vendorCreditLines.name, vendorCreditLines.description],
    accountId: vendorCreditLines.accountId,
    itemId: vendorCreditLines.itemId,
  },
  advanced: {
    number: { kind: "text", col: vendorCredits.number },
    reference: { kind: "text", col: vendorCredits.reference },
    notes: { kind: "text", col: vendorCredits.notes },
    status: { kind: "eq", col: vendorCredits.status },
    vendorId: { kind: "eq", col: vendorCredits.vendorId },
    date: { kind: "dateRange", col: vendorCredits.creditDate },
    created: { kind: "dateRange", col: vendorCredits.createdAt },
    total: { kind: "numberRange", col: vendorCredits.total },
    itemId: { kind: "lineItem" },
    account: { kind: "accountName" },
  },
};

export const creditNoteSearch: DocumentSearch = {
  id: creditNotes.id,
  text: [creditNotes.number, creditNotes.reference, creditNotes.customerNotes],
  contactId: creditNotes.customerId,
  lines: {
    table: creditNoteLines,
    documentId: creditNoteLines.creditNoteId,
    text: [creditNoteLines.name, creditNoteLines.description],
    accountId: creditNoteLines.accountId,
    itemId: creditNoteLines.itemId,
  },
  advanced: {
    number: { kind: "text", col: creditNotes.number },
    reference: { kind: "text", col: creditNotes.reference },
    notes: { kind: "text", col: creditNotes.customerNotes },
    status: { kind: "eq", col: creditNotes.status },
    customerId: { kind: "eq", col: creditNotes.customerId },
    date: { kind: "dateRange", col: creditNotes.creditNoteDate },
    created: { kind: "dateRange", col: creditNotes.createdAt },
    total: { kind: "numberRange", col: creditNotes.total },
    itemId: { kind: "lineItem" },
    account: { kind: "accountName" },
  },
};

export const customerPaymentSearch: DocumentSearch = {
  id: customerPayments.id,
  text: [customerPayments.number, customerPayments.reference, customerPayments.notes],
  contactId: customerPayments.customerId,
  advanced: {
    number: { kind: "text", col: customerPayments.number },
    reference: { kind: "text", col: customerPayments.reference },
    notes: { kind: "text", col: customerPayments.notes },
    customerId: { kind: "eq", col: customerPayments.customerId },
    mode: { kind: "eq", col: customerPayments.mode },
    date: { kind: "dateRange", col: customerPayments.paymentDate },
    created: { kind: "dateRange", col: customerPayments.createdAt },
    total: { kind: "numberRange", col: customerPayments.amount },
  },
};

export const vendorPaymentSearch: DocumentSearch = {
  id: vendorPayments.id,
  text: [vendorPayments.number, vendorPayments.reference, vendorPayments.notes],
  contactId: vendorPayments.vendorId,
  advanced: {
    number: { kind: "text", col: vendorPayments.number },
    reference: { kind: "text", col: vendorPayments.reference },
    notes: { kind: "text", col: vendorPayments.notes },
    vendorId: { kind: "eq", col: vendorPayments.vendorId },
    mode: { kind: "eq", col: vendorPayments.mode },
    date: { kind: "dateRange", col: vendorPayments.paymentDate },
    created: { kind: "dateRange", col: vendorPayments.createdAt },
    total: { kind: "numberRange", col: vendorPayments.amount },
  },
};

/**
 * A journal has no contact. Its lines carry the narration's detail, so the line
 * description and the account posted to are what make it findable.
 */
export const journalSearch: DocumentSearch = {
  id: journalEntries.id,
  text: [journalEntries.entryNumber, journalEntries.narration, journalEntries.reference],
  lines: {
    table: journalEntryLines,
    documentId: journalEntryLines.entryId,
    text: [journalEntryLines.description],
    accountId: journalEntryLines.accountId,
  },
  advanced: {
    number: { kind: "text", col: journalEntries.entryNumber },
    narration: { kind: "text", col: journalEntries.narration },
    reference: { kind: "text", col: journalEntries.reference },
    status: { kind: "eq", col: journalEntries.status },
    sourceType: { kind: "eq", col: journalEntries.sourceType },
    date: { kind: "dateRange", col: journalEntries.entryDate },
    created: { kind: "dateRange", col: journalEntries.postedAt },
    account: { kind: "accountName" },
  },
};
