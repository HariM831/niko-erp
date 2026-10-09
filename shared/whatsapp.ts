/**
 * A phone number as WhatsApp's click-to-chat link wants it — shared by the
 * egg messages (server) and the payslips (client), so both read a number the
 * same way.
 */

/** A number for wa.me: mobile before phone, India's 91 on a bare ten digits. */
export function whatsappNumber(mobile: string | null | undefined, phone?: string | null): string | null {
  for (const raw of [mobile, phone]) {
    let d = (raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
    // Zoho kept some as "+91-0…": the trunk 0 has no place after a country code.
    if (d.length === 13 && d.startsWith("910")) d = `91${d.slice(3)}`;
    if (d.length === 10) return `91${d}`;
    if (d.length >= 11) return d;
  }
  return null;
}
