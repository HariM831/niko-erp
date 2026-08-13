import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Banner, SettingsHeader } from "../components/settings-ui";

interface Preferences {
  discountLevel: string;
  discountBeforeTax: boolean;
  enableAdjustment: boolean;
  enableShippingCharge: boolean;
  taxTreatment: string;
  roundingMode: string;
  roundingIncrement: string;
  quantityDecimals: number;
  allowDuplicateItemNames: boolean;
  preventNegativeStock: boolean;
  showOutOfStockWarning: boolean;
  notifyOnReorderLevel: boolean;
  allowDuplicateContactNames: boolean;
  defaultCustomerType: string;
  enableCreditLimit: boolean;
  requireAccountCode: boolean;
}

/** Zoho puts a bold question above each group, with the options beneath. */
function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h3 className="text-[13px] font-medium text-[#212529]">{title}</h3>
      {hint && <p className="mt-0.5 max-w-2xl text-[12px] text-gray-500">{hint}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

function Radio({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-0.5" />
      <span>
        <span className="text-[13px]">{label}</span>
        {hint && <span className="block text-[12px] text-gray-500">{hint}</span>}
      </span>
    </label>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? "" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className={`text-[13px] ${disabled ? "text-gray-500" : ""}`}>{label}</span>
        {hint && <span className="block text-[12px] text-gray-500">{hint}</span>}
      </span>
    </label>
  );
}

export function PreferencesSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api<Preferences>("/api/settings/preferences"),
  });
  const [form, setForm] = useState<Preferences | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const set = (patch: Partial<Preferences>) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const { requireAccountCode: _fixed, ...body } = form;
      await api("/api/settings/preferences", { method: "PATCH", body });
      await qc.invalidateQueries();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !form) return <div className="text-[13px] text-gray-500">Loading…</div>;

  return (
    <div>
      <SettingsHeader
        title="Preferences"
        description="How transactions, items and contacts behave across the whole organisation."
      />
      {error && <Banner tone="error">{error}</Banner>}
      {saved && <Banner tone="success">Preferences saved.</Banner>}

      <div className="max-w-2xl">
        <h2 className="mb-4 border-b pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Transactions
        </h2>

        <Group title="Do you give discounts?">
          <Radio
            name="discount"
            checked={form.discountLevel === "none"}
            onChange={() => set({ discountLevel: "none" })}
            label="I don't give discounts"
          />
          <Radio
            name="discount"
            checked={form.discountLevel === "line"}
            onChange={() => set({ discountLevel: "line" })}
            label="At line item level"
          />
          {form.discountLevel !== "none" && (
            <div className="ml-6">
              <Check
                checked={form.discountBeforeTax}
                onChange={(v) => set({ discountBeforeTax: v })}
                label="Discount before tax"
                hint="Tax is computed on the discounted amount rather than the full rate."
              />
            </div>
          )}
        </Group>

        <Group title="Select any additional charges you'd like to add">
          <Check
            checked={form.enableAdjustment}
            onChange={(v) => set({ enableAdjustment: v })}
            label="Adjustments"
          />
          <Check
            checked={form.enableShippingCharge}
            onChange={(v) => set({ enableShippingCharge: v })}
            label="Freight / shipping charges"
            hint="The freight block on bills, charged to the transporter as its own expense."
          />
        </Group>

        <Group title="Rounding off in transactions">
          <Radio
            name="rounding"
            checked={form.roundingMode === "none"}
            onChange={() => set({ roundingMode: "none" })}
            label="No rounding"
          />
          <Radio
            name="rounding"
            checked={form.roundingMode === "whole"}
            onChange={() => set({ roundingMode: "whole" })}
            label="Round off the total to the nearest whole number"
          />
          <Radio
            name="rounding"
            checked={form.roundingMode === "increment"}
            onChange={() => set({ roundingMode: "increment" })}
            label="Round off the total to the nearest incremental value"
          />
          {form.roundingMode === "increment" && (
            <div className="ml-6 w-32">
              <input
                value={form.roundingIncrement}
                onChange={(e) => set({ roundingIncrement: e.target.value })}
                className="input"
              />
            </div>
          )}
          <p className="max-w-2xl text-[12px] text-gray-500">
            The difference is recorded as round-off on the document, so it still ties to its own
            lines whichever setting is chosen.
          </p>
        </Group>

        <h2 className="mb-4 border-b pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Items &amp; Inventory
        </h2>

        <Group title="Set a decimal place for item quantities">
          <div className="w-32">
            <select
              value={String(form.quantityDecimals)}
              onChange={(e) => set({ quantityDecimals: Number(e.target.value) })}
              className="input"
            >
              {[0, 1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </Group>

        <Group title="Duplicate item name">
          <Check
            checked={form.allowDuplicateItemNames}
            onChange={(v) => set({ allowDuplicateItemNames: v })}
            label="Allow duplicate item names"
            hint="With this off, a new item whose name already exists is refused."
          />
        </Group>

        <Group title="Inventory">
          <Check
            checked={form.preventNegativeStock}
            onChange={(v) => set({ preventNegativeStock: v })}
            label="Prevent stock from going below zero"
            hint="An adjustment that would take an item negative is refused outright."
          />
          <Check
            checked={form.showOutOfStockWarning}
            onChange={(v) => set({ showOutOfStockWarning: v })}
            label="Show an out-of-stock warning when an item's stock drops below zero"
          />
          <Check
            checked={form.notifyOnReorderLevel}
            onChange={(v) => set({ notifyOnReorderLevel: v })}
            label="Flag an item when its stock reaches the reorder level"
          />
        </Group>

        <h2 className="mb-4 border-b pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Customers &amp; Vendors
        </h2>

        <Group title="Duplicate display name">
          <Check
            checked={form.allowDuplicateContactNames}
            onChange={(v) => set({ allowDuplicateContactNames: v })}
            label="Allow duplicates for customer and vendor display name"
          />
        </Group>

        <Group
          title="Default customer type"
          hint="Preselected when a new customer is created."
        >
          <Radio
            name="custtype"
            checked={form.defaultCustomerType === "business"}
            onChange={() => set({ defaultCustomerType: "business" })}
            label="Business"
          />
          <Radio
            name="custtype"
            checked={form.defaultCustomerType === "individual"}
            onChange={() => set({ defaultCustomerType: "individual" })}
            label="Individual"
          />
        </Group>

        <Group title="Customer credit limit">
          <Check
            checked={form.enableCreditLimit}
            onChange={(v) => set({ enableCreditLimit: v })}
            label="Enforce credit limits"
            hint="Issuing an invoice that would put a customer past their limit is refused. Turn off to record the limit without acting on it."
          />
        </Group>

        <h2 className="mb-4 border-b pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Accountant
        </h2>

        <Group title="Chart of accounts">
          <Check
            checked
            disabled
            onChange={() => {}}
            label="Account code is mandatory and unique"
            hint="Always on here, unlike Zoho: every account is referred to by code throughout EGGSY, so one without a code would have nothing to show."
          />
        </Group>

        <div className="mt-2">
          <button onClick={() => void save()} disabled={busy} className="btn-primary">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
