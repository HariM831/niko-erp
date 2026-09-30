import { type ReactElement, useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  Building2,
  ClipboardList,
  Factory,
  ShoppingBag,
  ShoppingCart,
  SlidersHorizontal,
  Sprout,
  Search,
  Settings as SettingsIcon,
  Truck,
  UserCog,
  Users as UsersIcon,
  Wrench,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate } from "../api";
import { useAuth } from "../auth";
import {
  Badge,
  Banner,
  Chip,
  EmptyRow,
  Modal,
  NameCell,
  RowAction,
  RowActions,
  SettingsHeader,
  SettingsTable,
} from "../components/settings-ui";
import { getAccent, setAccent, type Accent } from "../theme";
import { RolesSection, UsersSection } from "./settings-users";
import { OpeningBalancesSection } from "./settings-opening";
import { LocationsSection } from "./settings-locations";
import { ReportingTagsSection } from "./settings-tags";
import { CostAnalysisSection } from "./settings-cost-analysis";
import { CustomFieldsTab } from "./settings-fields";
import { DeductionRulesSection } from "./deduction-rules";
import { OfficeSitesSection } from "./office-sites";
import { FarmHousesSection } from "./farm-houses";
import { FarmStandardsSection } from "./farm-standards";
import { FeedStandardsSection } from "./feed-standards";
import {
  DepartmentsTab,
  HolidaysTab,
  PolicyTab,
  RatesTab,
  ShiftsTab,
} from "./payroll/settings";
import {
  AccountantPrefsSection,
  ContactPrefsSection,
  InvoicePrefsSection,
  ItemPrefsSection,
  OfficePrefsSection,
  TransactionPrefsSection,
} from "./settings-preferences";
import { DateInput } from "../components/date-input";
import { EggDifferentialsSection, WhatsappMessageSection } from "./settings-egg-sales";

type Section = string;

/**
 * Zoho gives each module its own settings page with tabs across the top —
 * Preferences where the module has any, and Fields for its custom fields.
 */
interface SectionDef {
  key: Section;
  label: string;
  group: string;
  /** Entity key from shared/entities.ts, when the module carries custom fields. */
  entity?: string;
  /** Which preferences block belongs to this module, if any. */
  prefs?: "transactions" | "contacts" | "items" | "invoices" | "accountant" | "office";
  /** Screens a module owns beyond preferences and custom fields. */
  extras?: Array<{ key: string; label: string }>;
  /** [module, action] required to see this section at all. */
  perm?: [string, string];
}

const SECTIONS: SectionDef[] = [
  { key: "org", label: "Organisation Profile", group: "Organisation" },
  { key: "locations", label: "Locations", group: "Organisation" },
  { key: "appearance", label: "Appearance", group: "Organisation" },
  // Behind "Manage accounts" rather than Settings — see shared/permissions.ts.
  { key: "users", label: "Users", group: "Users & Roles", perm: ["users", "manage"] },
  { key: "roles", label: "Roles", group: "Users & Roles", perm: ["users", "manage"] },
  { key: "taxes", label: "Taxes", group: "Setup" },
  { key: "series", label: "Transaction Number Series", group: "Setup" },
  { key: "reporting-tags", label: "Reporting Tags", group: "Setup" },
  { key: "cost-analysis", label: "Cost Analysis", group: "Setup" },
  { key: "opening-balances", label: "Opening Balances", group: "Setup" },
  { key: "financial-years", label: "Financial Years & Locking", group: "Setup" },

  { key: "m-transactions", label: "Transactions", group: "Module Settings", prefs: "transactions" },
  { key: "m-contacts", label: "Customers and Vendors", group: "Module Settings", entity: "contact", prefs: "contacts" },
  { key: "m-items", label: "Items", group: "Module Settings", prefs: "items" },
  { key: "m-invoices", label: "Invoices", group: "Module Settings", prefs: "invoices" },
  {
    key: "m-egg-sales",
    label: "Egg sales",
    group: "Module Settings",
    extras: [
      { key: "differentials", label: "Size differentials" },
      { key: "whatsapp", label: "WhatsApp message" },
    ],
  },
  { key: "m-bills", label: "Bills", group: "Module Settings", entity: "bill" },
  { key: "m-expenses", label: "Expenses", group: "Module Settings", entity: "expense" },
  {
    key: "m-office",
    label: "Office",
    group: "Module Settings",
    entity: "office_receipt",
    prefs: "office",
    extras: [
      { key: "deductions", label: "Deduction Rules" },
      { key: "sites", label: "Gates & Weighbridges" },
    ],
  },
  {
    key: "m-farms",
    label: "Farms",
    group: "Module Settings",
    extras: [
      { key: "houses", label: "Houses" },
      { key: "standards", label: "Breeds & Standards" },
    ],
  },
  {
    key: "m-payroll",
    label: "Payroll",
    group: "Module Settings",
    extras: [
      { key: "departments", label: "Departments & designations" },
      { key: "shifts", label: "Shifts" },
      { key: "holidays", label: "Holidays" },
      { key: "wage-rates", label: "Wage rate card" },
      { key: "payroll-policy", label: "Statutory & policy" },
    ],
  },
  {
    key: "m-feed-mill",
    label: "Feed Mill",
    group: "Module Settings",
    extras: [{ key: "feed-standards", label: "Feed Standards" }],
  },
  { key: "m-accountant", label: "Accountant", group: "Module Settings", prefs: "accountant" },
];

/** Sections that are a form rather than a table, and so want a narrow measure. */
const FORM_SECTIONS = new Set<Section>(["org", "appearance"]);

/**
 * The landing page, laid out as Zoho's All Settings (the user, 30 Sep 2026):
 * a card per area with a tinted heading strip, its screens listed underneath,
 * the organisation-wide areas first and the modules in a panel of their own.
 * A module's extra screens open on their own tab through ?tab=.
 */
type CardLink = { label: string; to: string };
type Card = { title: string; icon: typeof Building2; strip: string; tint: string; links: CardLink[] };

const LOOKS: Record<string, { icon: typeof Building2; strip: string; tint: string }> = {
  Organisation: { icon: Building2, strip: "bg-green-50", tint: "text-green-600" },
  "Users & Roles": { icon: UsersIcon, strip: "bg-rose-50", tint: "text-rose-500" },
  Setup: { icon: SlidersHorizontal, strip: "bg-orange-50", tint: "text-orange-500" },
  General: { icon: Wrench, strip: "bg-green-50", tint: "text-green-600" },
  Sales: { icon: ShoppingCart, strip: "bg-teal-50", tint: "text-teal-600" },
  Purchases: { icon: ShoppingBag, strip: "bg-amber-50", tint: "text-amber-600" },
  Office: { icon: Truck, strip: "bg-blue-50", tint: "text-blue-600" },
  Farms: { icon: Sprout, strip: "bg-lime-50", tint: "text-lime-600" },
  Payroll: { icon: UserCog, strip: "bg-indigo-50", tint: "text-indigo-500" },
  "Feed Mill": { icon: Factory, strip: "bg-orange-50", tint: "text-orange-500" },
};
const FALLBACK = { icon: ClipboardList, strip: "bg-gray-50", tint: "text-gray-500" };

/** Which Zoho-style card each module sits under. The ones niko has and Zoho does not get their own. */
const MODULE_CARD: Record<string, string> = {
  "m-transactions": "General",
  "m-contacts": "General",
  "m-items": "General",
  "m-accountant": "General",
  "m-invoices": "Sales",
  "m-egg-sales": "Sales",
  "m-bills": "Purchases",
  "m-expenses": "Purchases",
  "m-office": "Office",
  "m-farms": "Farms",
  "m-payroll": "Payroll",
  "m-feed-mill": "Feed Mill",
};

function settingsCards(sections: SectionDef[]): { top: Card[]; modules: Card[] } {
  const card = (title: string, links: CardLink[]): Card => ({ title, ...(LOOKS[title] ?? FALLBACK), links });
  const top = ["Organisation", "Users & Roles", "Setup"]
    .map((g) => card(g, sections.filter((x) => x.group === g).map((x) => ({ label: x.label, to: `/settings/${x.key}` }))))
    .filter((c) => c.links.length);
  const order = ["General", "Sales", "Purchases", "Office", "Farms", "Payroll", "Feed Mill"];
  const modules = order
    .map((title) => {
      const defs = sections.filter((x) => x.group === "Module Settings" && MODULE_CARD[x.key] === title);
      const links: CardLink[] = defs.flatMap((d) =>
        // A module that is only preferences and fields reads as its own name, as on Zoho's card;
        // one with screens of its own lists those screens, each opening on its tab.
        d.extras?.length
          ? [
              ...d.extras.map((e) => ({ label: e.label, to: `/settings/${d.key}?tab=${e.key}` })),
              ...(d.prefs ? [{ label: `${d.label} preferences`, to: `/settings/${d.key}?tab=preferences` }] : []),
            ]
          : [{ label: d.label, to: `/settings/${d.key}` }],
      );
      return card(title, links);
    })
    .filter((c) => c.links.length);
  return { top, modules };
}

function SettingsCard({ c }: { c: Card }) {
  const Icon = c.icon;
  return (
    <section className="mb-5 break-inside-avoid rounded-lg border border-gray-100 bg-white p-2 shadow-sm">
      <div className={`flex items-center gap-2.5 rounded-md px-3 py-2.5 ${c.strip}`}>
        <Icon size={18} className={c.tint} />
        <h2 className="text-[16px] font-medium text-[#212529]">{c.title}</h2>
      </div>
      <ul className="py-1">
        {c.links.map((l) => (
          <li key={l.to}>
            <Link href={l.to} className="block rounded px-3 py-2.5 text-[14px] text-[#212529] hover:bg-gray-50 hover:text-[#e06d05]">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SettingsHome({ sections }: { sections: SectionDef[] }) {
  const [search, setSearch] = useState("");
  const { data: org } = useQuery({ queryKey: ["org"], queryFn: () => api<{ name: string } | null>("/api/settings/org") });
  const q = search.trim().toLowerCase();
  const narrow = (cards: Card[]) =>
    cards
      .map((c) => ({ ...c, links: q && !c.title.toLowerCase().includes(q) ? c.links.filter((l) => l.label.toLowerCase().includes(q)) : c.links }))
      .filter((c) => c.links.length);
  const { top, modules } = settingsCards(sections);
  const shownTop = narrow(top);
  const shownModules = narrow(modules);
  const columns = "columns-1 gap-5 sm:columns-2 lg:columns-3 xl:columns-4 2xl:columns-5";

  return (
    <div className="h-full overflow-y-auto bg-[#f7f7fa]">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b bg-white px-4 py-3 sm:px-8">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg border border-blue-100 bg-blue-50 text-blue-600">
            <SettingsIcon size={20} />
          </span>
          <div>
            <h1 className="text-[20px] font-semibold leading-tight text-[#212529]">All Settings</h1>
            <div className="text-[13px] text-gray-500">{org?.name ?? ""}</div>
          </div>
        </div>
        <div className="relative mx-auto w-full max-w-md sm:w-auto sm:flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-blue-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search settings" className="input w-full pl-9" />
        </div>
      </div>

      <div className="px-4 py-6 sm:px-8">
        {shownTop.length > 0 && (
          <div className={columns}>
            {shownTop.map((c) => (
              <SettingsCard key={c.title} c={c} />
            ))}
          </div>
        )}
        {shownModules.length > 0 && (
          <div className="mt-4 rounded-xl bg-white px-4 pb-1 pt-5 shadow-sm sm:px-6">
            <h2 className="mb-5 text-[20px] font-normal text-[#212529]">Module Settings</h2>
            <div className={columns}>
              {shownModules.map((c) => (
                <SettingsCard key={c.title} c={c} />
              ))}
            </div>
          </div>
        )}
        {shownTop.length + shownModules.length === 0 && (
          <p className="py-16 text-center text-[13px] text-gray-500">No setting matches “{search}”.</p>
        )}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { can } = useAuth();
  // Hiding the entry is presentation only — every route behind it enforces the
  // same permission server-side, so a guessed URL gains nothing.
  const sections = SECTIONS.filter((s) => !s.perm || can(s.perm[0], s.perm[1]));
  // /settings is the All Settings page; /settings/<section> opens one, with the list beside it.
  const active = /^\/settings\/([^/?#]+)/.exec(location)?.[1] ?? null;
  const tabParam = new URLSearchParams(search).get("tab") ?? undefined;
  if (!active) return <SettingsHome sections={sections} />;
  const activeDef = sections.find((x) => x.key === active);
  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex shrink-0 gap-2 overflow-x-auto border-b bg-white p-2 lg:block lg:w-60 lg:overflow-x-visible lg:border-b-0 lg:border-r lg:p-4">
        <Link href="/settings" className="mb-3 hidden text-[13px] font-medium text-[#e06d05] hover:underline lg:block">
          ← All Settings
        </Link>
        {[...new Set(sections.map((s) => s.group))].map((group) => (
          <div key={group} className="flex shrink-0 gap-2 lg:mb-3 lg:block">
            <div className="mb-1 hidden px-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 lg:block">
              {group}
            </div>
            {sections.filter((s) => s.group === group).map((s) => (
              <button
                key={s.key}
                onClick={() => navigate(`/settings/${s.key}`)}
                className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[13px] lg:block lg:w-full lg:rounded lg:border-0 lg:px-2 lg:py-1.5 lg:text-left ${
                  active === s.key
                    ? "border-brand-300 bg-brand-50 font-medium text-brand-700"
                    : "border-gray-200 hover:bg-gray-50"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto bg-white px-4 py-4 sm:px-8 sm:py-6">
        {/* Zoho runs settings full-bleed on white — the form-shaped sections
            still read better with a measure on them. */}
        <div className={FORM_SECTIONS.has(active) ? "max-w-3xl" : ""}>
          {!activeDef && <p className="text-[13px] text-gray-500">No such setting. <Link href="/settings" className="text-[#e06d05] hover:underline">All Settings</Link></p>}
          {active === "org" && <OrgSection />}
          {active === "locations" && <LocationsSection />}
          {active === "appearance" && <AppearanceSection />}
          {active === "users" && activeDef && <UsersSection />}
          {active === "roles" && activeDef && <RolesSection />}
          {active === "taxes" && <TaxesSection />}
          {active === "series" && <SeriesSection />}
          {active === "reporting-tags" && <ReportingTagsSection />}
          {active === "cost-analysis" && <CostAnalysisSection />}
          {active === "opening-balances" && <OpeningBalancesSection />}
          {active === "financial-years" && <FinancialYearsSection />}
          {activeDef?.group === "Module Settings" && (
            <ModuleSettings key={`${activeDef.key}:${tabParam ?? ""}`} def={activeDef} initialTab={tabParam} />
          )}
        </div>
      </div>
    </div>
  );
}

// Swatches are each palette's own 600, the step the hero banners and links
// use, so the dot shows the colour the screens will actually be built from.
const ACCENT_CHOICES: Array<{ key: Accent; label: string; note: string; swatch: string }> = [
  { key: "yolk", label: "Yolk", note: "The original egg-yolk orange", swatch: "#e06d05" },
  { key: "crimson", label: "Crimson", note: "The niko logo red", swatch: "#ce0d0d" },
  { key: "terracotta", label: "Terracotta", note: "Earthier, deeper cousin of the yolk", swatch: "#b44a1e" },
  { key: "forest", label: "Forest", note: "Farm green, held dark to stay clear of success", swatch: "#2f7038" },
  { key: "teal", label: "Teal", note: "Cool and modern; darkens the sidebar", swatch: "#0d7c72" },
  { key: "indigo", label: "Indigo", note: "Deep blue for a finance feel; darkens the sidebar", swatch: "#3a4ab8" },
];

function AppearanceSection() {
  const [accent, setLocal] = useState<Accent>(() => getAccent());

  const choose = (key: Accent) => {
    setAccent(key);
    setLocal(key);
  };

  return (
    <>
      <SettingsHeader
        title="Appearance"
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ACCENT_CHOICES.map((a) => (
          <button
            key={a.key}
            onClick={() => choose(a.key)}
            aria-pressed={accent === a.key}
            className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
              accent === a.key
                ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500"
                : "border-gray-200 hover:bg-gray-50"
            }`}
          >
            <span
              className="h-8 w-8 shrink-0 rounded-full"
              style={{ backgroundColor: a.swatch }}
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{a.label}</span>
              <span className="block truncate text-[12px] text-gray-500">{a.note}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function OrgSection() {
  const qc = useQueryClient();
  const { data: org } = useQuery({
    queryKey: ["org"],
    queryFn: () => api<Record<string, string | null> | null>("/api/settings/org"),
  });
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!org) return;
    setForm({
      name: org.name ?? "",
      gstin: org.gstin ?? "",
      pan: org.pan ?? "",
      stateCode: org.stateCode ?? "",
      phone: org.phone ?? "",
      email: org.email ?? "",
      address: org.address ?? "",
      city: org.city ?? "",
      state: org.state ?? "",
      pincode: org.pincode ?? "",
    });
  }, [org]);

  const set = (k: string) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const save = async () => {
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ""));
      await api("/api/settings/org", { method: "PATCH", body });
      await qc.invalidateQueries({ queryKey: ["org"] });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const fields: Array<[key: string, label: string, wide?: boolean]> = [
    ["name", "Business Name *", true],
    ["gstin", "GSTIN"],
    ["pan", "PAN"],
    ["phone", "Phone"],
    ["email", "Email"],
    ["address", "Address", true],
    ["city", "City"],
    ["state", "State"],
    ["pincode", "Pincode"],
    ["stateCode", "State Code (place of supply)"],
  ];

  return (
    <div>
      <SettingsHeader
        title="Organisation Profile"
      />
      {error && <Banner tone="error">{error}</Banner>}
      {saved && <Banner tone="success">Organisation profile saved.</Banner>}

      <div className="grid max-w-2xl grid-cols-2 gap-4">
        {fields.map(([k, l, wide]) => (
          <div key={k} className={wide ? "col-span-2" : ""}>
            <label className={l.endsWith("*") ? "label-required" : "label"}>{l}</label>
            <input value={form[k] ?? ""} onChange={set(k)} className="input" />
          </div>
        ))}
      </div>

      <div className="mt-5">
        <button onClick={() => void save()} disabled={!form.name?.trim()} className="btn-primary">
          Save
        </button>
      </div>
    </div>
  );
}

interface Tax {
  id: string;
  name: string;
  rate: string;
  isActive: boolean;
}

function TaxesSection() {
  const qc = useQueryClient();
  const { data: taxes, isLoading } = useQuery({
    queryKey: ["taxes"],
    queryFn: () => api<Tax[]>("/api/taxes"),
  });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["taxes"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div>
      <SettingsHeader
        title="Taxes"
        actions={
          <button onClick={() => setAdding(true)} className="btn-primary">
            + New Tax
          </button>
        }
      />
      {error && <Banner tone="error">{error}</Banner>}

      <SettingsTable
        columns={[
          { label: "Name" },
          { label: "Rate", align: "right", width: "w-32" },
          { label: "Status", width: "w-28" },
          { label: "", align: "right", width: "w-32" },
        ]}
      >
        {isLoading && <EmptyRow colSpan={4}>Loading…</EmptyRow>}
        {taxes?.length === 0 && <EmptyRow colSpan={4}>No tax rates yet.</EmptyRow>}
        {taxes?.map((t) => (
          <tr key={t.id} className="s-row">
            <td className="s-td">
              <NameCell name={t.name} />
            </td>
            <td className="s-td text-right tabular-nums">{Number(t.rate)}%</td>
            <td className="s-td">
              {t.isActive ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Inactive</Badge>}
            </td>
            <td className="s-td">
              <RowActions>
                <RowAction
                  tone={t.isActive ? "danger" : "default"}
                  onClick={() =>
                    void run(() =>
                      api(`/api/taxes/${t.id}`, {
                        method: "PATCH",
                        body: { isActive: !t.isActive },
                      }),
                    )
                  }
                >
                  {t.isActive ? "Deactivate" : "Activate"}
                </RowAction>
              </RowActions>
            </td>
          </tr>
        ))}
      </SettingsTable>

      {adding && (
        <NewTaxModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ["taxes"] });
          }}
        />
      )}
    </div>
  );
}

function NewTaxModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/taxes", { method: "POST", body: { name, rate: Number(rate).toFixed(3) } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New Tax"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim() || rate === ""}
            className="btn-primary"
          >
            Add Tax
          </button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <label className="label-required">Tax Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="GST 18%"
            className="input"
          />
        </div>
        <div>
          <label className="label-required">Rate % *</label>
          <input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="18"
            className="input"
          />
        </div>
      </div>
    </Modal>
  );
}

interface SeriesEntity {
  id: string;
  entity: string;
  prefix: string;
  nextNumber: number;
  padding: number;
}
interface NumberSeries {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  entities: SeriesEntity[];
}

/** Column order for the series grid, following the order Zoho lists modules in. */
const SERIES_COLUMNS: Array<[entity: string, label: string]> = [
  ["invoice", "Invoice"],
  ["credit_note", "Credit Note"],
  ["customer_payment", "Customer Payment"],
  ["bill", "Bill"],
  ["purchase_order", "Purchase Order"],
  ["vendor_credit", "Vendor Credit"],
  ["vendor_payment", "Vendor Payment"],
  ["expense", "Expense"],
  ["journal_entry", "Journal"],
  ["fixed_asset", "Fixed Asset"],
  ["inventory_adjustment", "Inventory Adjustment"],
];

function SeriesSection() {
  const qc = useQueryClient();
  const { data: series } = useQuery({
    queryKey: ["series"],
    queryFn: () => api<NumberSeries[]>("/api/settings/series"),
  });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["series"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div>
      <SettingsHeader
        title="Transaction Number Series"
        actions={
          <button onClick={() => setAdding(true)} className="btn-primary">
            + New Series
          </button>
        }
      />
      {error && <Banner tone="error">{error}</Banner>}

      <div className="overflow-x-auto">
        {/* An editable matrix rather than a list — w-max stops the browser
            compressing columns to fit and lets the grid scroll instead. */}
        <table className="w-max">
          <thead>
            <tr>
              <th className="s-th sticky left-0 z-10 whitespace-nowrap">Series Name</th>
              {SERIES_COLUMNS.map(([entity, label]) => (
                <th key={entity} className="s-th whitespace-nowrap">
                  {label}
                </th>
              ))}
              <th className="s-th" />
            </tr>
          </thead>
          <tbody>
            {series?.map((s) => {
              const byEntity = new Map(s.entities.map((e) => [e.entity, e]));
              return (
                <tr key={s.id} className="s-row">
                  <td className="s-td sticky left-0 z-10 whitespace-nowrap bg-white">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{s.name}</span>
                      {s.isDefault && <Chip>Default</Chip>}
                    </div>
                  </td>
                  {SERIES_COLUMNS.map(([entity]) => {
                    const e = byEntity.get(entity);
                    if (!e) {
                      return (
                        <td key={entity} className="s-td text-gray-300">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={entity} className="s-td align-top">
                        <input
                          defaultValue={e.prefix}
                          onBlur={(ev) => {
                            const next = ev.target.value.trim();
                            if (next && next !== e.prefix) {
                              void run(() =>
                                api(`/api/settings/series/${e.id}`, {
                                  method: "PATCH",
                                  body: { prefix: next },
                                }),
                              );
                            }
                          }}
                          className="input w-32 py-1"
                        />
                        <div className="px-1 pt-1 text-[11px] tabular-nums text-gray-400">
                          next {e.prefix}
                          {String(e.nextNumber).padStart(e.padding, "0")}
                        </div>
                      </td>
                    );
                  })}
                  <td className="s-td whitespace-nowrap align-top">
                    {!s.isDefault && (
                      <RowActions>
                        <RowAction
                          onClick={() =>
                            void run(() =>
                              api(`/api/settings/series-group/${s.id}`, {
                                method: "PATCH",
                                body: { isDefault: true },
                              }),
                            )
                          }
                        >
                          Make default
                        </RowAction>
                        <RowAction
                          tone="danger"
                          onClick={() =>
                            void run(() =>
                              api(`/api/settings/series-group/${s.id}`, { method: "DELETE" }),
                            )
                          }
                        >
                          Delete
                        </RowAction>
                      </RowActions>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {adding && (
        <NewSeriesModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ["series"] });
          }}
        />
      )}
    </div>
  );
}

function NewSeriesModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [prefixTag, setPrefixTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/settings/series", {
        method: "POST",
        body: { name: name.trim(), prefixTag: prefixTag.trim() || undefined },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create series");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New Number Series"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
            className="btn-primary"
          >
            Create Series
          </button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <label className="label-required">Series Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Eggs"
            className="input"
            autoFocus
          />
        </div>
        <div>
          <label className="label">Prefix Tag</label>
          <input
            value={prefixTag}
            onChange={(e) => setPrefixTag(e.target.value)}
            placeholder="EG-"
            className="input"
          />
        </div>
      </div>
    </Modal>
  );
}

interface FinancialYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  lockedThrough: string | null;
}

function FinancialYearsSection() {
  const qc = useQueryClient();
  const { data: years, isLoading } = useQuery({
    queryKey: ["fys"],
    queryFn: () => api<FinancialYear[]>("/api/settings/financial-years"),
  });
  const [adding, setAdding] = useState(false);
  const [locking, setLocking] = useState<FinancialYear | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["fys"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div>
      <SettingsHeader
        title="Financial Years & Locking"
        actions={
          <button onClick={() => setAdding(true)} className="btn-primary">
            + New Financial Year
          </button>
        }
      />
      {error && <Banner tone="error">{error}</Banner>}

      <SettingsTable
        columns={[
          { label: "Name", width: "w-48" },
          { label: "Period" },
          { label: "Locked through", width: "w-56" },
          { label: "", align: "right", width: "w-44" },
        ]}
      >
        {isLoading && <EmptyRow colSpan={4}>Loading…</EmptyRow>}
        {years?.length === 0 && <EmptyRow colSpan={4}>No financial years yet.</EmptyRow>}
        {years?.map((y) => (
          <tr key={y.id} className="s-row">
            <td className="s-td">
              <NameCell name={y.name} />
            </td>
            <td className="s-td text-gray-600">
              {formatDate(y.startDate)} – {formatDate(y.endDate)}
            </td>
            <td className="s-td">
              {y.lockedThrough ? (
                <Badge tone="amber">Locked to {formatDate(y.lockedThrough)}</Badge>
              ) : (
                <span className="text-gray-500">Open</span>
              )}
            </td>
            <td className="s-td">
              <RowActions>
                <RowAction onClick={() => setLocking(y)}>
                  {y.lockedThrough ? "Change lock" : "Lock period"}
                </RowAction>
                {y.lockedThrough && (
                  <RowAction
                    tone="danger"
                    onClick={() =>
                      void run(() =>
                        api(`/api/settings/financial-years/${y.id}`, {
                          method: "PATCH",
                          body: { lockedThrough: null },
                        }),
                      )
                    }
                  >
                    Unlock
                  </RowAction>
                )}
              </RowActions>
            </td>
          </tr>
        ))}
      </SettingsTable>

      {adding && (
        <NewFinancialYearModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ["fys"] });
          }}
        />
      )}
      {locking && (
        <LockPeriodModal
          year={locking}
          onClose={() => setLocking(null)}
          onDone={() => {
            setLocking(null);
            void qc.invalidateQueries({ queryKey: ["fys"] });
          }}
        />
      )}
    </div>
  );
}

function NewFinancialYearModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: "", startDate: "", endDate: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/settings/financial-years", { method: "POST", body: form });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New Financial Year"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !form.name || !form.startDate || !form.endDate}
            className="btn-primary"
          >
            Add Year
          </button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="label-required">Name *</label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="FY 2026-27"
            className="input"
          />
        </div>
        <div>
          <label className="label-required">Start *</label>
          <DateInput
            value={form.startDate}
            onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
            className="input"
          />
        </div>
        <div>
          <label className="label-required">End *</label>
          <DateInput
            value={form.endDate}
            onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
            className="input"
          />
        </div>
      </div>
    </Modal>
  );
}

function LockPeriodModal({
  year,
  onClose,
  onDone,
}: {
  year: FinancialYear;
  onClose: () => void;
  onDone: () => void;
}) {
  const [date, setDate] = useState(year.lockedThrough ?? year.endDate);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/settings/financial-years/${year.id}`, {
        method: "PATCH",
        body: { lockedThrough: date },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not lock");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Lock ${year.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={busy || !date} className="btn-primary">
            Lock Period
          </button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      <label className="label-required">Lock transactions through *</label>
      <DateInput
        value={date}
        min={year.startDate}
        max={year.endDate}
        onChange={(e) => setDate(e.target.value)}
        className="input w-56"
      />
      <p className="mt-2 text-[12px] text-gray-500">
        Nothing dated on or before this day can be posted, edited or voided afterwards. It can be
        unlocked again from this screen.
      </p>
    </Modal>
  );
}

/**
 * One module's settings, with Zoho's tab bar across the top. A module without
 * preferences shows only Fields; one without custom fields shows only
 * Preferences; most show both.
 */
/** The screens a module owns beyond preferences and custom fields. */
const MODULE_EXTRAS: Record<string, () => ReactElement> = {
  deductions: DeductionRulesSection,
  sites: OfficeSitesSection,
  "feed-standards": FeedStandardsSection,
  houses: FarmHousesSection,
  standards: FarmStandardsSection,
  departments: DepartmentsTab,
  shifts: ShiftsTab,
  holidays: HolidaysTab,
  "wage-rates": RatesTab,
  "payroll-policy": PolicyTab,
  differentials: EggDifferentialsSection,
  whatsapp: WhatsappMessageSection,
};

function ModuleSettings({ def, initialTab }: { def: SectionDef; initialTab?: string }) {
  // The module's own screen leads, because it is what somebody came here for;
  // preferences and custom fields are the standard tail every module carries.
  const tabs: string[] = [
    ...(def.extras ?? []).map((e) => e.key),
    ...(def.prefs ? ["preferences"] : []),
    ...(def.entity ? ["fields"] : []),
  ];
  const [tab, setTab] = useState<string>(initialTab && tabs.includes(initialTab) ? initialTab : (tabs[0] ?? "fields"));
  // Looked up within this module's own extras, not the global map — a screen
  // this module doesn't declare must never render just because some other
  // module happens to use the same tab key.
  const Extra = (def.extras ?? []).some((e) => e.key === tab) ? (MODULE_EXTRAS[tab] ?? null) : null;

  const PREFS = {
    transactions: TransactionPrefsSection,
    contacts: ContactPrefsSection,
    items: ItemPrefsSection,
    invoices: InvoicePrefsSection,
    accountant: AccountantPrefsSection,
    office: OfficePrefsSection,
  } as const;
  const Prefs = def.prefs ? PREFS[def.prefs] : null;

  return (
    <div>
      <div className="page-header -mx-4 flex items-center justify-between px-4 py-3 sm:-mx-8 sm:px-8">
        <h2 className="text-[18px] font-semibold text-[#212529]">{def.label}</h2>
      </div>
      {tabs.length > 1 && (
        <div className="mb-5 mt-3 flex gap-6 border-b">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 pb-2 text-[13px] capitalize ${
                tab === t
                  ? "border-brand-500 font-medium text-brand-700"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {def.extras?.find((e) => e.key === t)?.label ?? t}
            </button>
          ))}
        </div>
      )}
      {tabs.length === 1 && <div className="mb-5" />}

      {Extra && <Extra />}
      {tab === "preferences" && Prefs && <Prefs />}
      {tab === "fields" && def.entity && <CustomFieldsTab entity={def.entity} />}
    </div>
  );
}
