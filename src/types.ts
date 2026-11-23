/**
 * Shared domain types for BinTV.
 * All times are stored/processed in UTC (ISO 8601 strings) and converted to
 * a local timezone only at display/playlist-generation time.
 */

/** Optional custom HTTP headers applied when fetching an upstream stream. */
export interface StreamHeaders {
  referer?: string;
  userAgent?: string;
}

/** A 24/7 channel. Always listed while `enabled`. */
export interface Channel {
  id: string;            // slug
  number: number;        // channel number used for sorting / tvg-chno
  name: string;
  streamUrl: string;
  logo?: string;
  group: string;         // Movies, News, Kids, Music, ...
  tvgId?: string;
  enabled: boolean;
  headers?: StreamHeaders;
  feedKey?: string;
}

/** One selectable source of an event (multi-source events are common for live sports). */
export interface EventSource {
  label: string;         // "Source 1", "Source 2", ...
  url: string;
}

export type EventStatus = 'upcoming' | 'live' | 'ended';

/** A live event (sport match, one-off broadcast). Status is COMPUTED, never stored. */
export interface EventItem {
  id: string;
  title: string;
  category: string;          // Football, UFC, NBA, Racing, ...
  league?: string;
  startTime: string;         // ISO 8601 UTC
  endTime?: string;          // ISO 8601 UTC (optional when durationMinutes given)
  durationMinutes?: number;  // used to derive endTime when endTime absent
  sources: EventSource[];
  logo?: string;
  poster?: string;
  homeTeam?: string;
  awayTeam?: string;
  headers?: StreamHeaders;
  enabled: boolean;
  /** Marks events created by the feed importer (never touched by manual upserts). */
  feedKey?: string;
}

/** Runtime-adjustable settings, persisted to data/settings.json. Env vars win. */
export interface Settings {
  preStartMinutes: number;        // event goes "live" this many minutes before start
  postEndGraceMinutes: number;    // stays "live" this many minutes after end
  retentionHours: number;         // ended events pruned after this long
  defaultTimezone: string;        // IANA tz used when ?tz= absent
  eventFeedUrl?: string;          // optional JSON feed (see eventSources/)
  eventFeedIntervalMinutes: number; // 0 = off
}

/** Effective settings after merging defaults <- settings.json <- env vars. */
export interface ResolvedSettings extends Settings {
  playlistToken?: string;   // env only, never persisted
  adminToken?: string;      // env only, never persisted
}

export interface StatusInfo {
  status: EventStatus;
  startMs: number;
  endMs: number;
  liveFromMs: number;  // start - preStart
  liveUntilMs: number; // end + grace
}
