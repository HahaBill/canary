// Skeleton Worker — replaced by the API workstream. Keeps CI's dry-run deploy green
// and provides a minimal verified Sendblue webhook echo for Phase 0 smoke testing.
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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function webhookAuthorized(request: Request, env: Env): "ok" | "unauthorized" | "unconfigured" {
  if (!env.WEBHOOK_SECRET) return "unconfigured";
  const url = new URL(request.url);
  const candidates = [request.headers.get("sb-signing-secret"), request.headers.get("x-canary-secret"), url.searchParams.get("secret")];
  return candidates.some((c) => c !== null && constantTimeEqual(c, env.WEBHOOK_SECRET!)) ? "ok" : "unauthorized";
}

async function sendblueSend(env: Env, to: string, content: string): Promise<Response> {
  return fetch("https://api.sendblue.co/api/send-message", {
    method: "POST",
    headers: {
      "sb-api-key-id": env.SENDBLUE_API_KEY ?? "",
      "sb-api-secret-key": env.SENDBLUE_API_SECRET ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({ number: to, content, from_number: env.SENDBLUE_FROM_NUMBER }),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      const body: HealthResponse = { ok: true, service: "canary-api", version: "0.0.1", time: new Date().toISOString() };
      return Response.json(body);
    }

    if (url.pathname === "/webhooks/sendblue" && request.method === "POST") {
      const auth = webhookAuthorized(request, env);
      if (auth === "unconfigured") return Response.json({ error: "webhook secret not configured" }, { status: 503 });
      if (auth === "unauthorized") return Response.json({ error: "unauthorized" }, { status: 401 });
      const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const content = typeof payload.content === "string" ? payload.content.trim() : "";
      const from = typeof payload.from_number === "string" ? payload.from_number : "";
      if (payload.is_outbound === true || !content || !from) return Response.json({ ok: true, ignored: true });
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO imessage_log (direction, phone, body, created_at) VALUES (?, ?, ?, ?)").bind("inbound", from, content, now).run().catch(() => {});
      const reply = `🐤 Canary webhook test OK — received "${content}". Full WHY / SHOW ME commands arrive with the next deploy.`;
      const res = await sendblueSend(env, from, reply);
      await env.DB.prepare("INSERT INTO imessage_log (direction, phone, body, created_at) VALUES (?, ?, ?, ?)").bind("outbound", from, reply, now).run().catch(() => {});
      return Response.json({ ok: true, replied: res.ok, sendblue_status: res.status });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
