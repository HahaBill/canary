import { Bird } from "lucide-react";
import { Outlet, Route, Routes } from "react-router-dom";
import { useDerived } from "@/api/useDerived.ts";
import { MockBanner } from "@/components/MockBanner.tsx";
import { ProvenanceBanner } from "@/components/ProvenanceBanner.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { Dashboard } from "@/pages/Dashboard.tsx";
import { IncidentPage } from "@/pages/IncidentPage.tsx";
import { NotFound } from "@/pages/NotFound.tsx";

/**
 * Assumes a router above it, so tests can mount it inside a `MemoryRouter`.
 * `main.tsx` supplies the `BrowserRouter`.
 */
export default function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="incidents/:id" element={<IncidentPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}

function AppLayout() {
  // Shares the cached request with whichever page is mounted.
  const { data, source } = useDerived();

  return (
    <div className="flex min-h-dvh flex-col">
      {data ? (
        <>
          <MockBanner provenance={data.provenance} source={source} />
          <ProvenanceBanner provenance={data.provenance} company={data.company} />
        </>
      ) : (
        <div className="h-8 border-b border-neutral-200 bg-white/80" />
      )}

      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-canary-400">
            <Bird className="h-4 w-4 text-neutral-900" aria-hidden="true" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-neutral-900">Canary</span>
          <span className="hidden text-xs text-neutral-400 sm:inline">
            Early warning for startup cash
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:py-8">
        <Outlet />
      </main>

      <footer className="border-t border-neutral-200 bg-white">
        <p className="mx-auto max-w-5xl px-4 py-4 text-[11px] leading-relaxed text-neutral-400">
          Canary is a hackathon demo. Money math is deterministic; language models never compute
          financial figures.
        </p>
      </footer>
    </div>
  );
}
