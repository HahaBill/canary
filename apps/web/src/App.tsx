import { Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/AppShell.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { CalendarPage } from "@/pages/CalendarPage.tsx";
import { Dashboard } from "@/pages/Dashboard.tsx";
import { IncidentPage } from "@/pages/IncidentPage.tsx";
import { IncidentsPage } from "@/pages/IncidentsPage.tsx";
import { LedgerPage } from "@/pages/LedgerPage.tsx";
import { NeedsReviewPage } from "@/pages/NeedsReviewPage.tsx";
import { NotFound } from "@/pages/NotFound.tsx";

/**
 * Assumes a router above it, so tests can mount it inside a `MemoryRouter`.
 * `main.tsx` supplies the `BrowserRouter`.
 */
export default function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="incidents/:id" element={<IncidentPage />} />
          <Route path="ledger" element={<LedgerPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="needs-review" element={<NeedsReviewPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}
