// Skeleton Worker — replaced by the API workstream. Keeps CI's dry-run deploy green.
import type { HealthResponse } from "@canary/shared";

export interface Env {
  DB: D1Database;
  SENDBLUE_API_KEY?: string;
  SENDBLUE_API_SECRET?: string;
  SENDBLUE_FROM_NUMBER?: string;
  OPENAI_API_KEY?: string;
  TAVILY_API_KEY?: string;
  WEBHOOK_SECRET?: string;
  FOUNDER_PHONE?: string;
  PUBLIC_BASE_URL?: string;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      const body: HealthResponse = { ok: true, service: "canary-api", version: "0.0.1", time: new Date().toISOString() };
      return Response.json(body);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
