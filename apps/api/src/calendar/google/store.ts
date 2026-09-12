/**
 * The single `google_oauth` row (migration 0005), read and written through the
 * same `SqlDatabase` subset `src/data/d1.ts` uses — so the in-memory fake covers
 * it and these tests need no workerd.
 *
 * Tokens are encrypted with AES-GCM before they touch the database and decrypted
 * on the way out. A D1 dump, a console query, or a screen-shared `wrangler d1
 * execute` therefore shows ciphertext. The plaintext exists only inside a single
 * request's memory.
 */
import type { ISODateTime } from "@canary/shared";
import type { SqlDatabase } from "../../data/d1.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";

/** One account: the founder's. No per-user auth in Canary, so no other id is ever used. */
export const FOUNDER_ROW_ID = "founder";

const COLUMNS =
  "id, refresh_token_encrypted, access_token_encrypted, expires_at, scope, account_email, connected_at, updated_at, revoked_at";

/** The row as the rest of the app sees it: tokens already decrypted. */
export interface GoogleConnection {
  refresh_token: string;
  access_token: string | null;
  /** Expiry of `access_token`, not of the connection. */
  expires_at: ISODateTime | null;
  scopes: string[];
  account_email: string | null;
  connected_at: ISODateTime;
  updated_at: ISODateTime;
  /** Set when Google told us the refresh token is dead. A revoked row never resolves to the Google provider. */
  revoked_at: ISODateTime | null;
}

export interface SaveConnectionInput {
  refresh_token: string;
  access_token: string;
  expires_at: ISODateTime;
  scope: string;
  account_email: string | null;
  now: ISODateTime;
  /** Preserved across a re-connect so `/api/calendar/connection` keeps reporting the original date. */
  connected_at?: ISODateTime;
}

interface RawRow {
  id?: unknown;
  refresh_token_encrypted?: unknown;
  access_token_encrypted?: unknown;
  expires_at?: unknown;
  scope?: unknown;
  account_email?: unknown;
  connected_at?: unknown;
  updated_at?: unknown;
  revoked_at?: unknown;
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

export class GoogleOauthStore {
  constructor(
    private readonly db: SqlDatabase,
    /** `WEBHOOK_SECRET`. The encryption key is derived from it (see `crypto.ts`). */
    private readonly secret: string,
  ) {}

  /**
   * Null when there is no row, or when the refresh token cannot be decrypted —
   * a token encrypted under a rotated secret is unusable, and pretending
   * otherwise would produce a "connected" state that can never call Google.
   */
  async read(): Promise<GoogleConnection | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM google_oauth WHERE id = ?`)
      .bind(FOUNDER_ROW_ID)
      .first<RawRow>();
    if (!row) return null;

    const encryptedRefresh = text(row.refresh_token_encrypted);
    if (!encryptedRefresh) return null;
    const refreshToken = await decryptSecret(encryptedRefresh, this.secret);
    if (!refreshToken) {
      console.warn(JSON.stringify({ msg: "google_oauth_undecryptable", hint: "WEBHOOK_SECRET rotated? reconnect required" }));
      return null;
    }

    const encryptedAccess = text(row.access_token_encrypted);
    const accessToken = encryptedAccess ? await decryptSecret(encryptedAccess, this.secret) : null;
    const scope = text(row.scope);
    const connectedAt = text(row.connected_at) ?? text(row.updated_at) ?? "";

    return {
      refresh_token: refreshToken,
      access_token: accessToken,
      expires_at: text(row.expires_at),
      scopes: scope ? scope.split(/\s+/).filter(Boolean) : [],
      account_email: text(row.account_email),
      connected_at: connectedAt,
      updated_at: text(row.updated_at) ?? connectedAt,
      revoked_at: text(row.revoked_at),
    };
  }

  /** Full-row upsert: the connection is one row, so there is one write shape. Clears `revoked_at`. */
  async save(input: SaveConnectionInput): Promise<void> {
    await this.write({
      refresh_token: input.refresh_token,
      access_token: input.access_token,
      expires_at: input.expires_at,
      scope: input.scope,
      account_email: input.account_email,
      connected_at: input.connected_at ?? input.now,
      updated_at: input.now,
      revoked_at: null,
    });
  }

  /** After a refresh: the new access token and its expiry, nothing else. */
  async saveAccessToken(accessToken: string, expiresAt: ISODateTime, now: ISODateTime): Promise<void> {
    const current = await this.read();
    if (!current) return;
    await this.write({
      refresh_token: current.refresh_token,
      access_token: accessToken,
      expires_at: expiresAt,
      scope: current.scopes.join(" "),
      account_email: current.account_email,
      connected_at: current.connected_at,
      updated_at: now,
      revoked_at: current.revoked_at,
    });
  }

  /**
   * Google rejected the refresh token. The row is kept (so `/api/calendar/connection`
   * can say "reconnect" rather than "never connected") but stops being usable.
   */
  async markRevoked(now: ISODateTime): Promise<void> {
    const current = await this.read();
    if (!current) return;
    await this.write({
      refresh_token: current.refresh_token,
      access_token: null,
      expires_at: null,
      scope: current.scopes.join(" "),
      account_email: current.account_email,
      connected_at: current.connected_at,
      updated_at: now,
      revoked_at: now,
    });
  }

  async delete(): Promise<void> {
    await this.db.prepare("DELETE FROM google_oauth WHERE id = ?").bind(FOUNDER_ROW_ID).run();
  }

  private async write(fields: {
    refresh_token: string;
    access_token: string | null;
    expires_at: ISODateTime | null;
    scope: string;
    account_email: string | null;
    connected_at: ISODateTime;
    updated_at: ISODateTime;
    revoked_at: ISODateTime | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO google_oauth (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
          "ON CONFLICT(id) DO UPDATE SET refresh_token_encrypted = excluded.refresh_token_encrypted, " +
          "access_token_encrypted = excluded.access_token_encrypted, expires_at = excluded.expires_at, scope = excluded.scope, " +
          "account_email = excluded.account_email, connected_at = excluded.connected_at, updated_at = excluded.updated_at, " +
          "revoked_at = excluded.revoked_at",
      )
      .bind(
        FOUNDER_ROW_ID,
        await encryptSecret(fields.refresh_token, this.secret),
        fields.access_token ? await encryptSecret(fields.access_token, this.secret) : null,
        fields.expires_at,
        fields.scope,
        fields.account_email,
        fields.connected_at,
        fields.updated_at,
        fields.revoked_at,
      )
      .run();
  }
}
