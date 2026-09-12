/** `/api/incidents*` — list, detail, evidence, status, voice note. */
import type { Incident, IncidentDetailResponse, IncidentEvidenceResponse, IncidentsResponse, IncidentStatus } from "@canary/shared";
import { jsonError, readJson, type CanaryApp } from "../context.ts";
import { alertVoiceScript } from "../messages.ts";
import { getIncidentDetail } from "../tools.ts";

/** `IncidentStatus` is a type-only union in shared — see "contract gaps". */
const INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const satisfies readonly IncidentStatus[];

export interface IncidentStatusResponse {
  incident: Incident;
}

/**
 * MP3 bytes per isolate, keyed by incident id + a hash of the script, so a
 * re-render (or a changed incident) misses the cache instead of serving stale
 * audio. Small and bounded: this is a demo page's Listen button, not a CDN.
 */
const MAX_CACHED_VOICE_NOTES = 8;
const voiceCache = new Map<string, Uint8Array>();

/** FNV-1a — short, stable, and not a security boundary. */
function scriptHash(script: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < script.length; i++) {
    hash ^= script.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Test seam: drop the isolate-level voice cache. */
export function clearVoiceCache(): void {
  voiceCache.clear();
}

export function registerIncidentRoutes(app: CanaryApp): void {
  app.get("/api/incidents", async (c) => {
    const derived = await c.get("provider").getDerived();
    const body: IncidentsResponse = { incidents: derived.incidents };
    return c.json(body);
  });

  app.get("/api/incidents/:id", async (c) => {
    const detail = await getIncidentDetail(c.get("provider"), c.req.param("id"));
    if (!detail) return jsonError(c, 404, "incident_not_found", `No incident with id ${c.req.param("id")}.`);
    const body: IncidentDetailResponse = detail;
    return c.json(body);
  });

  app.get("/api/incidents/:id/evidence", async (c) => {
    const detail = await getIncidentDetail(c.get("provider"), c.req.param("id"));
    if (!detail) return jsonError(c, 404, "incident_not_found", `No incident with id ${c.req.param("id")}.`);
    const body: IncidentEvidenceResponse = { evidence: detail.evidence };
    return c.json(body);
  });

  /**
   * The web app's "Listen" button: the SAME script the iMessage voice note
   * speaks (`alertVoiceScript`), so the page and the phone cannot diverge.
   * Playback loudness is the client's business — no normalisation here.
   */
  app.get("/api/incidents/:id/voice", async (c) => {
    const id = c.req.param("id");
    const incident = await c.get("provider").getIncident(id);
    if (!incident) return jsonError(c, 404, "incident_not_found", `No incident with id ${id}.`);

    const tts = c.get("tts");
    if (!tts.configured) return jsonError(c, 503, "tts_not_configured", "ELEVENLABS_API_KEY is not set.");

    const script = alertVoiceScript(incident);
    const key = `${incident.id}:${scriptHash(script)}`;
    let mp3 = voiceCache.get(key);
    if (!mp3) {
      const result = await tts.synthesizeMp3(script);
      if (!result.ok || !result.mp3) return jsonError(c, 502, "tts_failed", result.error ?? `HTTP ${result.status}`);
      mp3 = result.mp3;
      if (voiceCache.size >= MAX_CACHED_VOICE_NOTES) {
        const oldest = voiceCache.keys().next().value;
        if (oldest !== undefined) voiceCache.delete(oldest);
      }
      voiceCache.set(key, mp3);
    }

    return c.body(mp3.slice().buffer as ArrayBuffer, 200, {
      "content-type": "audio/mpeg",
      "content-length": String(mp3.byteLength),
      "cache-control": "public, max-age=300",
      // The transcript is the contract between text and voice; expose it for debugging.
      "x-canary-transcript-hash": scriptHash(script),
    });
  });

  app.post("/api/incidents/:id/status", async (c) => {
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_json", "Request body must be a JSON object.");

    const status = body.status;
    if (typeof status !== "string" || !(INCIDENT_STATUSES as readonly string[]).includes(status)) {
      return jsonError(c, 400, "invalid_status", `\`status\` must be one of: ${INCIDENT_STATUSES.join(", ")}.`);
    }

    const id = c.req.param("id");
    const incident = await c.get("provider").updateIncidentStatus(id, status as IncidentStatus, c.get("now")());
    if (!incident) return jsonError(c, 404, "incident_not_found", `No incident with id ${id}.`);
    const response: IncidentStatusResponse = { incident };
    return c.json(response);
  });
}
