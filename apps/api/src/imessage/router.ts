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

/** E.164-ish comparison ignoring formatting. */
export function samePhone(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\D/g, "") === b.replace(/\D/g, "");
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
}

export function replyFor(command: IMessageCommand, ctx: ReplyContext): string {
  switch (command) {
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
