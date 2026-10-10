/**
 * Where this browser is, for the pages that record a person being somewhere —
 * the attendance gate and the canteen counter.
 *
 * A punch or a plate without a location is refused (the user, 10 Oct 2026), so
 * both pages hold a position from the moment they open and keep it fresh,
 * rather than asking at the instant of the scan: a GPS cold start takes longer
 * than a queue at the gate will wait.
 */
import { useCallback, useEffect, useState } from "react";

export interface Position { latitude: number; longitude: number; accuracy: number }

/** Said wherever a scan is stopped for want of a location; the server says the same. */
export const LOCATION_REQUIRED =
  "Location is off — nothing can be recorded without it. Turn on location for this device, allow it for this site (the lock icon in the address bar), then press Retry.";

function getPositionOnce(options: PositionOptions): Promise<Position | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      options,
    );
  });
}

// GPS cold-start routinely outlives a short timeout; give the precise fix
// real time to lock, then fall back to a fast network-based one.
export async function getPosition(): Promise<Position | null> {
  const precise = await getPositionOnce({ enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  if (precise) return precise;
  return getPositionOnce({ enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 });
}

/**
 * A position held for as long as the page is open. `retry` asks again — for
 * the button beside "No location", after the guard has switched it on.
 */
export function usePosition() {
  const [position, setPosition] = useState<Position | null>(null);
  const [asking, setAsking] = useState(true);

  const retry = useCallback(async () => {
    setAsking(true);
    const p = await getPosition();
    if (p) setPosition(p);
    setAsking(false);
    return p;
  }, []);

  useEffect(() => {
    let cancelled = false;
    getPosition().then((p) => {
      if (cancelled) return;
      if (p) setPosition(p);
      setAsking(false);
    });
    let watchId: number | null = null;
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (p) => !cancelled && setPosition({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
        () => {},
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
      );
    }
    return () => {
      cancelled = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  return { position, asking, retry };
}
