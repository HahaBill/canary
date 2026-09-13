/**
 * Five-second door: the lockup, why it's called Canary, Start / Enter.
 * Deep links never mount this page. No figures, no vendor-research names.
 */
import { useCallback, useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { APP_HOME_PATH } from "@canary/shared";
import { Button } from "@/components/ui/button.tsx";
import { INTRO_SAMPLE_BUBBLES, hasSeenIntro, markIntroSeen } from "@/lib/intro.ts";

export function IntroPage() {
  if (hasSeenIntro()) {
    return <Navigate to={APP_HOME_PATH} replace />;
  }
  return <IntroLanding />;
}

function IntroLanding() {
  const navigate = useNavigate();

  const enter = useCallback(() => {
    markIntroSeen();
    navigate(APP_HOME_PATH, { replace: true });
  }, [navigate]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target instanceof HTMLElement ? event.target.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      event.preventDefault();
      enter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enter]);

  return (
    <div className="intro-page min-h-dvh bg-[#f3efe6] text-[#1c1914]">
      <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col justify-center gap-12 px-6 py-12 lg:flex-row lg:items-center lg:gap-20 lg:px-10">
        <div className="max-w-md">
          <img
            src="/canary-lockup.png"
            alt="Canary"
            width={634}
            height={652}
            className="intro-lockup h-auto w-[11.25rem] sm:w-[13rem]"
          />
          <h1 className="mt-8 text-3xl font-semibold tracking-tight text-pretty sm:text-4xl">
            Your early warning system for startup finances.
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-[#3f3a32] text-pretty">
            Canaries warned miners about toxic gas before they could detect it themselves.
          </p>
          <p className="mt-3 text-base leading-relaxed text-[#3f3a32] text-pretty">
            Canary watches your company’s spending for dangerous shifts — and tells you when
            something changes.
          </p>
          <p className="mt-3 text-base leading-relaxed text-[#6b6458] text-pretty">
            See what changed, what’s driving it, and what it means for your runway.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              type="button"
              size="lg"
              onClick={enter}
              className="rounded-full bg-[#1c1914] px-7 text-base text-[#f3efe6] hover:bg-[#2a261f]"
            >
              Start
            </Button>
            <p className="text-sm text-[#6b6458]">or press Enter</p>
          </div>
        </div>

        <IntroIMessage />
      </div>
    </div>
  );
}

function IntroIMessage() {
  return (
    <figure className="intro-imessage mx-auto w-full max-w-[280px] shrink-0" aria-label="Sample iMessage from Canary">
      <div className="rounded-[2rem] border-[10px] border-[#1c1914] bg-[#f7f7f7] shadow-[0_24px_60px_rgb(28_25_20/0.18)]">
        <div className="border-b border-black/5 px-4 pb-3 pt-3 text-center">
          <p className="text-[11px] font-semibold text-[#1c1914]">Canary</p>
          <p className="text-[10px] text-[#8e8e93]">iMessage</p>
        </div>
        <div className="intro-imessage-thread relative min-h-[16.25rem] space-y-2 px-3 py-4">
          <div className="intro-imessage-typing" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          {INTRO_SAMPLE_BUBBLES.map((line, index) => (
            <p key={line} className={`intro-imessage-bubble intro-imessage-bubble-${index + 1}`}>
              {line}
            </p>
          ))}
        </div>
      </div>
      <figcaption className="mt-3 text-center text-[11px] leading-relaxed text-[#8a8376]">
        Sample shape — no figures. Live numbers come from the ledger.
      </figcaption>
    </figure>
  );
}
