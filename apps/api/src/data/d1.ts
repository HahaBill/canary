/**
 * Tiny typed wrapper over the D1 tables in `migrations/0001_init.sql`
 * (+ the additive columns in `0002_imessage_log_metadata.sql`).
 *
 * Everything here talks to `SqlDatabase`, a structural subset of `D1Database`,
 * so tests can pass an in-memory fake without pulling in miniflare/workerd.
 * Every statement is a single-line `INSERT`/`SELECT` with an explicit column
 * list, which keeps the fake honest and the real SQL boring.
 */
import type { Incident, IncidentStatus, ISODateTime, VendorEnrichment } from "@canary/shared";

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

const INCIDENT_COLUMNS =
  "id, type, entity, status, estimated_change_point, first_detected, last_updated, last_notified, payload_json";

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
      await this.db
        .prepare("INSERT INTO imessage_log (direction, phone, body, created_at) VALUES (?, ?, ?, ?)")
        .bind(row.direction, row.phone, row.body, row.created_at)
        .run();
    }
  }
}
