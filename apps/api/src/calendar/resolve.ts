/**
 * Which calendar Canary is looking at: **Google > ICS > none**.
 *
 * Google wins when the founder has connected it (a live `google_oauth` row) and
 * the Worker has the OAuth client credentials. Otherwise the private iCal feed
 * still answers the only question the alert policy asks — is the founder in a
 * meeting — and with neither, Canary has no availability signal and never defers.
 *
 * The choice needs a D1 read, and `buildVariables` is synchronous, so the feed
 * handed to routes is a thin lazy shell: it resolves once, on its first call,
 * and every method then delegates. Nothing changes for a route that only wanted
 * `isBusyAt`.
 */
import type { ISODate, ISODateTime } from "@canary/shared";
import type { SqlDatabase } from "../data/d1.ts";
import type { Env } from "../env.ts";
import type { FetchLike } from "../sendblue/client.ts";
import { GoogleCalendarProvider } from "./google/provider.ts";
import { GoogleOauthStore } from "./google/store.ts";
import { calendarFor, NO_CALENDAR, type BusyStatus, type CalendarFeed, type CalendarFeedResult } from "./ics.ts";

export type CalendarProviderName = "google" | "ics" | "none";

/** Exactly the `/api/calendar/connection` body: no tokens, no feed URL, no secrets. */
export interface CalendarConnectionInfo {
  provider: CalendarProviderName;
  account_email?: string;
  connected_at?: ISODateTime;
  scopes?: string[];
  /** Set when Google rejected the refresh token — the operator has to reconnect. */
  revoked_at?: ISODateTime;
}

export interface CalendarResolution {
  provider: CalendarProviderName;
  feed: CalendarFeed;
  /** Non-null only when `provider === "google"`. The write path (booking a review) needs it. */
  google: GoogleCalendarProvider | null;
  connection: CalendarConnectionInfo;
}

export interface CalendarResolverConfig {
  appEnv: Env;
  db?: SqlDatabase | undefined;
  fetchImpl?: FetchLike | undefined;
  now: () => string;
}

export interface CalendarResolver {
  /** The `CalendarFeed` every existing route uses. */
  readonly feed: CalendarFeed;
  /**
   * Accessor for the `google_oauth` row — the OAuth routes need it before a
   * connection exists, so it is not behind `resolve()`. Null when D1 or
   * `WEBHOOK_SECRET` is missing (the row could be neither read nor decrypted).
   */
  readonly oauthStore: GoogleOauthStore | null;
  resolve(): Promise<CalendarResolution>;
}

/**
 * The store, or null when a Google connection could not exist at all: no D1 to
 * read, no `WEBHOOK_SECRET` to decrypt with, or no OAuth client to use it.
 */
export function googleOauthStoreFor(appEnv: Env, db?: SqlDatabase): GoogleOauthStore | null {
  const secret = appEnv.WEBHOOK_SECRET?.trim();
  const clientId = appEnv.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = appEnv.GOOGLE_CLIENT_SECRET?.trim();
  if (!db || !secret || !clientId || !clientSecret) return null;
  return new GoogleOauthStore(db, secret);
}

/** True when a Google connection could exist — used to decide whether to even read D1. */
export function googleConfigured(appEnv: Env, db?: SqlDatabase): boolean {
  return googleOauthStoreFor(appEnv, db) !== null;
}

function icsResolution(config: CalendarResolverConfig): CalendarResolution {
  const feed = calendarFor({
    url: config.appEnv.CALENDAR_ICS_URL,
    now: config.now,
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
  });
  const provider: CalendarProviderName = feed === NO_CALENDAR ? "none" : "ics";
  return { provider, feed, google: null, connection: { provider } };
}

class LazyFounderCalendar implements CalendarFeed {
  private pending: Promise<CalendarResolution> | null = null;
  readonly oauthStore: GoogleOauthStore | null;

  constructor(private readonly config: CalendarResolverConfig) {
    this.oauthStore = googleOauthStoreFor(config.appEnv, config.db);
  }

  get configured(): boolean {
    return this.oauthStore !== null || Boolean(this.config.appEnv.CALENDAR_ICS_URL?.trim());
  }

  /** Memoized for the life of this object — one D1 read per request, not one per route helper. */
  resolve(): Promise<CalendarResolution> {
    this.pending ??= this.resolveOnce();
    return this.pending;
  }

  private async resolveOnce(): Promise<CalendarResolution> {
    const store = this.oauthStore;
    if (!store) return icsResolution(this.config);

    let connection: Awaited<ReturnType<GoogleOauthStore["read"]>> = null;
    try {
      connection = await store.read();
    } catch (err) {
      // Most likely migration 0005 has not been applied. Falling back beats a 500
      // on `/api/availability`, which every alert decision depends on.
      console.warn(JSON.stringify({ msg: "google_oauth_read_failed", error: err instanceof Error ? err.message : String(err) }));
      return icsResolution(this.config);
    }

    if (!connection) return icsResolution(this.config);
    if (connection.revoked_at) {
      const fallback = icsResolution(this.config);
      return {
        ...fallback,
        connection: {
          ...fallback.connection,
          ...(connection.account_email ? { account_email: connection.account_email } : {}),
          revoked_at: connection.revoked_at,
        },
      };
    }

    const google = new GoogleCalendarProvider({
      store,
      env: this.config.appEnv,
      fetchImpl: this.config.fetchImpl ?? ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => fetch(input, init)),
      now: this.config.now,
    });

    return {
      provider: "google",
      feed: google,
      google,
      connection: {
        provider: "google",
        ...(connection.account_email ? { account_email: connection.account_email } : {}),
        connected_at: connection.connected_at,
        scopes: connection.scopes,
      },
    };
  }

  async fetchEvents(from: ISODate, to: ISODate): Promise<CalendarFeedResult> {
    return (await this.resolve()).feed.fetchEvents(from, to);
  }

  async isBusyAt(now: ISODateTime): Promise<BusyStatus> {
    return (await this.resolve()).feed.isBusyAt(now);
  }
}

export function createCalendarResolver(config: CalendarResolverConfig): CalendarResolver {
  const feed = new LazyFounderCalendar(config);
  return { feed, oauthStore: feed.oauthStore, resolve: () => feed.resolve() };
}
