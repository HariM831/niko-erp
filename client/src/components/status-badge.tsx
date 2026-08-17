/**
 * Colored status text (uppercase, no pill) with due/overdue awareness.
 *
 * Its own module so the quick-search dropdown can show a status without
 * importing the list page that renders the dropdown.
 */
const STATUS_TEXT: Record<string, string> = {
  draft: "text-gray-500",
  sent: "text-blue-600",
  open: "text-blue-600",
  confirmed: "text-blue-600",
  issued: "text-blue-600",
  accepted: "text-green-600",
  paid: "text-green-600",
  closed: "text-green-600",
  billed: "text-green-600",
  invoiced: "text-green-600",
  posted: "text-green-600",
  partially_paid: "text-amber-600",
  partially_billed: "text-amber-600",
  declined: "text-red-600",
  void: "text-gray-400",
  cancelled: "text-red-600",
  reversed: "text-red-600",
  expired: "text-gray-400",
  overdue: "text-orange-600",
  matched: "text-green-600",
  unmatched: "text-blue-600",
  excluded: "text-gray-400",
  // Goods receipt — a truck's progress through the six stations. Blue while it
  // is moving, green once it has produced a bill, red for the two exits.
  gate_in: "text-blue-600",
  weighed_in: "text-blue-600",
  qc_passed: "text-blue-600",
  unloading: "text-amber-600",
  unloading_complete: "text-amber-600",
  gate_out: "text-amber-600",
  settled: "text-green-600",
  turned_away: "text-red-600",
};

export function StatusBadge({ status, dueDate }: { status: string; dueDate?: string }) {
  let label = status.replace(/_/g, " ");
  let cls = STATUS_TEXT[status] ?? "text-gray-500";
  if ((status === "sent" || status === "open") && dueDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (dueDate < today) {
      label = "overdue";
      cls = STATUS_TEXT.overdue!;
    } else if (dueDate === today) {
      label = "due today";
      cls = STATUS_TEXT.overdue!;
    }
  }
  return (
    <span className={`text-[11px] font-semibold uppercase tracking-wide ${cls}`}>{label}</span>
  );
}
