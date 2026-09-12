/**
 * OpenAI semantic classification — the *ambiguity* signal (PRD §21).
 *
 * The model returns a category and one sentence of prose. It never returns a
 * number, a URL, or a confidence score, and it is never trusted alone:
 * `classifyTransactions` decides confidence from signal agreement.
 *
 * Plain `fetch`, no SDK. Anything malformed or off-list throws
 * `LlmNoAnswerError`, which the pipeline treats as "the model did not answer".
 */
import type { Category, LlmCategoryProposal, LlmProvider } from "@canary/shared";
import { asRecord, defaultFetch, parseJsonSafe, sanitizeModelText, truncate, type FetchLike } from "../http.ts";

export const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
export const OPENAI_MODEL = "gpt-4o-mini";

/** The model declined, returned unparseable JSON, or proposed a category outside the allowed list. */
export class LlmNoAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmNoAnswerError";
  }
}

export interface OpenAiProviderOptions {
  model?: string;
  url?: string;
  /** Provider name recorded in supporting signals. */
  name?: string;
}

/** Exported for tests: the allowed list is part of the prompt, not a post-hoc filter only. */
export function buildOpenAiSystemPrompt(allowedCategories: readonly Category[]): string {
  return [
    "You categorize a single business bank transaction for a startup finance tool.",
    "Use your knowledge of the real company behind the merchant descriptor (bank descriptors are abbreviated, e.g. 'ASHBYHQ INC' is Ashby, 'AMZN WEB SERV' is Amazon Web Services).",
    `Allowed categories (use exactly one, verbatim): ${allowedCategories.join(", ")}.`,
    'Respond with JSON only: {"category": "<one of the allowed categories>", "reason": "<one sentence>"}.',
    "Rules:",
    "- The category must be one of the allowed strings, uppercase, with no other value and no new categories.",
    "- Choose the MOST SPECIFIC category that describes what the company is used for. A software product is only SAAS_SOFTWARE when no more specific category applies: recruiting/ATS software is RECRUITING, hosting/compute/CDN is CLOUD_INFRASTRUCTURE, ad/CRM/email-marketing tools are MARKETING, payroll/HR platforms are PAYROLL.",
    "- The reason is one short sentence naming the company and what it does.",
    "- Never include amounts, numbers, URLs, citations, or a confidence score.",
    "- If the vendor is unfamiliar, pick the closest allowed category; the caller decides whether to trust you.",
  ].join("\n");
}

function buildUserPrompt(input: {
  merchant_raw: string;
  merchant_normalized: string;
  description: string;
  amount_cents: number;
  history_summary: string;
}): string {
  const direction = input.amount_cents < 0 ? "outflow" : "inflow";
  return [
    `Bank descriptor: ${input.merchant_raw || "(none)"}`,
    `Entity key: ${input.merchant_normalized}`,
    `Description: ${input.description.trim() || "(none)"}`,
    `Direction: ${direction}`,
    `Vendor history: ${input.history_summary || "(none)"}`,
  ].join("\n");
}

/**
 * `LlmProvider` over OpenAI chat completions in JSON mode, temperature 0.
 * `fetchImpl` defaults to `globalThis.fetch`.
 */
export function OpenAiProvider(apiKey: string, fetchImpl?: FetchLike, options: OpenAiProviderOptions = {}): LlmProvider {
  const doFetch = fetchImpl ?? defaultFetch();
  const model = options.model ?? OPENAI_MODEL;
  const url = options.url ?? OPENAI_CHAT_COMPLETIONS_URL;
  const name = options.name ?? "openai";

  return {
    name,
    async proposeCategory(input): Promise<LlmCategoryProposal> {
      const allowed = input.allowed_categories;
      if (allowed.length === 0) throw new LlmNoAnswerError("no allowed categories were provided");

      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: buildOpenAiSystemPrompt(allowed) },
            { role: "user", content: buildUserPrompt(input) },
          ],
        }),
      });

      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`${name} request failed with status ${response.status}: ${truncate(raw, 200)}`);
      }

      const envelope = asRecord(parseJsonSafe(raw));
      const choices = envelope?.["choices"];
      const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : null;
      const message = asRecord(firstChoice?.["message"]);
      const content = message?.["content"];
      if (typeof content !== "string" || content.trim() === "") {
        throw new LlmNoAnswerError(`${name} returned no message content`);
      }

      const payload = asRecord(parseJsonSafe(content));
      if (payload === null) {
        throw new LlmNoAnswerError(`${name} returned content that is not a JSON object`);
      }

      const proposedRaw = payload["category"];
      const proposed = typeof proposedRaw === "string" ? proposedRaw.trim().toUpperCase() : "";
      const category = allowed.find((c) => c === proposed);
      if (category === undefined) {
        throw new LlmNoAnswerError(`${name} proposed a category outside the allowed list: ${truncate(String(proposedRaw), 60)}`);
      }

      const reasonRaw = payload["reason"];
      const reason = typeof reasonRaw === "string" ? sanitizeModelText(reasonRaw) : "";
      return { category, reason: reason === "" ? `${category} proposed by ${name} (${model}).` : reason };
    },
  };
}
