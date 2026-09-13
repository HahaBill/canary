/**
 * What is in Canary's remit, and what must never reach the model.
 *
 * Off-topic chatter (weather, jokes, news, homework) is refused before a
 * token is spent. Ambiguous messages ("hey", "and 40%?") still go through:
 * a follow-up has to survive, and a greeting gets a one-line offer of help.
 * Cash-domain words always win — "what's the weather doing to AWS spend"
 * is a ledger question.
 */
import type { RefusalKind } from "../messages.ts";

const CASH_DOMAIN_RE =
  /\b(runway|burn|cash|spend|spending|vendor|ledger|transaction|transactions|payment|payments|invoice|payroll|incident|flagged|canary|aws|datadog|figma|gusto|stripe|ashby|openai|github|wework|hubspot|upwork|doordash|what if|what-if|percent|bank|revenue|contractor|saas|cloud|rent|reconcil|review|charge|charges|outflow|inflow|merchant)\b|\$|\d\s*%/i;

const OFF_TOPIC_RE =
  /\b(weather|forecast|joke|jokes|poem|poems|recipe|recipes|sports|score|homework|essay|translate|lyrics|horoscope|trivia|riddle|celebrity|movie|netflix|bitcoin|crypto|stock market|election|politics)\b/i;

/** True when the text is about this company's money (or names a ledger vendor). */
export function mentionsCashDomain(text: string): boolean {
  return CASH_DOMAIN_RE.test(text);
}

/** Standalone off-topic with no cash vocabulary — safe to refuse without a model. */
export function isOffTopic(text: string): boolean {
  return OFF_TOPIC_RE.test(text) && !mentionsCashDomain(text);
}

export function scopeRefusal(text: string): RefusalKind | null {
  return isOffTopic(text) ? "OFF_TOPIC" : null;
}
