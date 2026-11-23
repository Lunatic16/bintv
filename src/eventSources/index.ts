/**
 * Event and Channel Feed Importers.
 *
 * Supports:
 * 1. BinTV Public API (https://api.bintv.link/api/public/bintvjson) which ingests
 *    both 24/7 channels and live/upcoming events with iframe embeds.
 * 2. Generic JSON feeds matching the EventItem structure.
 *
 * Polled periodically in the background (configurable via settings or EVENT_FEED_URL).
 * Preserves manual channels and events (items without feedKey are never deleted).
 */
import { Channel, EventItem } from '../types';
import { BINTV_PUBLIC_API_URL, fetchBinTvData } from './bintvApi';

export * from './bintvApi';

export interface EventFeedAdapter {
  readonly name: string;
  fetchEvents(): Promise<EventItem[]>;
}

/** Raw feed shape the built-in generic JSON adapter understands. */
export interface JsonFeedEvent {
  id?: string;
  key?: string;
  title: string;
  category: string;
  league?: string;
  startTime: string;
  endTime?: string;
  durationMinutes?: number;
  sources?: Array<{ label?: string; url: string }>;
  sourceUrl?: string;
  logo?: string;
  poster?: string;
  homeTeam?: string;
  awayTeam?: string;
  headers?: { referer?: string; userAgent?: string };
}

/**
 * Adapter for the BinTV Public API.
 */
export class BinTvFeedAdapter implements EventFeedAdapter {
  readonly name = 'bintv-api';
  constructor(private url: string = BINTV_PUBLIC_API_URL) {}

  async fetchEvents(): Promise<EventItem[]> {
    const data = await fetchBinTvData(this.url);
    return data.events;
  }

  async fetchData(): Promise<{ channels: Channel[]; events: EventItem[] }> {
    return fetchBinTvData(this.url);
  }
}

/**
 * Adapter for generic JSON event feeds over HTTP.
 */
export class JsonFeedAdapter implements EventFeedAdapter {
  readonly name = 'json-feed';
  constructor(private url: string) {
    if (!/^https?:\/\//i.test(this.url)) {
      throw new Error('eventFeedUrl must be an http(s) URL');
    }
  }

  async fetchEvents(): Promise<EventItem[]> {
    const res = await fetch(this.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const data: unknown = await res.json();
    let arr: JsonFeedEvent[] | undefined;
    if (Array.isArray(data)) arr = data as JsonFeedEvent[];
    else if (data && typeof data === 'object' && Array.isArray((data as { events?: unknown }).events)) {
      arr = (data as { events: JsonFeedEvent[] }).events;
    }
    if (!arr) throw new Error('feed must be a JSON array or {events: []}');
    return arr.filter((e) => e && e.title && e.startTime).map((e) => this.toEvent(e));
  }

  private toEvent(e: JsonFeedEvent): EventItem {
    const sources = (e.sources && e.sources.length ? e.sources : e.sourceUrl ? [{ url: e.sourceUrl }] : [])
      .filter((s) => s && s.url)
      .map((s, i) => ({ label: s.label || `Source ${i + 1}`, url: s.url }));
    const key = e.key || e.id || `${e.title}@${e.startTime}`;
    return {
      id: `feed-${hashKey(key)}`,
      title: e.title,
      category: e.category || 'Events',
      league: e.league,
      startTime: new Date(e.startTime).toISOString(),
      endTime: e.endTime ? new Date(e.endTime).toISOString() : undefined,
      durationMinutes: e.durationMinutes,
      sources,
      logo: e.logo,
      poster: e.poster,
      homeTeam: e.homeTeam,
      awayTeam: e.awayTeam,
      headers: e.headers,
      enabled: true,
      feedKey: key
    };
  }
}

function hashKey(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function createAdapter(feedUrl: string | undefined): EventFeedAdapter | null {
  if (!feedUrl) return null;
  try {
    if (isBinTvApiUrl(feedUrl)) {
      return new BinTvFeedAdapter(feedUrl);
    }
    return new JsonFeedAdapter(feedUrl);
  } catch (err) {
    console.error('[eventSources] invalid feed URL:', err);
    return null;
  }
}

export function isBinTvApiUrl(url: string): boolean {
  return /bintvjson|api\.bintv\.link|bintv\.cc/i.test(url);
}

export interface SyncFeedResult {
  channels: Channel[];
  events: EventItem[];
  importedChannels: number;
  importedEvents: number;
  error?: string;
}

/**
 * Synchronizes feed data from the configured feed URL into current channels and events.
 * Handles both the BinTV API (channels + events) and generic JSON feeds (events only).
 * Manual items (without feedKey) are always preserved.
 */
export async function syncFeedData(
  feedUrl: string,
  currentChannels: Channel[],
  currentEvents: EventItem[]
): Promise<SyncFeedResult> {
  try {
    if (isBinTvApiUrl(feedUrl)) {
      const adapter = new BinTvFeedAdapter(feedUrl);
      const { channels: fetchedChannels, events: fetchedEvents } = await adapter.fetchData();

      // Upsert channels: preserve manual channels (without feedKey)
      const manualChannels = currentChannels.filter((c) => !c.feedKey);
      const manualNumbers = new Set(manualChannels.map((c) => c.number));

      // Re-number feed channels so they don't collide with manual channels
      let nextNumber = 1;
      const assignedChannels: Channel[] = [];
      for (const fc of fetchedChannels) {
        while (manualNumbers.has(nextNumber)) {
          nextNumber++;
        }
        assignedChannels.push({
          ...fc,
          number: nextNumber++
        });
      }

      const mergedChannels = [...manualChannels, ...assignedChannels];

      // Upsert events: preserve manual events (without feedKey)
      const manualEvents = currentEvents.filter((e) => !e.feedKey);
      const byKey = new Map<string, EventItem>();
      for (const e of fetchedEvents) {
        if (e.feedKey) byKey.set(e.feedKey, e);
      }
      const mergedEvents = [...manualEvents, ...byKey.values()];

      return {
        channels: mergedChannels,
        events: mergedEvents,
        importedChannels: assignedChannels.length,
        importedEvents: byKey.size
      };
    } else {
      // Generic JSON feed (events only)
      const adapter = new JsonFeedAdapter(feedUrl);
      const fetched = await adapter.fetchEvents();
      const manualEvents = currentEvents.filter((e) => !e.feedKey);
      const byKey = new Map<string, EventItem>();
      for (const e of fetched) {
        if (e.feedKey) byKey.set(e.feedKey, e);
      }
      const mergedEvents = [...manualEvents, ...byKey.values()];

      return {
        channels: currentChannels,
        events: mergedEvents,
        importedChannels: 0,
        importedEvents: byKey.size
      };
    }
  } catch (err) {
    return {
      channels: currentChannels,
      events: currentEvents,
      importedChannels: 0,
      importedEvents: 0,
      error: String(err)
    };
  }
}

/** Legacy helper: runs one feed poll for events only. */
export async function runFeedPoll(
  adapter: EventFeedAdapter,
  currentEvents: EventItem[]
): Promise<{ events: EventItem[]; imported: number; error?: string }> {
  try {
    const fetched = await adapter.fetchEvents();
    const manual = currentEvents.filter((e) => !e.feedKey);
    const byKey = new Map<string, EventItem>();
    for (const e of fetched) byKey.set(e.feedKey!, e);
    const imported = [...byKey.values()];
    return { events: [...manual, ...imported], imported: imported.length };
  } catch (err) {
    return { events: currentEvents, imported: 0, error: String(err) };
  }
}
