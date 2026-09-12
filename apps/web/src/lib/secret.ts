/**
 * The shared operator secret that guards writes (the same one the Sendblue
 * webhook checks). It is a demo guard, not an auth system: the hackathon build
 * has no accounts, so the reviewer pastes it once and the browser keeps it.
 */
import { useCallback, useState } from "react";

export const SECRET_STORAGE_KEY = "canary.secret";

export function readOperatorSecret(): string | null {
  try {
    const value = window.localStorage.getItem(SECRET_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function useOperatorSecret(): {
  secret: string | null;
  save: (secret: string) => void;
  forget: () => void;
} {
  const [secret, setSecret] = useState<string | null>(readOperatorSecret);

  const save = useCallback((next: string) => {
    const trimmed = next.trim();
    if (!trimmed) return;
    try {
      window.localStorage.setItem(SECRET_STORAGE_KEY, trimmed);
    } catch {
      // Storage can be unavailable; the secret still works for this session.
    }
    setSecret(trimmed);
  }, []);

  const forget = useCallback(() => {
    try {
      window.localStorage.removeItem(SECRET_STORAGE_KEY);
    } catch {
      // Nothing to clean up.
    }
    setSecret(null);
  }, []);

  return { secret, save, forget };
}
