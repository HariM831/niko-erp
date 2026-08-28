import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, formatMoney } from "../api";

interface JournalLine {
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
}
interface JournalBySource {
  id: string;
  entryNumber: string;
  entryDate: string;
  lines: JournalLine[];
}

/**
 * The "Journal" tab Zoho shows at the bottom of every transaction — the actual
 * posted debit/credit lines behind the document, proving the double-entry
 * posting really happened. Renders nothing if this document hasn't posted
 * a journal (e.g. a draft invoice, or document types that never post one).
 */
export function JournalSection({
  sourceType,
  sourceId,
  entryId,
  heading,
  note,
}: {
  sourceType?: string;
  sourceId?: string;
  /** Show one specific entry instead of looking it up by source document. */
  entryId?: string;
  heading: string;
  note?: string;
}) {
  const url = entryId
    ? `/api/accounting/journal-entry/${entryId}`
    : `/api/accounting/journal-by-source?sourceType=${sourceType}&sourceId=${sourceId}`;
  const { data } = useQuery({
    queryKey: ["journal-section", entryId ?? `${sourceType}:${sourceId}`],
    queryFn: () => api<JournalBySource | null>(url),
    enabled: !!(entryId || (sourceType && sourceId)),
  });

  if (!data) return null;
  const totalDebit = data.lines.reduce((s, l) => s + Number(l.debit), 0);
  const totalCredit = data.lines.reduce((s, l) => s + Number(l.credit), 0);

  return (
    <div className="mt-10 print:hidden">
      <div className="mb-3 border-b">
        <span className="inline-block border-b-2 border-brand-500 pb-2 text-[13px] font-semibold text-brand-700">
          Journal
        </span>
      </div>
      <h3 className="mb-1 text-sm font-semibold">
        {heading} — <Link href={`/accountant/journals/${data.id}`} className="text-brand-600 hover:underline">{data.entryNumber}</Link>
      </h3>
      {note && <p className="mb-2 text-xs text-gray-500">{note}</p>}
      <table className="w-full max-w-2xl text-[13px]">
        <thead className="table-head">
          <tr>
            <th className="border-b border-[#ece3d5] px-3 py-2">Account</th>
            <th className="border-b border-[#ece3d5] px-3 py-2 text-right">Debit</th>
            <th className="border-b border-[#ece3d5] px-3 py-2 text-right">Credit</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i} className="border-b border-[#ece3d5]">
              <td className="px-3 py-2">{l.accountCode} · {l.accountName}</td>
              <td className="px-3 py-2 text-right tabular-nums">{Number(l.debit) > 0 ? formatMoney(l.debit) : "0.00"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{Number(l.credit) > 0 ? formatMoney(l.credit) : "0.00"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className="px-3 py-2 text-right">Total</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totalDebit)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
