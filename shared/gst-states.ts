/**
 * GST state/UT codes and names — the numbers are what tax is decided on
 * (CGST+SGST when a document's place of supply matches the org's own state,
 * IGST otherwise). 25 and 28 are retired and deliberately absent: Daman & Diu
 * merged into 26, and Andhra Pradesh's pre-bifurcation code gave way to 37.
 */
export const GST_STATES: Record<string, string> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan",
  "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
  "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
  "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand",
  "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
  "34": "Puducherry", "35": "Andaman & Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction",
};

/**
 * Zoho's letter codes for the same states. Zoho stores a contact's and an
 * invoice's place of supply as "AS", not "18", and the import carried those
 * across verbatim — so "AS" arrives on every edit of an imported contact and
 * has to mean Assam, not fail. Both spellings Zoho has used are listed where
 * it changed one (OR/OD, UK/UT, TS/TG, CG/CT).
 */
const ZOHO_LETTERS: Record<string, string> = {
  JK: "01", HP: "02", PB: "03", CH: "04", UK: "05", UT: "05", HR: "06", DL: "07",
  RJ: "08", UP: "09", BR: "10", SK: "11", AR: "12", NL: "13", MN: "14", MZ: "15",
  TR: "16", ML: "17", AS: "18", WB: "19", JH: "20", OD: "21", OR: "21", CG: "22",
  CT: "22", MP: "23", GJ: "24", DN: "26", DD: "26", DH: "26", MH: "27", KA: "29",
  GA: "30", LD: "31", KL: "32", TN: "33", PY: "34", AN: "35", TS: "36", TG: "36",
  AD: "37", AP: "37", LA: "38", OT: "97",
};

/**
 * The GST number for a place of supply however it was written — "18", "8"
 * → "08", "AS", "as". Anything unrecognised comes back unchanged, so the
 * caller's own check can refuse it by name rather than it vanishing.
 */
export function toGstStateCode(v: string): string {
  const t = v.trim().toUpperCase();
  if (/^\d{1,2}$/.test(t)) return t.padStart(2, "0");
  return ZOHO_LETTERS[t] ?? v;
}
