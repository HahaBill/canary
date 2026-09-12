import "@testing-library/jest-dom/vitest";

/** Recharts' ResponsiveContainer needs ResizeObserver; jsdom has no implementation. */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub;
