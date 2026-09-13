/**
 * Five-second door: Canary's promise, an iMessage-shaped product demo, Start / Enter.
 * Deep links never mount this page. The sample intentionally contains no financial figures.
 */
import { useCallback, useEffect } from "react";
import { ArrowRight, AudioLines, ChevronLeft, Info } from "lucide-react";
import { Navigate, useNavigate } from "react-router-dom";
import { APP_HOME_PATH } from "@canary/shared";
import { Button } from "@/components/ui/button.tsx";
import { INTRO_SAMPLE_BUBBLES, hasSeenIntro, markIntroSeen } from "@/lib/intro.ts";
import "./IntroPage.css";

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
    <div className="canary-landing">
      <a className="canary-landing__skip" href="#landing-main">
        Skip to main content
      </a>

      <header className="canary-landing__header" aria-label="Landing navigation">
        <a className="canary-landing__brand" href="/" aria-label="Canary home">
          <span className="canary-landing__brand-mark" aria-hidden="true">🐤</span>
          <span>Canary</span>
        </a>

        <nav className="canary-landing__nav" aria-label="Landing page">
          <a href="#how-it-works">How it works</a>
          <Button type="button" size="md" onClick={enter} className="canary-landing__nav-cta">
            Open demo
          </Button>
        </nav>
      </header>

      <main id="landing-main">
        <section className="canary-landing__hero" aria-labelledby="intro-heading">
          <div className="canary-landing__copy">
            <p className="canary-landing__eyebrow">
              <span aria-hidden="true" />
              Early warning for startup cash
            </p>
            <h1 id="intro-heading">
              Your startup’s cash should never <em>surprise you.</em>
            </h1>
            <p className="canary-landing__lede">
              Canary reconciles financial activity, detects meaningful spending shifts, and texts
              the founder when the pattern changes.
            </p>

            <div className="canary-landing__actions">
              <Button type="button" size="lg" onClick={enter} className="canary-landing__primary-cta">
                Explore the live demo
                <ArrowRight aria-hidden="true" />
              </Button>
              <span className="canary-landing__key-hint">or press <kbd>Enter</kbd></span>
            </div>

            <ul className="canary-landing__principles" aria-label="Canary principles">
              <li>Deterministic money math</li>
              <li>Evidence you can inspect</li>
              <li>Reports, never decides</li>
            </ul>
          </div>

          <div className="canary-landing__device-stage">
            <span className="canary-landing__sticker canary-landing__sticker--signal" aria-hidden="true">
              Signal found
            </span>
            <span className="canary-landing__sticker canary-landing__sticker--taxonomy" aria-hidden="true">
              Observed → Detected
            </span>
            <span className="canary-landing__orbit canary-landing__orbit--one" aria-hidden="true" />
            <span className="canary-landing__orbit canary-landing__orbit--two" aria-hidden="true" />
            <IntroIPhone />
          </div>
        </section>

        <section id="how-it-works" className="canary-landing__how" aria-labelledby="how-heading">
          <div className="canary-landing__how-heading">
            <p>How Canary works</p>
            <h2 id="how-heading">Reconcile first. Detect second. Explain everything.</h2>
          </div>

          <div className="canary-landing__steps">
            <article>
              <span aria-hidden="true">01</span>
              <h3>Start with clean cash activity</h3>
              <p>Transfers, settlements, financing, and unknown categories are handled before burn is modeled.</p>
            </article>
            <article>
              <span aria-hidden="true">02</span>
              <h3>Watch for real changes</h3>
              <p>One-off shocks and sustained spending shifts use separate, deterministic rules.</p>
            </article>
            <article>
              <span aria-hidden="true">03</span>
              <h3>Show the trail</h3>
              <p>Every explanation leads back to observed ledger activity, detector output, and cited evidence.</p>
            </article>
          </div>

          <div className="canary-landing__closing">
            <div>
              <p>Built for the moment a spreadsheet is too late.</p>
              <h2>See the alert. Follow the evidence.</h2>
            </div>
            <Button type="button" size="lg" onClick={enter} className="canary-landing__closing-cta">
              Open Canary
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>

          <footer>
            <span>Canary</span>
            <p>Fictional company · synthetic, deterministic demo data</p>
          </footer>
        </section>
      </main>
    </div>
  );
}

function IntroIPhone() {
  return (
    <figure className="canary-landing__phone-figure" aria-label="Sample iMessage conversation with Canary">
      <div className="canary-landing__phone">
        <div className="canary-landing__phone-screen">
          <div className="canary-landing__dynamic-island" aria-hidden="true" />
          <div className="canary-landing__status" aria-hidden="true">
            <span>9:41</span>
            <span className="canary-landing__status-icons">● ᴡɪꜰɪ ▰</span>
          </div>

          <div className="canary-landing__contact">
            <ChevronLeft aria-hidden="true" />
            <div className="canary-landing__contact-identity">
              <span aria-hidden="true">🐤</span>
              <strong>Canary</strong>
              <small>iMessage</small>
            </div>
            <Info aria-hidden="true" />
          </div>

          <div className="canary-landing__thread">
            <p className="canary-landing__message-time">Now</p>
            <div className="canary-landing__typing" aria-hidden="true"><i /><i /><i /></div>
            {INTRO_SAMPLE_BUBBLES.map((line, index) => (
              <p
                key={line}
                className={`canary-landing__bubble canary-landing__bubble--incoming canary-landing__bubble--${index + 1}`}
              >
                {line}
              </p>
            ))}
            <div className="canary-landing__voice-note" aria-label="Sample Canary voice note">
              <span className="canary-landing__play" aria-hidden="true">▶</span>
              <AudioLines aria-hidden="true" />
              <span>Voice note</span>
              <small>0:15</small>
            </div>
            <p className="canary-landing__bubble canary-landing__bubble--outgoing">WHY</p>
            <p className="canary-landing__delivered">Delivered</p>
          </div>

          <div className="canary-landing__composer" aria-hidden="true">
            <span>＋</span>
            <div>iMessage</div>
            <span>🎙</span>
          </div>
          <div className="canary-landing__home-indicator" aria-hidden="true" />
        </div>
      </div>
      <figcaption>Illustrative conversation · live figures come from the reconciled ledger</figcaption>
    </figure>
  );
}
