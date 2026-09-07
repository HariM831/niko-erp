/**
 * The platform's own reading, above the field it fills.
 *
 * Typing a weight off a display is where the errors are: a transposed digit
 * survives every check downstream, because 13320 is as plausible as 13230 and
 * nothing else in the receipt disagrees with it. This puts the number the
 * indicator is actually sending on screen and lets the operator take it.
 *
 * It never fills the field on its own. A truck rocks for a few seconds after
 * it stops and the number wanders while it does, so the operator decides when
 * the lorry has settled — the button is simply refused until the reading has
 * held still, which is the part a person is bad at judging and a computer is
 * good at.
 *
 * Typing stays available throughout. A dead port, a cable pulled out of the
 * back of a desktop, a driver who has already left — none of those can be
 * allowed to stop a weighbridge working.
 */
import { useEffect, useSyncExternalStore } from "react";
import { Plug, Scale } from "lucide-react";
import {
  canConnect,
  choosePort,
  connectRemembered,
  getSnapshot,
  subscribe,
} from "../lib/weighbridge";

/** One button the operator can press to take the current reading. */
export interface Take {
  label: string;
  onUse: (kg: string) => void;
}

/**
 * `takes` is a list because not every weighment is one reading. A lorry at a
 * station is weighed once per visit, but a feed tanker is weighed empty and
 * again loaded, and the feed is the difference — so that screen needs two
 * buttons against the same live reading.
 */
export function PlatformWeight({
  onUse,
  takes,
  compact,
}: {
  onUse?: (kg: string) => void;
  takes?: Take[];
  /**
   * A one-line readout for a page header, with nothing to press.
   *
   * The stations only render their capture panel once a truck is picked, so
   * until then the screen said nothing about the platform at all — and an
   * operator wants to see what is on it the way they can see the indicator on
   * the wall, whether or not a receipt is open yet.
   */
  compact?: boolean;
}) {
  const buttons: Take[] = takes ?? (onUse ? [{ label: "Use this weight", onUse }] : []);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const supported = canConnect();

  // The grant is remembered per origin, so after the cabin has picked its port
  // once the reading is simply there. Deliberately not disconnected on unmount:
  // a truck walks Weigh In to Weigh Out and reopening the port between the two
  // would drop the stream every time the operator changed tab.
  useEffect(() => {
    if (supported) void connectRemembered();
  }, [supported]);

  if (!supported) return null;

  const { status, reading, stable, unreadable } = state;
  const live = status === "open" || status === "connecting";

  if (compact) {
    if (!live) {
      return (
        <button
          className="text-[12px] text-gray-400 hover:text-brand-600 hover:underline"
          onClick={() => void choosePort()}
        >
          Connect platform
        </button>
      );
    }
    return (
      <span className="flex items-baseline gap-1.5" title="Live from the weighbridge">
        <span className="text-[15px] font-semibold tabular-nums text-gray-900">
          {reading ? reading.kg.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : "—"}
        </span>
        <span className="text-[11px] text-gray-400">kg</span>
        {reading && (
          <span
            className={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${
              stable ? "bg-green-500" : "bg-amber-500"
            }`}
            title={stable ? "Stable" : "Settling"}
          />
        )}
      </span>
    );
  }

  if (!live) {
    return (
      <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-dashed border-gray-300 bg-gray-50/60 px-3 py-2">
        <div className="min-w-0 text-[12px] text-gray-500">
          {state.error ?? "The platform is not connected — type the weight, or connect it."}
        </div>
        <button className="btn-secondary shrink-0" onClick={() => void choosePort()}>
          <Plug className="h-3.5 w-3.5" />
          Connect
        </button>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-gray-400">
            <Scale className="h-3 w-3" />
            From the platform
          </div>
          {reading ? (
            <div className="text-[26px] font-semibold leading-tight tabular-nums text-gray-900">
              {reading.kg.toLocaleString("en-IN", { maximumFractionDigits: 1 })}
              <span className="ml-1 text-[13px] font-normal text-gray-400">kg</span>
            </div>
          ) : (
            <div className="text-[16px] text-gray-400">
              {status === "connecting" ? "Connecting…" : "Waiting for a reading…"}
            </div>
          )}
          <div className="flex items-center gap-2 text-[11px]">
            {reading &&
              (stable ? (
                <span className="font-medium text-green-600">Stable</span>
              ) : (
                <span className="font-medium text-amber-600">Settling…</span>
              ))}
            {reading && reading.mode.toLowerCase() !== "g" && (
              <span className="text-amber-600">mode {reading.mode} — not gross</span>
            )}
            {unreadable > 0 && (
              <span className="text-amber-600">{unreadable} frames not recognised</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          {buttons.map((b) => (
            <button
              key={b.label}
              className="btn-primary"
              disabled={!stable}
              onClick={() => stable && b.onUse(String(stable.kg))}
              title={stable ? "" : "Waiting for the reading to hold still"}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
