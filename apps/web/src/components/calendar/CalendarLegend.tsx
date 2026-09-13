export function CalendarLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-neutral-500">
      <li className="flex items-center gap-1.5">
        <span className="h-3 w-5 rounded bg-emerald-50 ring-1 ring-emerald-100" aria-hidden="true" />
        Canary can text
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-3 w-5 rounded bg-amber-50 ring-1 ring-amber-100" aria-hidden="true" />
        In a meeting — alerts wait
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-3 w-5 rounded bg-canary-100" aria-hidden="true" />
        Review Canary booked
      </li>
    </ul>
  );
}
