import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { CustomFieldsBlock, type CustomFieldValues } from "../components/custom-fields";

const GST_TREATMENTS = [
  ["registered_business", "Registered Business"],
  ["registered_composition", "Registered (Composition)"],
  ["unregistered_business", "Unregistered Business"],
  ["consumer", "Consumer"],
  ["overseas", "Overseas"],
  ["special_economic_zone", "Special Economic Zone"],
] as const;

const SALUTATIONS = ["Mr.", "Ms.", "Mrs.", "Dr."];

interface PersonForm {
  id?: string;
  salutation: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}
interface AddressForm {
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
}
const emptyAddress: AddressForm = { line1: "", line2: "", city: "", state: "", pincode: "" };
const emptyPerson = (): PersonForm => ({ salutation: "", firstName: "", lastName: "", email: "", phone: "", isPrimary: false });

type SubTab = "other" | "address" | "persons";

export function ContactNewPage({ type, editId }: { type: "customer" | "vendor" | "both"; editId?: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const listPath = type === "customer" ? "/sales/customers" : "/purchases/vendors";
  const [subTab, setSubTab] = useState<SubTab>("other");

  const [form, setForm] = useState({
    displayName: "",
    companyName: "",
    email: "",
    phone: "",
    gstTreatment: "consumer",
    gstin: "",
    pan: "",
    placeOfSupplyState: "",
    paymentTermsDays: "0",
    openingBalance: "",
  });
  const [billing, setBilling] = useState<AddressForm>(emptyAddress);
  const [shipping, setShipping] = useState<AddressForm>(emptyAddress);
  const [persons, setPersons] = useState<PersonForm[]>([{ ...emptyPerson(), isPrimary: true }]);
  const [customFields, setCustomFields] = useState<CustomFieldValues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: existing } = useQuery({
    queryKey: ["contact", editId],
    queryFn: () =>
      api<
        Record<string, unknown> & {
          addresses: Array<Record<string, string | undefined>>;
          persons: Array<{ id: string; salutation?: string; firstName: string; lastName?: string; email?: string; phone?: string; isPrimary: boolean }>;
        }
      >(`/api/contacts/${editId}`),
    enabled: !!editId,
  });

  useEffect(() => {
    if (!existing) return;
    const b = existing.addresses?.find((a) => a.kind === "billing");
    const s = existing.addresses?.find((a) => a.kind === "shipping");
    setForm({
      displayName: (existing.displayName as string) ?? "",
      companyName: (existing.companyName as string) ?? "",
      email: (existing.email as string) ?? "",
      phone: (existing.phone as string) ?? "",
      gstTreatment: (existing.gstTreatment as string) ?? "consumer",
      gstin: (existing.gstin as string) ?? "",
      pan: (existing.pan as string) ?? "",
      placeOfSupplyState: (existing.placeOfSupplyState as string) ?? "",
      paymentTermsDays: String(existing.paymentTermsDays ?? 0),
      openingBalance: existing.openingBalance && Number(existing.openingBalance) !== 0 ? String(existing.openingBalance) : "",
    });
    setBilling(b ? { line1: b.line1 ?? "", line2: b.line2 ?? "", city: b.city ?? "", state: b.state ?? "", pincode: b.pincode ?? "" } : emptyAddress);
    setShipping(s ? { line1: s.line1 ?? "", line2: s.line2 ?? "", city: s.city ?? "", state: s.state ?? "", pincode: s.pincode ?? "" } : emptyAddress);
    setCustomFields(
      Object.fromEntries(
        ((existing.customFieldValues ?? []) as Array<{ fieldId: string; raw: unknown }>).map((v) => [
          v.fieldId,
          v.raw,
        ]),
      ),
    );
    if (existing.persons?.length) {
      setPersons(
        existing.persons.map((p) => ({
          id: p.id,
          salutation: p.salutation ?? "",
          firstName: p.firstName,
          lastName: p.lastName ?? "",
          email: p.email ?? "",
          phone: p.phone ?? "",
          isPrimary: p.isPrimary,
        })),
      );
    }
  }, [existing]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const setB = (k: keyof AddressForm) => (e: { target: { value: string } }) => setBilling((a) => ({ ...a, [k]: e.target.value }));
  const setS = (k: keyof AddressForm) => (e: { target: { value: string } }) => setShipping((a) => ({ ...a, [k]: e.target.value }));

  const updatePerson = (i: number, patch: Partial<PersonForm>) =>
    setPersons((ps) => ps.map((p, idx) => (idx === i ? { ...p, ...patch } : patch.isPrimary ? { ...p, isPrimary: false } : p)));
  const addPerson = () => setPersons((ps) => [...ps, emptyPerson()]);
  const removePerson = (i: number) => setPersons((ps) => ps.filter((_, idx) => idx !== i));

  const hasAddress = (a: AddressForm) => a.line1 || a.city;
  const validPersons = persons.filter((p) => p.firstName.trim());

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const addresses = [
        ...(hasAddress(billing) ? [{ kind: "billing" as const, ...billing, isDefault: true }] : []),
        ...(hasAddress(shipping) ? [{ kind: "shipping" as const, ...shipping }] : []),
      ].map((a) => ({ ...a, line1: a.line1 || undefined, line2: a.line2 || undefined, city: a.city || undefined, state: a.state || undefined, pincode: a.pincode || undefined }));

      await api(editId ? `/api/contacts/${editId}` : "/api/contacts", {
        method: editId ? "PATCH" : "POST",
        body: {
          ...(editId ? {} : { type }),
          displayName: form.displayName,
          companyName: form.companyName || undefined,
          email: form.email || undefined,
          phone: form.phone || undefined,
          gstTreatment: form.gstTreatment,
          gstin: form.gstin || undefined,
          pan: form.pan || undefined,
          placeOfSupplyState: form.placeOfSupplyState || undefined,
          paymentTermsDays: Number(form.paymentTermsDays) || 0,
          openingBalance: form.openingBalance || undefined,
          customFields,
          addresses: addresses.length ? addresses : undefined,
          persons: validPersons.length
            ? validPersons.map((p) => ({
                salutation: p.salutation || undefined,
                firstName: p.firstName,
                lastName: p.lastName || undefined,
                email: p.email || undefined,
                phone: p.phone || undefined,
                isPrimary: p.isPrimary,
              }))
            : undefined,
        },
      });
      await qc.invalidateQueries();
      navigate(editId ? `${listPath}/${editId}` : listPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "input";
  const label = "label";
  const title = editId
    ? `Edit ${type === "customer" ? "Customer" : "Vendor"}`
    : type === "customer"
      ? "New Customer"
      : "New Vendor";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <button onClick={() => navigate(listPath)} className="text-xl text-gray-400 hover:text-gray-700">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid max-w-2xl grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className={label}>Primary Contact</label>
            <div className="grid grid-cols-3 gap-2">
              <select
                value={persons[0]?.salutation ?? ""}
                onChange={(e) => updatePerson(0, { salutation: e.target.value })}
                className={inputCls}
              >
                <option value="">Salutation</option>
                {SALUTATIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input
                value={persons[0]?.firstName ?? ""}
                onChange={(e) => updatePerson(0, { firstName: e.target.value, isPrimary: true })}
                placeholder="First Name"
                className={inputCls}
              />
              <input
                value={persons[0]?.lastName ?? ""}
                onChange={(e) => updatePerson(0, { lastName: e.target.value })}
                placeholder="Last Name"
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className={label}>Company Name</label>
            <input value={form.companyName} onChange={set("companyName")} className={inputCls} />
          </div>
          <div>
            <label className="label-required">Display Name *</label>
            <input value={form.displayName} onChange={set("displayName")} className={inputCls} autoFocus />
          </div>
          <div>
            <label className={label}>Email Address</label>
            <input value={form.email} onChange={set("email")} className={inputCls} />
          </div>
          <div>
            <label className={label}>Phone</label>
            <input value={form.phone} onChange={set("phone")} className={inputCls} />
          </div>
        </div>

        <div className="mt-6 max-w-2xl">
          <nav className="mb-4 flex gap-5 border-b text-[13px]">
            {(["other", "address", "persons"] as SubTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setSubTab(t)}
                className={`border-b-2 pb-2 ${
                  subTab === t ? "border-brand-500 font-medium text-brand-700" : "border-transparent text-gray-600 hover:text-gray-900"
                }`}
              >
                {t === "other" ? "Other Details" : t === "address" ? "Address" : `Contact Persons${validPersons.length > 1 ? ` (${validPersons.length})` : ""}`}
              </button>
            ))}
          </nav>

          {subTab === "other" && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label-required">GST Treatment *</label>
                <select value={form.gstTreatment} onChange={set("gstTreatment")} className={inputCls}>
                  {GST_TREATMENTS.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label-required">Place of Supply *</label>
                <input value={form.placeOfSupplyState} onChange={set("placeOfSupplyState")} maxLength={4} placeholder="State code, e.g. 29" className={inputCls} />
              </div>
              <div>
                <label className={label}>GSTIN</label>
                <input value={form.gstin} onChange={set("gstin")} maxLength={15} className={inputCls} />
              </div>
              <div>
                <label className={label}>PAN</label>
                <input value={form.pan} onChange={set("pan")} maxLength={10} className={inputCls} />
              </div>
              <div>
                <label className={label}>Payment Terms (days)</label>
                <input value={form.paymentTermsDays} onChange={set("paymentTermsDays")} className={inputCls} />
              </div>
              {!editId && (
                <div>
                  <label className={label}>Opening Balance</label>
                  <input value={form.openingBalance} onChange={set("openingBalance")} placeholder="0.00" className={inputCls} />
                </div>
              )}
              <div className="col-span-2">
                <CustomFieldsBlock
                  entity="contact"
                  value={customFields}
                  onChange={setCustomFields}
                  columns={2}
                />
              </div>
            </div>
          )}

          {subTab === "address" && (
            <div className="grid grid-cols-2 gap-8">
              <div>
                <h3 className="mb-3 text-sm font-semibold">Billing Address</h3>
                <div className="space-y-3">
                  <div>
                    <label className={label}>Street 1</label>
                    <input value={billing.line1} onChange={setB("line1")} className={inputCls} />
                  </div>
                  <div>
                    <label className={label}>Street 2</label>
                    <input value={billing.line2} onChange={setB("line2")} className={inputCls} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={label}>City</label>
                      <input value={billing.city} onChange={setB("city")} className={inputCls} />
                    </div>
                    <div>
                      <label className={label}>State</label>
                      <input value={billing.state} onChange={setB("state")} className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className={label}>Pincode</label>
                    <input value={billing.pincode} onChange={setB("pincode")} className={inputCls} />
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Shipping Address</h3>
                  <button onClick={() => setShipping(billing)} className="text-xs font-medium text-brand-600 hover:underline">
                    Copy billing address
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className={label}>Street 1</label>
                    <input value={shipping.line1} onChange={setS("line1")} className={inputCls} />
                  </div>
                  <div>
                    <label className={label}>Street 2</label>
                    <input value={shipping.line2} onChange={setS("line2")} className={inputCls} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={label}>City</label>
                      <input value={shipping.city} onChange={setS("city")} className={inputCls} />
                    </div>
                    <div>
                      <label className={label}>State</label>
                      <input value={shipping.state} onChange={setS("state")} className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className={label}>Pincode</label>
                    <input value={shipping.pincode} onChange={setS("pincode")} className={inputCls} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {subTab === "persons" && (
            <div>
              <table className="w-full text-[13px]">
                <thead className="table-head">
                  <tr>
                    <th className="border border-[#ebeaf2] px-2 py-1.5 w-24">Salutation</th>
                    <th className="border border-[#ebeaf2] px-2 py-1.5">First Name</th>
                    <th className="border border-[#ebeaf2] px-2 py-1.5">Last Name</th>
                    <th className="border border-[#ebeaf2] px-2 py-1.5">Email</th>
                    <th className="border border-[#ebeaf2] px-2 py-1.5">Phone</th>
                    <th className="border border-[#ebeaf2] px-2 py-1.5 w-16">Primary</th>
                    <th className="border border-[#ebeaf2] px-2 py-1.5 w-10" />
                  </tr>
                </thead>
                <tbody>
                  {persons.map((p, i) => (
                    <tr key={i}>
                      <td className="border border-[#ebeaf2] p-1">
                        <select value={p.salutation} onChange={(e) => updatePerson(i, { salutation: e.target.value })} className="input py-1">
                          <option value=""></option>
                          {SALUTATIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="border border-[#ebeaf2] p-1">
                        <input value={p.firstName} onChange={(e) => updatePerson(i, { firstName: e.target.value })} className="input py-1" />
                      </td>
                      <td className="border border-[#ebeaf2] p-1">
                        <input value={p.lastName} onChange={(e) => updatePerson(i, { lastName: e.target.value })} className="input py-1" />
                      </td>
                      <td className="border border-[#ebeaf2] p-1">
                        <input value={p.email} onChange={(e) => updatePerson(i, { email: e.target.value })} className="input py-1" />
                      </td>
                      <td className="border border-[#ebeaf2] p-1">
                        <input value={p.phone} onChange={(e) => updatePerson(i, { phone: e.target.value })} className="input py-1" />
                      </td>
                      <td className="border border-[#ebeaf2] p-1 text-center">
                        <input type="radio" name="primary-person" checked={p.isPrimary} onChange={() => updatePerson(i, { isPrimary: true })} />
                      </td>
                      <td className="border border-[#ebeaf2] p-1 text-center">
                        {persons.length > 1 && (
                          <button onClick={() => removePerson(i)} className="text-gray-400 hover:text-red-600">×</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button onClick={addPerson} className="mt-2 text-[13px] font-medium text-brand-600 hover:underline">
                + Add Contact Person
              </button>
            </div>
          )}
        </div>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t bg-white px-6 py-3">
        <button
          onClick={() => void save()}
          disabled={busy || !form.displayName.trim() || !form.gstTreatment || !form.placeOfSupplyState.trim()}
          className="btn-primary"
        >
          Save
        </button>
        <button onClick={() => navigate(listPath)} className="ml-2 text-[13px] text-gray-500 hover:underline">
          Cancel
        </button>
      </footer>
    </div>
  );
}
