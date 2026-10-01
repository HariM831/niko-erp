import { useEffect, useState } from "react";
import { LogoMark } from "../components/logo";
import { LoginForm } from "./login";

/**
 * aminofarms.com for someone not signed in: the niko eggs box on the meadow,
 * full screen, with Login at the top right (the user, 30 Sep 2026). Login opens
 * the same sign-in card over it rather than leaving it.
 *
 * A sharp still with a slow CSS push-in replaced the WhatsApp film, whose
 * compression blurred the lettering; clouds and grass move as in the film.
 * The meadow green behind it is what shows before the image loads.
 */
// Every layer is square and framed the same way, so they stay pixel-aligned.
const LAYER = "absolute inset-0 h-full w-full object-cover object-[50%_58%]";

/** A screen taller than wide — a phone held upright. */
function useTall() {
  const q = "(max-aspect-ratio: 1/1)";
  const [tall, setTall] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setTall(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return tall;
}

export function LandingPage() {
  const [signingIn, setSigningIn] = useState(false);
  const tall = useTall() ? "-tall" : "";

  useEffect(() => {
    if (!signingIn) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setSigningIn(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [signingIn]);

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-[#6f8f5a]">
      {/* Three layers under one push-in: the still (shows at once), the loop of
          drifting clouds and wind in the grass rendered from it, and the box cut
          from the still on top, so video compression never softens the lettering.
          A phone gets the tall set, with more sky above and grass below. */}
      <div className="landing-drift absolute inset-0" aria-hidden="true">
        <img className={LAYER} src={`/niko-landing${tall}.webp`} alt="" />
        <video key={tall} className={LAYER} src={`/niko-landing-loop${tall}.mp4`} autoPlay muted loop playsInline preload="auto" />
        <img className={LAYER} src={`/niko-landing-box${tall}.webp`} alt="" />
      </div>
      {/* Enough shade under the header for the button and logo to read against a bright sky. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/35 to-transparent" />

      <header className="absolute inset-x-0 top-0 flex items-center justify-between px-5 py-4 sm:px-10 sm:py-6">
        <LogoMark className="h-9 sm:h-11" color="bg-white" />
        <button
          onClick={() => setSigningIn(true)}
          className="rounded-full bg-white px-6 py-2 text-[14px] font-semibold text-[#c8102e] shadow-lg transition hover:bg-[#fff4f4]"
        >
          Login
        </button>
      </header>

      {signingIn && (
        <div
          className="absolute inset-0 grid place-items-center bg-black/40 backdrop-blur-[2px]"
          onClick={(e) => e.target === e.currentTarget && setSigningIn(false)}
        >
          <LoginForm onClose={() => setSigningIn(false)} />
        </div>
      )}
    </div>
  );
}
