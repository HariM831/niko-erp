import { useEffect, useState } from "react";
import { LogoMark } from "../components/logo";
import { LoginForm } from "./login";

/**
 * aminofarms.com for someone not signed in: the niko eggs film, full screen,
 * with Login at the top right (the user, 30 Sep 2026). Login opens the same
 * sign-in card over the film rather than leaving it.
 *
 * Muted, looping and inline, because a browser plays nothing else on its own —
 * and the film is five seconds of one shot, so a loop reads as a still that
 * breathes. The meadow green behind it is what shows before the first frame.
 */
export function LandingPage() {
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (!signingIn) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setSigningIn(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [signingIn]);

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-[#6f8f5a]">
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src="/niko-landing.mp4"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
      />
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
