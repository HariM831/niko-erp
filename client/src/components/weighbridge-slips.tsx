/**
 * The weighbridge, on its own terms.
 *
 * The four stations beside this one walk a purchase through gate, weighment,
 * QC and settlement. This screen does none of that. A vehicle arrives, it is
 * weighed, it is weighed again, and the driver leaves with a slip — which is
 * how gunny bags, scrap and feed leave the yard, and there was previously
 * nowhere in niko to record any of it.
 *
 * Three states, one at a time, because a weighbridge cabin has one operator
 * and one screen: take a first weighment, pick a vehicle already on the book
 * and close it, or look at a finished slip and print it.
 *
 * Whichever weighment happens first is the one taken first — the mill's own
 * book records a tare before a gross as often as after.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Printer, Scale, Truck } from "lucide-react";
import { ApiError, api } from "../api";
import { PlatformWeight } from "./platform-weight";
import { SearchSelect } from "./search-select";
import { WeighbridgeCamera, type Shot } from "./weighbridge-camera";

type Kind = "gross" | "tare";

interface Ticket {
  id: string;
  number: string;
  vehicleNumber: string;
  partyId: string | null;
  partyName: string | null;
  itemId: string | null;
  itemName: string | null;
  grossWeightKg: string | null;
  grossAt: string | null;
  tareWeightKg: string | null;
  tareAt: string | null;
  netWeightKg: string | null;
  notes: string | null;
  printCount: number;
  createdAt: string;
}

interface Slip extends Ticket {
  operatorName: string | null;
  org: {
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    phone: string | null;
    gstin: string | null;
  } | null;
}

interface Context {
  locations: Array<{ id: string; name: string }>;
  parties: Array<{ id: string; name: string; company: string | null }>;
  items: Array<{ id: string; name: string; unit: string }>;
}

const kg = (v: string | number | null | undefined) =>
  v == null || v === "" ? "—" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;

const when = (v: string | null) =>
  v == null
    ? "—"
    : new Date(v).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

/** The one still missing from a ticket. */
const missingKind = (t: Ticket): Kind => (t.grossWeightKg == null ? "gross" : "tare");
const isClosed = (t: Ticket) => t.grossWeightKg != null && t.tareWeightKg != null;

function Err({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
      {msg}
    </div>
  );
}

/** Gross or tare, said plainly, because picking wrong ruins the slip. */
function KindChoice({ value, onChange }: { value: Kind; onChange: (k: Kind) => void }) {
  return (
    <div className="flex gap-2">
      {(
        [
          { k: "gross" as const, label: "Gross", sub: "loaded" },
          { k: "tare" as const, label: "Tare", sub: "empty" },
        ]
      ).map((o) => (
        <button
          key={o.k}
          type="button"
          onClick={() => onChange(o.k)}
          className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
            value === o.k
              ? "border-brand-500 bg-brand-50 text-brand-800"
              : "border-gray-200 text-gray-600 hover:border-gray-300"
          }`}
        >
          <div className="text-[14px] font-semibold">{o.label}</div>
          <div className="text-[11px] opacity-70">vehicle {o.sub}</div>
        </button>
      ))}
    </div>
  );
}

export function WeighbridgeSlips() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: ctx } = useQuery<Context>({
    queryKey: ["weigh-context"],
    queryFn: () => api("/api/weigh-tickets/context"),
  });
  const { data: open } = useQuery<Ticket[]>({
    queryKey: ["weigh-tickets", "open"],
    queryFn: () => api("/api/weigh-tickets?status=open"),
    refetchInterval: 30_000,
  });
  const { data: slip } = useQuery<Slip>({
    queryKey: ["weigh-ticket", selected],
    queryFn: () => api(`/api/weigh-tickets/${selected}`),
    enabled: !!selected,
  });

  const parties = useMemo(
    () => (ctx?.parties ?? []).map((p) => ({ id: p.id, label: p.name, sub: p.company })),
    [ctx],
  );
  const materials = useMemo(
    () => (ctx?.items ?? []).map((i) => ({ id: i.id, label: i.name, sub: i.unit })),
    [ctx],
  );

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["weigh-tickets"] });
    void qc.invalidateQueries({ queryKey: ["weigh-ticket"] });
  };

  if (selected && slip) {
    return isClosed(slip) ? (
      <SlipSheet slip={slip} onBack={() => setSelected(null)} onPrinted={refresh} />
    ) : (
      <SecondWeighment
        ticket={slip}
        parties={parties}
        materials={materials}
        onBack={() => setSelected(null)}
        onDone={() => {
          refresh();
        }}
      />
    );
  }

  return (
    <div>
      <Err msg={error} />
      <FirstWeighment
        parties={parties}
        materials={materials}
        onError={setError}
        onDone={() => {
          setError(null);
          refresh();
        }}
      />

      <div className="mt-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-[14px] font-semibold text-gray-900">On the weighbridge</h3>
          <span className="text-[12px] text-gray-400">
            {open?.length ?? 0} waiting for a second weighment
          </span>
        </div>
        <div className="card overflow-hidden">
          {!open?.length && (
            <div className="p-6 text-center text-[13px] text-gray-400">
              No vehicle is part-weighed. Take a first weighment above.
            </div>
          )}
          {open?.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className="block w-full border-b border-gray-100 px-3 py-2 text-left last:border-0 hover:bg-gray-50"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[14px] font-semibold text-gray-900">{t.vehicleNumber}</span>
                <span className="font-mono text-[11px] text-gray-400">{t.number}</span>
              </div>
              <div className="text-[12px] text-gray-500">
                {t.partyName ?? "Party not set"}
                {t.itemName ? ` · ${t.itemName}` : ""}
              </div>
              <div className="text-[11px] text-gray-400">
                {t.grossWeightKg != null
                  ? `Gross ${kg(t.grossWeightKg)} at ${when(t.grossAt)} — needs tare`
                  : `Tare ${kg(t.tareWeightKg)} at ${when(t.tareAt)} — needs gross`}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Opens a ticket. Vehicle and one weight are all that is truly required. */
function FirstWeighment({
  parties,
  materials,
  onDone,
  onError,
}: {
  parties: Array<{ id: string; label: string; sub?: string | null }>;
  materials: Array<{ id: string; label: string; sub?: string | null }>;
  onDone: () => void;
  onError: (m: string | null) => void;
}) {
  const [vehicle, setVehicle] = useState("");
  const [partyId, setPartyId] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("gross");
  const [weight, setWeight] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);

  const reset = () => {
    setVehicle("");
    setPartyId(null);
    setItemId(null);
    setWeight("");
    setShots([]);
  };

  const save = useMutation({
    mutationFn: async () => {
      const created = await api<{ id: string; number: string }>("/api/weigh-tickets", {
        method: "POST",
        body: {
          vehicleNumber: vehicle.trim(),
          partyId: partyId ?? undefined,
          itemId: itemId ?? undefined,
          kind,
          weightKg: weight,
        },
      });
      // Photos ride the ordinary attachments path, the same one every other
      // record uses — there is no second way to attach a file in niko.
      for (const shot of shots) {
        const form = new FormData();
        form.append("file", shot.file);
        form.append("entityType", "weigh_ticket");
        form.append("entityId", created.id);
        await fetch("/api/attachments", {
          method: "POST",
          body: form,
          credentials: "same-origin",
        }).catch(() => {
          // A slip with no photograph is still a slip. Losing the weighment
          // because the camera file failed to upload would be the worse trade.
        });
      }
      return created;
    },
    onSuccess: () => {
      reset();
      onDone();
    },
    onError: (e) =>
      onError(e instanceof ApiError ? e.message : "Could not record the weighment"),
  });

  const ready = vehicle.trim().length >= 4 && Number(weight) > 0;

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Truck className="h-4 w-4 text-gray-400" />
        <h3 className="text-[14px] font-semibold text-gray-900">New weighment</h3>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label-required">Vehicle number *</label>
          <input
            value={vehicle}
            onChange={(e) => setVehicle(e.target.value.toUpperCase())}
            placeholder="AS12AC8276"
            className="input font-mono uppercase"
            autoFocus
          />
        </div>
        <div>
          <label className="label">Party</label>
          <SearchSelect
            value={partyId}
            onChange={setPartyId}
            options={parties}
            placeholder="Customer or vendor…"
          />
        </div>
        <div>
          <label className="label">Material</label>
          <SearchSelect
            value={itemId}
            onChange={setItemId}
            options={materials}
            placeholder="Gunny bags, scrap, feed…"
          />
        </div>
        <div>
          <label className="label">This weighment is</label>
          <KindChoice value={kind} onChange={setKind} />
        </div>
      </div>

      <div className="mt-3">
        <PlatformWeight onUse={setWeight} />
        <label className="label">Weight (kg) *</label>
        <input
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          inputMode="decimal"
          className="input text-right text-[18px]"
        />
      </div>

      <div className="mt-3">
        <div className="label">Photograph</div>
        <WeighbridgeCamera
          note={vehicle || null}
          onCapture={(s) => setShots((prev) => [s, ...prev].slice(0, 4))}
        />
      </div>

      <button
        className="btn-primary mt-4 w-full"
        disabled={!ready || save.isPending}
        onClick={() => {
          onError(null);
          save.mutate();
        }}
      >
        {save.isPending ? "Saving…" : `Record ${kind} weight → onto the book`}
      </button>
    </div>
  );
}

/** Closes a ticket: the weighment it does not yet have. */
function SecondWeighment({
  ticket,
  parties,
  materials,
  onBack,
  onDone,
}: {
  ticket: Ticket;
  parties: Array<{ id: string; label: string; sub?: string | null }>;
  materials: Array<{ id: string; label: string; sub?: string | null }>;
  onBack: () => void;
  onDone: () => void;
}) {
  const kind = missingKind(ticket);
  const [weight, setWeight] = useState("");
  const [partyId, setPartyId] = useState<string | null>(ticket.partyId);
  const [itemId, setItemId] = useState<string | null>(ticket.itemId);
  const [error, setError] = useState<string | null>(null);

  const taken = kind === "gross" ? ticket.tareWeightKg : ticket.grossWeightKg;
  const net =
    Number(weight) > 0 && taken != null
      ? kind === "gross"
        ? Number(weight) - Number(taken)
        : Number(taken) - Number(weight)
      : null;

  const save = useMutation({
    mutationFn: () =>
      api(`/api/weigh-tickets/${ticket.id}`, {
        method: "PATCH",
        body: {
          kind,
          weightKg: weight,
          partyId: partyId ?? undefined,
          itemId: itemId ?? undefined,
        },
      }),
    onSuccess: onDone,
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : "Could not record the second weighment"),
  });

  return (
    <div className="card p-4">
      <button onClick={onBack} className="mb-3 flex items-center gap-1 text-[12px] text-gray-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to the book
      </button>
      <Err msg={error} />

      <div className="mb-3 flex items-baseline justify-between border-b border-gray-100 pb-2">
        <div>
          <div className="text-[16px] font-semibold text-gray-900">{ticket.vehicleNumber}</div>
          <div className="font-mono text-[11px] text-gray-400">{ticket.number}</div>
        </div>
        <div className="text-right text-[12px] text-gray-500">
          {kind === "gross" ? "Tare" : "Gross"} taken
          <div className="text-[15px] font-semibold tabular-nums text-gray-900">{kg(taken)}</div>
        </div>
      </div>

      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Party</label>
          <SearchSelect value={partyId} onChange={setPartyId} options={parties} placeholder="Customer or vendor…" />
        </div>
        <div>
          <label className="label">Material</label>
          <SearchSelect value={itemId} onChange={setItemId} options={materials} placeholder="Gunny bags, scrap, feed…" />
        </div>
      </div>

      <PlatformWeight onUse={setWeight} />
      <label className="label">{kind === "gross" ? "Gross" : "Tare"} weight (kg) *</label>
      <input
        value={weight}
        onChange={(e) => setWeight(e.target.value)}
        inputMode="decimal"
        className="input text-right text-[18px]"
        autoFocus
      />

      {net != null && (
        <div className={`mt-3 rounded-lg p-3 text-[13px] ${net > 0 ? "bg-gray-50" : "bg-red-50"}`}>
          <div className="flex justify-between font-semibold">
            <span className={net > 0 ? "text-gray-900" : "text-red-700"}>Net</span>
            <span className={`tabular-nums ${net > 0 ? "text-gray-900" : "text-red-700"}`}>
              {kg(net)}
            </span>
          </div>
          {net <= 0 && (
            <p className="mt-1 text-[12px] text-red-700">
              The loaded weight must be heavier than the empty one — check which reading went where.
            </p>
          )}
        </div>
      )}

      <button
        className="btn-primary mt-4 w-full"
        disabled={!(Number(weight) > 0) || (net != null && net <= 0) || save.isPending}
        onClick={() => {
          setError(null);
          save.mutate();
        }}
      >
        Record {kind} weight → finish the slip
      </button>
    </div>
  );
}

/**
 * The slip itself.
 *
 * Printed from the browser rather than rendered server-side: the print dialog
 * already offers Save as PDF, which is the whole of the PDF requirement, and a
 * second PDF pipeline for one document is a lot of machinery to maintain for a
 * page that is a table and a heading.
 */
function SlipSheet({
  slip,
  onBack,
  onPrinted,
}: {
  slip: Slip;
  onBack: () => void;
  onPrinted: () => void;
}) {
  const stamp = slip.printCount === 0 ? "ORIGINAL" : "DUPLICATE";
  const org = slip.org;

  /**
   * Print first, count second.
   *
   * Counting first flips the stamp to DUPLICATE before the sheet renders, so
   * the very first copy comes out of the printer marked as a reprint — which
   * defeats the only thing the stamp is for. `window.print()` blocks until the
   * dialog closes, so incrementing after it leaves the printed sheet showing
   * the stamp it was rendered with.
   *
   * A cancelled dialog is still counted. That way round is the safe one: an
   * over-count stamps a later copy DUPLICATE when it might have been the
   * first, whereas an under-count puts two sheets marked ORIGINAL in the
   * world, and telling those apart is the whole point.
   */
  const print = async () => {
    window.print();
    await api(`/api/weigh-tickets/${slip.id}/printed`, { method: "POST" }).catch(() => {
      // Counting is bookkeeping; failing it must never have stopped the print.
    });
    onPrinted();
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between print:hidden">
        <button onClick={onBack} className="flex items-center gap-1 text-[12px] text-gray-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to the book
        </button>
        <button className="btn-primary" onClick={() => void print()}>
          <Printer className="h-3.5 w-3.5" />
          Print / Save as PDF
        </button>
      </div>

      {/* Half of A4, which is the size the mill's slips have always been. */}
      <div className="mx-auto max-w-[148mm] border border-gray-200 bg-white p-6 print:max-w-none print:border-0 print:p-0">
        <div className="flex items-start justify-between border-b border-gray-300 pb-3">
          <div>
            <div className="text-[15px] font-bold uppercase text-gray-900">
              {org?.name || "Weighbridge"}
            </div>
            <div className="text-[10px] leading-tight text-gray-600">
              {[org?.address, org?.city, org?.state, org?.pincode].filter(Boolean).join(", ")}
              {org?.phone && <div>Ph: {org.phone}</div>}
              {org?.gstin && <div>GSTIN: {org.gstin}</div>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Weighment Slip
            </div>
            <div className="font-mono text-[14px] font-bold text-gray-900">{slip.number}</div>
            <div className="mt-0.5 inline-block border border-gray-400 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-gray-700">
              {stamp}
            </div>
          </div>
        </div>

        <table className="mt-3 w-full text-[11px]">
          <tbody>
            <Row label="Vehicle" value={slip.vehicleNumber} mono />
            <Row label="Party" value={slip.partyName ?? "—"} />
            <Row label="Material" value={slip.itemName ?? "—"} />
          </tbody>
        </table>

        <table className="mt-3 w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-y border-gray-300 bg-gray-50">
              <th className="py-1 text-left font-semibold text-gray-700">Weighment</th>
              <th className="py-1 text-right font-semibold text-gray-700">Weight</th>
              <th className="py-1 text-right font-semibold text-gray-700">Date &amp; time</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-200">
              <td className="py-1.5">Gross</td>
              <td className="py-1.5 text-right tabular-nums">{kg(slip.grossWeightKg)}</td>
              <td className="py-1.5 text-right text-gray-600">{when(slip.grossAt)}</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-1.5">Tare</td>
              <td className="py-1.5 text-right tabular-nums">{kg(slip.tareWeightKg)}</td>
              <td className="py-1.5 text-right text-gray-600">{when(slip.tareAt)}</td>
            </tr>
            <tr className="border-b-2 border-gray-400">
              <td className="py-1.5 font-bold">Net</td>
              <td className="py-1.5 text-right text-[13px] font-bold tabular-nums">
                {kg(slip.netWeightKg)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>

        {slip.notes && <p className="mt-3 text-[10px] text-gray-600">{slip.notes}</p>}

        <div className="mt-10 flex justify-between text-[10px] text-gray-600">
          <div>
            <div className="w-32 border-t border-gray-400 pt-1">Operator</div>
            <div className="text-gray-500">{slip.operatorName ?? ""}</div>
          </div>
          <div>
            <div className="w-32 border-t border-gray-400 pt-1 text-right">Driver</div>
          </div>
        </div>

        <p className="mt-4 flex items-center gap-1 text-[9px] text-gray-400">
          <Scale className="h-2.5 w-2.5" />
          Weights recorded from the platform indicator.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <tr>
      <td className="w-24 py-0.5 align-top text-gray-500">{label}</td>
      <td className={`py-0.5 font-semibold text-gray-900 ${mono ? "font-mono" : ""}`}>{value}</td>
    </tr>
  );
}
