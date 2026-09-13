import { useState } from "react";
import type { CalendarConnectionResponse, ISODate } from "@canary/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAvailability, useCalendar, useCalendarConnection } from "@/api/useDerived.ts";
import { AvailabilityPill } from "@/components/calendar/AvailabilityPill.tsx";
import { CalendarLegend } from "@/components/calendar/CalendarLegend.tsx";
import { DayPanel } from "@/components/calendar/DayPanel.tsx";
import { MonthGrid } from "@/components/calendar/MonthGrid.tsx";
import { ErrorState, PanelSkeleton } from "@/components/States.tsx";
import { Button } from "@/components/ui/button.tsx";
import { formatDateMedium, formatMonthLong } from "@/lib/format.ts";
import { addMonths, firstDayOfMonth, lastDayOfMonth, monthKeyOf } from "@/lib/month.ts";

export function CalendarPage() {
  const { data: availability, loading: availabilityLoading } = useAvailability();
  const { data: connection } = useCalendarConnection();
  const today: ISODate | null = availability?.checked_at.slice(0, 10) ?? null;

  const [month, setMonth] = useState<string | null>(null);
  const visibleMonth = month ?? (today ? monthKeyOf(today) : null);

  if (!visibleMonth || !today) {
    return (
      <div className="space-y-5">
        <PanelSkeleton className="h-12" />
        <PanelSkeleton className="h-[28rem]" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            When Canary can text
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Same calendar the notifier reads. Meetings hold alerts until they end.
          </p>
        </div>
        <AvailabilityPill
          availability={availability}
          connection={connection}
          loading={availabilityLoading}
        />
      </header>

      <ConnectionCard connection={connection} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-neutral-900">{formatMonthLong(visibleMonth)}</h2>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => setMonth(addMonths(visibleMonth, -1))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMonth(monthKeyOf(today))}
            disabled={visibleMonth === monthKeyOf(today)}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            onClick={() => setMonth(addMonths(visibleMonth, 1))}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <MonthView key={visibleMonth} month={visibleMonth} today={today} connection={connection} />

      <CalendarLegend />

      <p className="text-[11px] leading-relaxed text-neutral-400">
        as of {formatDateMedium(today)}. Titles stay hidden unless the operator turns them on. Canary
        never texts during a busy block; replies to a text you already sent are always allowed.
      </p>
    </div>
  );
}

function accountsDiffer(connected?: string, expected?: string): boolean {
  return Boolean(connected && expected && connected.trim().toLowerCase() !== expected.trim().toLowerCase());
}

function ConnectionCard({ connection }: { connection: CalendarConnectionResponse | null }) {
  if (!connection) return null;

  if (connection.revoked_at) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p>
          Google Calendar access expired. Reconnect so Canary can wait out meetings instead of
          texting into one.
        </p>
        <OperatorConnectHint connection={connection} />
      </div>
    );
  }

  if (connection.provider === "google") {
    const mismatch = accountsDiffer(connection.account_email, connection.expected_account);
    return (
      <div
        className={
          mismatch
            ? "rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            : "rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-600"
        }
      >
        Reading{" "}
        <span className="font-medium text-neutral-900">{connection.account_email ?? "Google Calendar"}</span>
        . Free/busy only — the same signal that defers an iMessage alert.
        {mismatch ? (
          <p className="mt-2">
            Connected to a different account than {connection.expected_account}. That is flagged, not
            rejected — this calendar is still what free/busy uses. Disconnect and reconnect with the
            founder account if this was a mistake.
          </p>
        ) : null}
      </div>
    );
  }

  if (connection.provider === "ics") {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-600">
        Reading a private calendar feed. Canary waits when this feed says the founder is busy.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
      <p>
        No Google Calendar connected. Canary will text as soon as an incident is material — it cannot
        see meetings.
      </p>
      <OperatorConnectHint connection={connection} />
    </div>
  );
}

/** How an operator actually connects. Never includes WEBHOOK_SECRET — only the placeholder. */
function OperatorConnectHint({ connection }: { connection: CalendarConnectionResponse }) {
  const account = connection.expected_account;
  return (
    <div className="mt-2 space-y-2">
      {connection.google_oauth_configured ? (
        <p>
          Open this URL in a browser, replace{" "}
          <code className="rounded bg-white px-1 py-0.5 text-[11px]">{"<WEBHOOK_SECRET>"}</code> with the
          Worker secret (or local <code className="rounded bg-white px-1 py-0.5 text-[11px]">.dev.vars</code>
          ), then sign in
          {account ? (
            <>
              {" "}
              as <span className="font-medium text-neutral-900">{account}</span>
            </>
          ) : (
            " as the founder Google account"
          )}
          .
        </p>
      ) : (
        <p>
          The Worker is missing <code className="rounded bg-white px-1 py-0.5 text-[11px]">GOOGLE_CLIENT_ID</code>{" "}
          and <code className="rounded bg-white px-1 py-0.5 text-[11px]">GOOGLE_CLIENT_SECRET</code>. Set those
          secrets first, then open the start URL.
        </p>
      )}
      <p>
        <code className="block break-all rounded bg-white px-2 py-1.5 text-[11px] text-neutral-800">
          {connection.oauth_start_url}
        </code>
      </p>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        Locally the same path is on <code className="rounded bg-white px-1 py-0.5">http://localhost:8787</code>,
        not the Vite port. Google Testing-mode refresh tokens expire after 7 days — reconnect before
        a demo. A different Google account is flagged, not rejected.
      </p>
    </div>
  );
}

/** Keyed on the month, so a stale day selection cannot survive navigation. */
function MonthView({
  month,
  today,
  connection,
}: {
  month: string;
  today: ISODate;
  connection: CalendarConnectionResponse | null;
}) {
  const from = firstDayOfMonth(month);
  const to = lastDayOfMonth(month);
  const { data: calendar, error, reload } = useCalendar(from, to);
  const [selectedDate, setSelectedDate] = useState<ISODate | null>(null);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!calendar) return <PanelSkeleton className="h-[28rem]" />;

  const selectedDay = selectedDate
    ? (calendar.days.find((day) => day.date === selectedDate) ?? {
        date: selectedDate,
        events: [],
        net_actual_cents: 0,
        net_expected_cents: 0,
      })
    : null;

  return (
    <>
      <MonthGrid month={month} calendar={calendar} today={today} onSelectDay={setSelectedDate} />
      <DayPanel
        day={selectedDay}
        busySource={calendar.busy_source}
        connection={connection}
        onClose={() => setSelectedDate(null)}
      />
    </>
  );
}
