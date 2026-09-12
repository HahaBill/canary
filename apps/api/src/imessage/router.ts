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
export function shouldIgnoreInbound(payload: SendblueInboundPayload): boolean {
  return payload.is_outbound === true || !payload.content || payload.content.trim().length === 0;
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
