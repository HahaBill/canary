/**
 * Viewport queries in JS rather than CSS, because the shell renders a sidebar
 * or a bottom tab bar — never both. Two nav landmarks in the accessibility
 * tree would be worse than a render on resize.
 */
import { useEffect, useState } from "react";

/** Tailwind's `md`. Kept in one place so the CSS and the JS agree. */
export const DESKTOP_MIN_WIDTH = 768;
const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

function matches(query: string): boolean {
  if (typeof window === "undefined") return false;
  // jsdom (and very old browsers) have no matchMedia; width is close enough
  // and keeps a desktop viewport on the desktop layout.
  if (typeof window.matchMedia !== "function") {
    return query === DESKTOP_QUERY ? window.innerWidth >= DESKTOP_MIN_WIDTH : false;
  }
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [active, setActive] = useState(() => matches(query));

  useEffect(() => {
    const update = () => setActive(matches(query));
    update();

    if (typeof window.matchMedia === "function") {
      const list = window.matchMedia(query);
      list.addEventListener("change", update);
      return () => list.removeEventListener("change", update);
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [query]);

  return active;
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
