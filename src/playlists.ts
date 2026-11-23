/**
 * M3U playlist generation — pure functions over the current data, unit-tested.
 * Every request regenerates playlists from the JSON files, so edits and the
 * passage of time are reflected immediately with no restart.
 */
import { Channel, EventItem, EventSource, Settings, StatusInfo } from './types';
import { computeStatus, passesStatusFilter } from './eventStatus';

export interface PlaylistEventOptions {
  status?: string;          // live | upcoming | all | default(live+soon)
  hours?: number;           // look-ahead window for upcoming (default 6)
  categories?: string[];    // filter by category
  sourceIndex?: number;     // 1-based; pick Nth source for each event
  timezone: string;         // IANA tz for display names
  nowMs: number;
}

const DEFAULT_LOOKAHEAD_HOURS = 6;

function esc(s: string): string {
  // EXTINF attribute values must not contain double quotes.
  return (s || '').replace(/"/g, "'");
}

/** Formats an epoch-ms timestamp as HH:mm in the given timezone. */
export function formatLocalTime(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/** Stable tvg-id per event so TiviMate keeps entries consistent between refreshes.
 *  Multi-source events get one playlist entry per source; sources beyond the first
 *  carry a -sN suffix so players that de-duplicate channels by tvg-id (TiviMate)
 *  keep every source as its own channel. */
export function eventTvgId(ev: EventItem, sourceIdx?: number): string {
  return sourceIdx && sourceIdx > 1 ? `bintv-event-${ev.id}-s${sourceIdx}` : `bintv-event-${ev.id}`;
}

export function eventDisplayName(ev: EventItem, info: StatusInfo, timezone: string): string {
  const time = formatLocalTime(info.startMs, timezone);
  return info.status === 'live' ? `LIVE | ${ev.title}` : `${time} | ${ev.title}`;
}

export function pickSourceIndices(ev: EventItem, sourceIndex?: number): number[] {
  if (!ev.sources || ev.sources.length === 0) return [];
  if (sourceIndex && sourceIndex >= 1 && sourceIndex <= ev.sources.length) {
    return [sourceIndex]; // 1-based index into the ORIGINAL source list
  }
  return ev.sources.map((_, i) => i + 1);
}

export function generateHeader(urlTvg: string): string {
  // x-tvg-url + url-tvg: different players read different attributes
  // (TiviMate reads url-tvg, some IPTVnator builds read x-tvg-url).
  return `#EXTM3U x-tvg-url="${esc(urlTvg)}" url-tvg="${esc(urlTvg)}"`;
}

export function generateChannelEntry(ch: Channel, streamUrl: string): string {
  const attrs = [
    `tvg-id="${esc(ch.tvgId || ch.id)}"`,
    `tvg-name="${esc(ch.name)}"`,
    `tvg-logo="${esc(ch.logo || '')}"`,
    `tvg-chno="${ch.number}"`,
    `group-title="${esc(ch.group || 'General')}"`
  ].join(' ');
  return `#EXTINF:-1 ${attrs},${esc(ch.name)}\n${streamUrl}`;
}

export function generateEventEntry(ev: EventItem, info: StatusInfo, streamUrl: string, timezone: string, sourceLabelSuffix?: string, sourceIdx?: number): string {
  const displayName = eventDisplayName(ev, info, timezone) + (sourceLabelSuffix || '');
  const attrs = [
    `tvg-id="${esc(eventTvgId(ev, sourceIdx))}"`,
    `tvg-name="${esc(ev.title)}"`,
    `tvg-logo="${esc(ev.logo || ev.poster || '')}"`,
    `group-title="${esc(ev.category || 'Events')}"`
  ].join(' ');
  return `#EXTINF:-1 ${attrs},${esc(displayName)}\n${streamUrl}`;
}

/** Sort comparator: live first, then by start time. */
export function compareEvents(a: { info: StatusInfo }, b: { info: StatusInfo }): number {
  const rank = (s: StatusInfo['status']) => (s === 'live' ? 0 : 1);
  const r = rank(a.info.status) - rank(b.info.status);
  if (r !== 0) return r;
  return a.info.startMs - b.info.startMs;
}

export interface GenerateEventsResult {
  body: string;
  matched: Array<{ ev: EventItem; info: StatusInfo; sourceIdxs: number[] }>;
}

/**
 * Generates the events playlist body (without header) from current data.
 * If nothing matches, callers can fall back to a placeholder entry so IPTV
 * apps never treat the playlist as invalid.
 */
export function generateEventEntries(
  events: EventItem[],
  opts: PlaylistEventOptions,
  settings: Pick<Settings, 'preStartMinutes' | 'postEndGraceMinutes'>,
  urlFor: (ev: EventItem, sourceIdx: number, total: number) => string
): GenerateEventsResult {
  const nowMs = opts.nowMs;
  const categories = opts.categories && opts.categories.length
    ? new Set(opts.categories.map((c) => c.toLowerCase()))
    : null;
  const matched: Array<{ ev: EventItem; info: StatusInfo; sourceIdxs: number[] }> = [];

  for (const ev of events) {
    if (!ev.enabled) continue;
    const info = computeStatus(ev, nowMs, settings);
    if (!passesStatusFilter(info, { status: opts.status, lookaheadHours: opts.hours ?? DEFAULT_LOOKAHEAD_HOURS, nowMs })) continue;
    if (categories && !categories.has((ev.category || '').toLowerCase())) continue;
    const sourceIdxs = pickSourceIndices(ev, opts.sourceIndex);
    if (sourceIdxs.length === 0) continue;
    matched.push({ ev, info, sourceIdxs });
  }
  matched.sort(compareEvents);

  const lines: string[] = [];
  for (const m of matched) {
    m.sourceIdxs.forEach((originalIdx, i) => {
      const src = m.ev.sources[originalIdx - 1];
      const suffix = m.sourceIdxs.length > 1 ? ` [${src.label || `Source ${originalIdx}`}]` : '';
      lines.push(generateEventEntry(m.ev, m.info, urlFor(m.ev, originalIdx, m.sourceIdxs.length), opts.timezone, suffix, originalIdx));
    });
  }
  return { body: lines.join('\n'), matched };
}

export function placeholderEntry(url: string): string {
  return `#EXTINF:-1 tvg-id="bintv-placeholder" tvg-name="No live events" group-title="Events",No live events right now\n${url}`;
}

export function sortChannels(channels: Channel[]): Channel[] {
  return [...channels].sort((a, b) => (a.number - b.number) || a.name.localeCompare(b.name));
}
