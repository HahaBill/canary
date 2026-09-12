/**
 * Tiny typed wrapper over the D1 tables in `migrations/0001_init.sql`
 * (+ the additive columns in `0002_imessage_log_metadata.sql` and the two tables
 * in `0003_pending_alerts_and_overrides.sql`).
 *
 * Everything here talks to `SqlDatabase`, a structural subset of `D1Database`,
 * so tests can pass an in-memory fake without pulling in miniflare/workerd.
 * Every statement is a single-line `INSERT`/`SELECT` with an explicit column
 * list, which keeps the fake honest and the real SQL boring.
 */
import type {
  AlertHistoryItem,
  Category,
  ClassificationOverride,
  Incident,
  IncidentStatus,
  ISODateTime,
  VendorEnrichment,
} from "@canary/shared";

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement;
}

/** Status fields D1 owns; everything else on an incident comes from the pipeline. */
export interface IncidentOverlay {
  status: IncidentStatus;
  last_updated: ISODateTime;
  last_notified: ISODateTime | null;
}

export type MessageDirection = "inbound" | "outbound";

export interface MessageLogRow {
  direction: MessageDirection;
  phone: string;
  body: string;
  created_at: ISODateTime;
  command?: string | null;
  provider_message_id?: string | null;
}

/** A queued alert, as stored. `PendingAlert` (the contract shape) is the public projection of this. */
export interface PendingAlertRow {
  id: string;
  incident_id: string;
  to_phone: string;
  voice: boolean;
  created_at: ISODateTime;
  deliver_after: ISODateTime;
  attempts: number;
  delivered_at: ISODateTime | null;
}

const INCIDENT_COLUMNS =
  "id, type, entity, status, estimated_change_point, first_detected, last_updated, last_notified, payload_json";
const PENDING_COLUMNS = "id, incident_id, to_phone, voice, created_at, deliver_after, attempts, delivered_at";
const OVERRIDE_COLUMNS = "transaction_id, merchant_normalized, category, apply_to_merchant, note, created_at";

/** Deterministic row id, so re-queueing the same alert upserts instead of duplicating the text. */
export function pendingAlertId(incidentId: string, createdAt: ISODateTime): string {
  return `${incidentId}|${createdAt}`;
}

/** A voice note is logged with this prefix, which is how alert history knows it was spoken. */
export const VOICE_LOG_PREFIX = "[voice note";

export class D1Store {
  constructor(private readonly db: SqlDatabase) {}

  /** Status overlay for every incident D1 knows about, keyed by incident id. */
  async listIncidentOverlays(): Promise<Map<string, IncidentOverlay>> {
    const { results } = await this.db
      .prepare("SELECT id, status, last_updated, last_notified FROM incidents")
      .all<{ id: string; status: string; last_updated: string; last_notified: string | null }>();
    const out = new Map<string, IncidentOverlay>();
    for (const row of results ?? []) {
      out.set(row.id, {
        status: row.status as IncidentStatus,
        last_updated: row.last_updated,
        last_notified: row.last_notified ?? null,
      });
    }
    return out;
  }

  async saveIncident(incident: Incident): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO incidents (${INCIDENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
          "ON CONFLICT(id) DO UPDATE SET status = excluded.status, estimated_change_point = excluded.estimated_change_point, " +
          "last_updated = excluded.last_updated, last_notified = excluded.last_notified, payload_json = excluded.payload_json",
      )
      .bind(
        incident.id,
        incident.type,
        incident.entity,
        incident.status,
        incident.estimated_change_point,
        incident.first_detected,
        incident.last_updated,
        incident.last_notified,
        JSON.stringify(incident),
      )
      .run();
  }

  async getEnrichment(merchantNormalized: string): Promise<VendorEnrichment | null> {
    const row = await this.db
      .prepare("SELECT payload_json FROM vendor_enrichments WHERE merchant_normalized = ?")
      .bind(merchantNormalized)
      .first<{ payload_json: string }>();
    if (!row?.payload_json) return null;
    try {
      return JSON.parse(row.payload_json) as VendorEnrichment;
    } catch {
      return null;
    }
  }

  async saveEnrichment(enrichment: VendorEnrichment): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO vendor_enrichments (merchant_normalized, payload_json, retrieved_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(merchant_normalized) DO UPDATE SET payload_json = excluded.payload_json, retrieved_at = excluded.retrieved_at",
      )
      .bind(enrichment.merchant_normalized, JSON.stringify(enrichment), enrichment.retrieved_at)
      .run();
  }

  async logMessage(row: MessageLogRow): Promise<void> {
    try {
      await this.db
        .prepare(
          "INSERT INTO imessage_log (direction, phone, body, created_at, command, provider_message_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(row.direction, row.phone, row.body, row.created_at, row.command ?? null, row.provider_message_id ?? null)
        .run();
    } catch {
      // Migration 0002 may not be applied yet — fall back to the 0001 columns.
      try {
        await this.db
          .prepare("INSERT INTO imessage_log (direction, phone, body, created_at) VALUES (?, ?, ?, ?)")
          .bind(row.direction, row.phone, row.body, row.created_at)
          .run();
      } catch (err) {
        // Logging is best-effort: never let an audit-log failure block a reply to the founder.
        console.warn(JSON.stringify({ msg: "imessage_log_failed", error: err instanceof Error ? err.message : String(err) }));
      }
    }
  }

  /** Newest first. Backs `GET /api/alerts/history`. */
  async listMessages(limit: number): Promise<AlertHistoryItem[]> {
    const { results } = await this.db
      .prepare("SELECT id, direction, phone, body, created_at, command FROM imessage_log ORDER BY id DESC LIMIT ?")
      .bind(limit)
      .all<{ id: number | null; direction: string; phone: string; body: string; created_at: string; command: string | null }>();
    return (results ?? []).map((row) => ({
      id: Number(row.id ?? 0),
      direction: row.direction === "inbound" ? "inbound" : "outbound",
      phone: row.phone,
      body: row.body,
      created_at: row.created_at,
      command: row.command ?? null,
      voice: row.body.startsWith(VOICE_LOG_PREFIX),
    }));
  }

  /** Upsert by the deterministic id: also how a deferral is pushed back and a delivery recorded. */
  async savePendingAlert(row: PendingAlertRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pending_alerts (${PENDING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ` +
          "ON CONFLICT(id) DO UPDATE SET deliver_after = excluded.deliver_after, attempts = excluded.attempts, " +
          "delivered_at = excluded.delivered_at, voice = excluded.voice, to_phone = excluded.to_phone",
      )
      .bind(row.id, row.incident_id, row.to_phone, row.voice ? 1 : 0, row.created_at, row.deliver_after, row.attempts, row.delivered_at)
      .run();
  }

  /**
   * Every queued alert, oldest deliverable first. The undelivered filter is applied
   * in TypeScript rather than SQL: the table holds one row per deferred incident
   * (single digits for the life of this demo), and keeping the statement shape
   * boring is what lets the tests run without workerd.
   */
  async listPendingAlerts(): Promise<PendingAlertRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${PENDING_COLUMNS} FROM pending_alerts ORDER BY deliver_after ASC`)
      .all<Record<string, unknown>>();
    return (results ?? []).map((row) => ({
      id: String(row.id),
      incident_id: String(row.incident_id),
      to_phone: String(row.to_phone),
      voice: row.voice === 1 || row.voice === true || row.voice === "1",
      created_at: String(row.created_at),
      deliver_after: String(row.deliver_after),
      attempts: Number(row.attempts ?? 0),
      delivered_at: row.delivered_at === null || row.delivered_at === undefined ? null : String(row.delivered_at),
    }));
  }

  async listUndeliveredAlerts(): Promise<PendingAlertRow[]> {
    return (await this.listPendingAlerts()).filter((row) => row.delivered_at === null);
  }

  async saveClassificationOverride(override: ClassificationOverride): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO classification_overrides (${OVERRIDE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?) ` +
          "ON CONFLICT(transaction_id) DO UPDATE SET merchant_normalized = excluded.merchant_normalized, " +
          "category = excluded.category, apply_to_merchant = excluded.apply_to_merchant, note = excluded.note, created_at = excluded.created_at",
      )
      .bind(
        override.transaction_id,
        override.merchant_normalized,
        override.category,
        override.apply_to_merchant ? 1 : 0,
        override.note ?? null,
        override.created_at,
      )
      .run();
  }

  async listClassificationOverrides(): Promise<ClassificationOverride[]> {
    const { results } = await this.db
      .prepare(`SELECT ${OVERRIDE_COLUMNS} FROM classification_overrides ORDER BY created_at ASC`)
      .all<Record<string, unknown>>();
    return (results ?? []).map((row) => ({
      transaction_id: String(row.transaction_id),
      merchant_normalized: String(row.merchant_normalized),
      category: String(row.category) as Category,
      apply_to_merchant: row.apply_to_merchant === 1 || row.apply_to_merchant === true || row.apply_to_merchant === "1",
      ...(row.note === null || row.note === undefined ? {} : { note: String(row.note) }),
      created_at: String(row.created_at),
    }));
  }
}
