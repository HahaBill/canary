import { CANARY_GLYPHS } from "@/components/calendar/EventChip.tsx";

export function CalendarLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-neutral-500">
      <li className="flex items-center gap-1.5">
        <span className="h-3 w-5 rounded bg-neutral-100" aria-hidden="true" />
        posted
      </li>
      <li className="flex items-center gap-1.5">
        <span
          className="h-3 w-5 rounded border border-dashed border-neutral-300 bg-white"
          aria-hidden="true"
        />
        expected · from history
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-3 w-5 rounded bg-canary-100" aria-hidden="true" />
        Canary: <span aria-hidden="true">{CANARY_GLYPHS.change_point}</span> change point
        <span aria-hidden="true">{CANARY_GLYPHS.alarm}</span> alarm
        <span aria-hidden="true">{CANARY_GLYPHS.one_off}</span> one-off
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-3 w-5 rounded bg-neutral-100/70" aria-hidden="true" />
        busy
      </li>
    </ul>
  );
}
