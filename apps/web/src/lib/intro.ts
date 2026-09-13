/**
 * Intro is only ever shown at `/`. Home lives at `APP_HOME_PATH` (`/home`),
 * so a refresh on the dashboard cannot bounce back here. Session storage
 * skips a second visit to `/` in the same tab (Back after Enter, or typing `/`).
 */
export const INTRO_STORAGE_KEY = "canary.intro.seen";

/**
 * Figure-free sample of the product alert (docs/AGENT_BEHAVIOR.md).
 * Each line is its own incoming bubble on the intro — no invented money.
 */
export const INTRO_SAMPLE_BUBBLES = [
  "🐤 Canary",
  "I detected a sustained increase in variable spending.",
  "Cloud infrastructure is the biggest driver.",
  "Reply WHY or SHOW ME.",
] as const;

/** Speech-contract alert shape, with every figure line omitted (Rule 0). */
export const INTRO_SAMPLE_ALERT = INTRO_SAMPLE_BUBBLES.join("\n");

export function hasSeenIntro(): boolean {
  try {
    return window.sessionStorage.getItem(INTRO_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    window.sessionStorage.setItem(INTRO_STORAGE_KEY, "1");
  } catch {
    // Private browsing: Enter still works; this tab may see the intro again.
  }
}
