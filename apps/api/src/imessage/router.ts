/**
 * iMessage keyword router (PRD §23). P0 is keywords, not natural language:
 * WHY / SHOW ME / SOURCES / HELP, case- and whitespace-insensitive.
 */
import type { DerivedDemoObject, IMessageCommand, Incident } from "@canary/shared";
import { dashboardMessage, helpMessage, noIncidentMessage, showMeMessage, sourcesMessage, whyMessage } from "../messages.ts";
import type { SendblueInboundPayload } from "../sendblue/client.ts";

/** Normalized keyword → command. Everything else falls through to HELP. */
const ALIASES: Record<string, IMessageCommand> = {
  WHY: "WHY",
  SHOWME: "SHOW ME",
  SHOW: "SHOW ME",
  SOURCES: "SOURCES",
  SOURCE: "SOURCES",
  SCHEDULE: "SCHEDULE",
  BOOK: "SCHEDULE",
  SCHEDULEREVIEW: "SCHEDULE",
  HELP: "HELP",
  COMMANDS: "HELP",
};

/** `" show   me?? "` → `SHOW ME`; `"why?"` → `WHY`; unknown → null. */
export function matchCommand(raw: string | null | undefined): IMessageCommand | null {
  if (!raw) return null;
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return ALIASES[key] ?? null;
}

/** Outbound messages must never trigger a reply, and neither must empty ones. */
export function shouldIgnoreInbound(payload: SendblueInboundPayload, ownNumber?: string): boolean {
  const outbound = payload.is_outbound === true || String(payload.is_outbound).toLowerCase() === "true";
  const fromSelf = Boolean(ownNumber) && payload.from_number?.replace(/\D/g, "") === ownNumber!.replace(/\D/g, "");
  return outbound || fromSelf || !payload.content || payload.content.trim().length === 0;
}

/**
 * North American numbers, written any way a human writes them.
 *
 * Sendblue delivers `from_number` in E.164 (`+17875551234`), but the number an
 * operator pastes into `FOUNDER_PHONE` / `ALLOWED_PHONES` is whatever they had
 * in their contacts — often `787-555-1234`, with no country code. Comparing raw
 * digit strings makes those two different numbers, so Canary silently answers
 * nobody and the log just says `sender_not_allowed`. That is a miserable thing
 * to debug live, so the leading NANP `1` is optional on both sides.
 *
 * Deliberately narrow: the `1` is only dropped when exactly ten digits remain,
 * which is the North American plan. A number under any other country code keeps
 * all of its digits and cannot collide with a US one — this loosens the match
 * for one specific, well-defined case, not in general. Every other difference
 * still means a different number, because the reply carries the company's cash
 * position and must never reach someone who was not configured to see it.
 */
function nanp(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** E.164-ish comparison ignoring formatting and an optional NANP country code. */
export function samePhone(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = nanp(a);
  const right = nanp(b);
  return left.length > 0 && left === right;
}

/** Numbers Canary will talk to: FOUNDER_PHONE plus optional comma-separated ALLOWED_PHONES. */
export function isAllowedSender(from: string, env: { FOUNDER_PHONE?: string; ALLOWED_PHONES?: string }): boolean {
  const allowed = [env.FOUNDER_PHONE, ...(env.ALLOWED_PHONES ?? "").split(",")].map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  if (allowed.length === 0) return true; // nothing configured → open (dev)
  return allowed.some((p) => samePhone(p, from));
}

/** The number to reply to: the sender, falling back to the conversation number. */
export function replyTarget(payload: SendblueInboundPayload): string | null {
  const to = payload.from_number?.trim() || payload.number?.trim();
  return to ? to : null;
}

export interface ReplyContext {
  derived: DerivedDemoObject;
  incident: Incident | null;
  baseUrl: string;
  /** Books a review on the founder's calendar (Google only). Absent → honest "not connected" reply. */
  schedule?: (incident: Incident | null) => Promise<string>;
}

export async function replyFor(command: IMessageCommand, ctx: ReplyContext): Promise<string> {
  switch (command) {
    case "SCHEDULE":
      return ctx.schedule ? ctx.schedule(ctx.incident) : "I can't book that — no calendar is connected to Canary yet.";
    case "WHY":
      return ctx.incident ? whyMessage(ctx.derived, ctx.incident) : noIncidentMessage();
    case "SHOW ME":
      return ctx.incident ? showMeMessage(ctx.incident, ctx.baseUrl) : dashboardMessage(ctx.baseUrl);
    case "SOURCES":
      return sourcesMessage(ctx.derived, ctx.incident);
    case "HELP":
      return helpMessage();
  }
}
