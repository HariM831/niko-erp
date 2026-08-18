/**
 * Make a rejected async route handler reach the error handler.
 *
 * Express 4 calls a route handler and ignores its return value. An `async`
 * handler returns a promise, so when one rejects — a bug, a constraint
 * violation, anything not caught in the route — Express never learns. The
 * response is never written and the request hangs until the browser gives up.
 *
 * That failure mode is worse than the bug behind it. A 500 is a bug report; a
 * request that hangs for two minutes is "the screen is stuck", and the actual
 * error is only visible to somebody reading the server's console. A settlement
 * that could not raise its bill presented as a spinner for exactly this reason.
 *
 * Express 5 does this natively. Until then the fix has to reach into Layer,
 * which is what every library solving this does. It DELEGATES to the original
 * implementation rather than reimplementing it — all this adds is a `.catch`
 * around the handler, so routing, params and error-handler arity keep whatever
 * behaviour the installed Express has.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — express 4 ships no types for its internal Layer
import Layer from "express/lib/router/layer.js";

type Handler = ((...args: unknown[]) => unknown) & { __asyncForwarded?: true };

export function forwardAsyncErrors(): void {
  const proto = (Layer as { prototype: Record<string, unknown> }).prototype;
  const original = proto.handle_request;
  if (typeof original !== "function") {
    // Fail at boot rather than silently going back to hanging requests — an
    // Express upgrade that renames this is a thing to notice immediately.
    throw new Error(
      "Cannot forward async errors: express Layer.handle_request is missing. " +
        "If this is Express 5, it forwards them itself — delete this module.",
    );
  }

  proto.handle_request = function (this: { handle: Handler }, ...args: unknown[]) {
    const handle = this.handle;
    // Arity 4 is an error handler; Express distinguishes them by length, so
    // wrapping one would take it out of the error chain entirely.
    if (typeof handle === "function" && handle.length <= 3 && !handle.__asyncForwarded) {
      const next = args[2] as (err?: unknown) => void;
      const wrapped: Handler = function (this: unknown, ...inner: unknown[]) {
        try {
          const out = (handle as (...a: unknown[]) => unknown).apply(this, inner);
          // The third argument is this call's own `next`, not the one captured
          // above — a handler may be invoked again for a later request.
          const onward = inner[2] as ((err?: unknown) => void) | undefined;
          if (out && typeof (out as Promise<unknown>).then === "function") {
            void (out as Promise<unknown>).catch(onward ?? next);
          }
          return out;
        } catch (err) {
          const onward = inner[2] as ((err?: unknown) => void) | undefined;
          (onward ?? next)(err);
        }
      };
      wrapped.__asyncForwarded = true;
      // Preserve arity: Express reads handle.length elsewhere.
      Object.defineProperty(wrapped, "length", { value: handle.length });
      this.handle = wrapped;
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
}
