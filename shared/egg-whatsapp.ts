/**
 * The WhatsApp message's template language, shared by the server that fills
 * it for a day and the Settings page that previews it — so the preview is the
 * message, not a guess at it. Placeholders are Amino's, plus niko's grades.
 */
import { VISIBLE_EGG_SIZES, type EggSize } from "./egg-sizes";

export const inr = (n: number, digits = 0) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: digits });

/** Every placeholder a template can use; the settings page offers these as chips. */
export const WHATSAPP_PLACEHOLDERS: string[] = [
  "[customer_name]",
  "[delivery_date]",
  "[order_lines]",
  "[total_amount]",
  "[payment_instructions]",
  ...VISIBLE_EGG_SIZES.flatMap((s) => [`[${s}_qty]`, `[${s}_price]`]),
];

/** Fill a template. Kept apart from the day so the settings page can preview it. */
export function fillTemplate(
  template: string,
  v: {
    customerName: string;
    deliveryDate: string;
    orderLines: string;
    totalAmount: string;
    paymentInstructions: string;
    qty: Partial<Record<EggSize, number>>;
    price: Partial<Record<EggSize, number>>;
  },
): string {
  let out = template
    .replaceAll("[customer_name]", v.customerName)
    .replaceAll("[delivery_date]", v.deliveryDate)
    .replaceAll("[order_lines]", v.orderLines)
    .replaceAll("[total_amount]", v.totalAmount)
    .replaceAll("[payment_instructions]", v.paymentInstructions);
  for (const s of [...VISIBLE_EGG_SIZES, "xl" as EggSize]) {
    const p = v.price[s];
    out = out
      .replaceAll(`[${s}_qty]`, String(v.qty[s] ?? 0))
      .replaceAll(`[${s}_price]`, p != null ? `₹${inr(p, 2)}` : "—");
  }
  // No payment instructions on file leaves an empty line, not a gap of three.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
