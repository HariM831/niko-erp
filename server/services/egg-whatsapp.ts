/**
 * The day's WhatsApp message to each customer — Amino's reminder, on niko's
 * order book (the user, 30 Sep 2026).
 *
 * A message exists only for a day whose benchmark was set for THAT day: a rate
 * carried from an earlier day is yesterday's market, and the message would
 * quote it as today's. Priced by `dayPricer`, the Loading Bay's own rule, so
 * the figure the customer reads is the figure the invoice will carry.
 *
 * Nothing is sent from here. The page opens WhatsApp with the text typed in,
 * and a person presses send — WhatsApp's click-to-chat link cannot do more.
 */
import { inArray } from "drizzle-orm";
import { contacts, eggDispatches } from "@shared/schema";
import { EGG_SIZE_LABEL, type EggSize } from "@shared/egg-sizes";
import { fillTemplate, inr } from "@shared/egg-whatsapp";
import type { Db, Tx } from "../db";
import { dayOrders, dayPricer, eggPrefs } from "./egg-sales";

type Conn = Db | Tx;

export interface WhatsappMessage {
  customerId: string;
  customerName: string;
  /** Digits with the country code, ready for wa.me — null when the contact has none. */
  phone: string | null;
  message: string;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Wed, 1 Oct 2026" — Amino's delivery date. Spelt out by hand: ICU writes September "Sept". */
const deliveryDate = (on: string) => {
  const d = new Date(`${on}T00:00:00Z`);
  return `${DAY[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** A contact's number for wa.me: mobile before phone, India's 91 on a bare ten digits. */
export function whatsappNumber(mobile: string | null, phone: string | null): string | null {
  for (const raw of [mobile, phone]) {
    let d = (raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
    // Zoho kept some as "+91-0…": the trunk 0 has no place after a country code.
    if (d.length === 13 && d.startsWith("910")) d = `91${d.slice(3)}`;
    if (d.length === 10) return `91${d}`;
    if (d.length >= 11) return d;
  }
  return null;
}

/**
 * The messages for a day, one per customer with boxes due — empty unless the
 * benchmark was set for this very date.
 */
export async function dayWhatsapp(conn: Conn, on: string): Promise<{ ready: boolean; messages: WhatsappMessage[] }> {
  const { bm, rateFor } = await dayPricer(conn, on);
  if (!bm || bm.effectiveFrom !== on) return { ready: false, messages: [] };

  const lines = (await dayOrders(conn, on)).filter(
    (l) => !l.voided && l.exception?.kind !== "skip" && l.boxes > 0,
  );
  if (!lines.length) return { ready: true, messages: [] };

  const prefs = await eggPrefs(conn);
  const dispatchIds = lines.map((l) => l.dispatch?.id).filter((v): v is string => !!v);
  const loaded = dispatchIds.length
    ? await conn.select().from(eggDispatches).where(inArray(eggDispatches.id, dispatchIds))
    : [];
  const loadedOf = new Map(loaded.map((d) => [d.id, d]));
  const people = await conn
    .select({ id: contacts.id, mobile: contacts.mobile, phone: contacts.phone })
    .from(contacts)
    .where(inArray(contacts.id, [...new Set(lines.map((l) => l.customerId))]));
  const numberOf = new Map(people.map((p) => [p.id, whatsappNumber(p.mobile, p.phone)]));

  // One message per customer, however many orders they have that day. Each
  // order is priced at its own spread; a standing order is a box count and sits
  // under Large until the bay grades it, as on the day sheets.
  const byCustomer = new Map<string, { name: string; rows: { size: EggSize; qty: number; rate: number }[] }>();
  for (const l of lines) {
    const d = l.dispatch ? loadedOf.get(l.dispatch.id) : undefined;
    const boxes: Partial<Record<EggSize, number>> = d
      ? {
          small: d.loadedSmall, medium: d.loadedMedium, large: d.loadedLarge, xl: d.loadedXl,
          jumbo: d.loadedJumbo, brown: d.loadedBrown, niko: d.loadedNiko, dirty: d.loadedDirty,
        }
      : l.sizes && Object.keys(l.sizes).length
        ? l.sizes
        : { large: l.boxes };
    const c = byCustomer.get(l.customerId) ?? { name: l.customerName, rows: [] };
    for (const [s, q] of Object.entries(boxes) as [EggSize, number][]) {
      if (!q) continue;
      c.rows.push({ size: s, qty: q, rate: rateFor(s, Number(l.spreadPerEgg ?? 0)) ?? 0 });
    }
    byCustomer.set(l.customerId, c);
  }

  const messages: WhatsappMessage[] = [];
  for (const [customerId, c] of byCustomer) {
    const qty: Partial<Record<EggSize, number>> = {};
    const price: Partial<Record<EggSize, number>> = {};
    let total = 0;
    const orderLines = c.rows
      .map((r) => {
        const rate = Math.round(r.rate * 100) / 100;
        const amount = Math.round(rate * r.qty);
        total += amount;
        qty[r.size] = (qty[r.size] ?? 0) + r.qty;
        price[r.size] = rate;
        return `${EGG_SIZE_LABEL[r.size]}: ${r.qty} boxes @ ₹${inr(rate, 2)}/box — ₹${inr(amount)}`;
      })
      .join("\n");
    messages.push({
      customerId,
      customerName: c.name,
      phone: numberOf.get(customerId) ?? null,
      message: fillTemplate(prefs.whatsappTemplate, {
        customerName: c.name,
        deliveryDate: deliveryDate(on),
        orderLines,
        totalAmount: `₹${inr(total)}`,
        paymentInstructions: prefs.paymentInstructions ?? "",
        qty,
        price,
      }),
    });
  }
  return { ready: true, messages };
}
