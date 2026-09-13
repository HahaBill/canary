import "@testing-library/jest-dom/vitest";

/** Recharts' ResponsiveContainer needs ResizeObserver; jsdom has no implementation. */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub;

/**
 * Node's own experimental `localStorage` shadows jsdom's and resolves to
 * `undefined` without `--localstorage-file`, so the app sees no storage at all.
 * An in-memory Storage keeps the persisted-UI-state tests meaningful.
 */
class MemoryStorage implements Storage {
  private entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }
}

if (typeof window !== "undefined" && !window.localStorage) {
  Object.defineProperty(window, "localStorage", { value: new MemoryStorage(), configurable: true });
}
if (typeof window !== "undefined" && !window.sessionStorage) {
  Object.defineProperty(window, "sessionStorage", { value: new MemoryStorage(), configurable: true });
}
