/**
 * Dynamic playlist routes — regenerated from the JSON files on every request.
 *   GET /playlist/247.m3u
 *   GET /playlist/events.m3u
 *   GET /playlist.m3u            (combined; ?include=247,events)
 *
 * Shared query params: ?proxy=1, ?token=... (checked by middleware), ?tz=IANA/tz.
 * 247 filters:   ?group=Movies,News
 * Event filters: ?status=live|upcoming|all   ?hours=N   ?category=Football,NBA   ?source=2
 */
import { Request, Response, Router } from 'express';
import { loadSettings, DATA_DIR, validTimezone } from '../config';
import { loadJson } from '../storage';
import { Channel, EventItem } from '../types';
import { baseUrlFrom } from '../baseUrl';
import { requirePlaylistToken } from '../auth';
import {
  generateHeader, generateChannelEntry, generateEventEntries, placeholderEntry,
  sortChannels, formatLocalTime
} from '../playlists';
import { computeStatus } from '../eventStatus';

const router = Router();
// Token middleware must only guard the playlist endpoints themselves — this
// router is mounted at "/" and other routes (API etc.) flow through it too.
router.use(/^\/playlist(\.m3u|\/247\.m3u|\/events\.m3u)$/, requirePlaylistToken(loadSettings));

const M3U_HEADERS = {
  'Content-Type': 'audio/x-mpegurl; charset=utf-8',
  'Cache-Control': 'no-cache, no-store'
};

function tzFrom(req: Request): string {
  const requested = typeof req.query.tz === 'string' ? req.query.tz : '';
  if (requested && validTimezone(requested)) return requested;
  return loadSettings().defaultTimezone;
}

function wantsProxy(req: Request): boolean {
  return req.query.proxy === '1' || req.query.proxy === 'true';
}

/**
 * IPTV apps (TiviMate, IPTVnator, ...) fetch stream URLs directly — they cannot
 * set Referer headers, resolve wrapper embeds, or render HTML player pages.
 * Any URL that is an embed wrapper or needs custom headers MUST be served
 * through BinTV's /stream proxy, which resolves it to real HLS. This mirrors
 * what the web viewer already does via streamUrlFor().
 */
function needsProxy(url: string, headers?: { referer?: string; userAgent?: string }): boolean {
  if (headers?.referer || headers?.userAgent) return true;
  if (/\.m3u8(\?|#|$)/i.test(url)) return false; // direct HLS plays anywhere
  return /bintv-sources\.pages\.dev|shoewiki\.click|api\.bintv\.link|bantertalks\.com|\/player\/|\/embed\//i.test(url);
}

function channelStreamUrl(req: Request, ch: Channel): string {
  const base = baseUrlFrom(req);
  if (req.query.proxy === '0') return ch.streamUrl; // explicit escape hatch: raw upstream URLs
  if (wantsProxy(req) || needsProxy(ch.streamUrl, ch.headers)) {
    return `${base}/stream/247/${encodeURIComponent(ch.id)}`;
  }
  return ch.streamUrl;
}

function eventStreamUrl(req: Request, eventId: string, sourceIndex: number): string {
  const base = baseUrlFrom(req);
  if (req.query.proxy === '0') {
    return rawEventSourceUrl(eventId, sourceIndex) || `${base}/`;
  }
  const ev = loadJson<EventItem[]>(`${DATA_DIR}/events.json`, [], 'events')
    .find((e) => e.id === eventId);
  const src = ev?.sources[sourceIndex - 1];
  if (!src) return `${base}/`;
  if (wantsProxy(req) || needsProxy(src.url, ev?.headers)) {
    return `${base}/stream/event/${encodeURIComponent(eventId)}/${sourceIndex}`;
  }
  return src.url;
}

function rawEventSourceUrl(eventId: string, sourceIndex: number): string {
  const events = loadJson<EventItem[]>(`${DATA_DIR}/events.json`, [], 'events');
  const ev = events.find((e) => e.id === eventId);
  const src = ev?.sources[sourceIndex - 1];
  return src ? src.url : '';
}

function csv(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function sendM3u(res: Response, body: string): void {
  res.set(M3U_HEADERS);
  res.send(body);
}

// ------------------------------------------------------------- 24/7 playlist
router.get('/playlist/247.m3u', (req: Request, res: Response) => {
  const channels = loadJson<Channel[]>(`${DATA_DIR}/channels.json`, [], 'channels');
  const groups = csv(req.query.group);
  const wanted = groups ? new Set(groups.map((g) => g.toLowerCase())) : null;
  const lines = sortChannels(channels.filter((c) => c.enabled && (!wanted || wanted.has((c.group || '').toLowerCase()))))
    .map((ch) => generateChannelEntry(ch, channelStreamUrl(req, ch)));
  sendM3u(res, [generateHeader(`${baseUrlFrom(req)}/epg/247.xml`), ...lines].filter(Boolean).join('\n') + '\n');
});

// ------------------------------------------------------------ events playlist
router.get('/playlist/events.m3u', (req: Request, res: Response) => {
  const settings = loadSettings();
  const events = loadJson<EventItem[]>(`${DATA_DIR}/events.json`, [], 'events');
  const timezone = tzFrom(req);
  const sourceParam = Number(req.query.source);

  const result = generateEventEntries(
    events,
    {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      hours: Number.isFinite(Number(req.query.hours)) ? Number(req.query.hours) : undefined,
      categories: csv(req.query.category),
      sourceIndex: Number.isFinite(sourceParam) && sourceParam > 0 ? sourceParam : undefined,
      timezone,
      nowMs: Date.now()
    },
    settings,
    (ev, sourceIdx) => eventStreamUrl(req, ev.id, sourceIdx)
  );

  const lines: string[] = [generateHeader(`${baseUrlFrom(req)}/epg/events.xml`)];
  if (result.body) lines.push(result.body);
  else lines.push(placeholderEntry(`${baseUrlFrom(req)}/`));
  sendM3u(res, lines.join('\n') + '\n');
});

// ----------------------------------------------------------- combined playlist
router.get('/playlist.m3u', (req: Request, res: Response) => {
  const includeParam = typeof req.query.include === 'string' ? req.query.include : '247,events';
  const include = new Set(includeParam.split(',').map((s) => s.trim().toLowerCase()));
  const base = baseUrlFrom(req);
  const settings = loadSettings();
  const lines: string[] = [];
  // Combined playlist -> combined EPG: one url-tvg covering channels + events.
  const epgUrl = include.has('247') && include.has('events')
    ? `${base}/epg.xml`
    : include.has('events') && !include.has('247')
      ? `${base}/epg/events.xml`
      : `${base}/epg/247.xml`;

  if (include.has('247')) {
    const channels = loadJson<Channel[]>(`${DATA_DIR}/channels.json`, [], 'channels');
    lines.push(generateHeader(epgUrl));
    for (const ch of sortChannels(channels.filter((c) => c.enabled))) {
      lines.push(generateChannelEntry(ch, channelStreamUrl(req, ch)));
    }
  }
  if (include.has('events')) {
    const events = loadJson<EventItem[]>(`${DATA_DIR}/events.json`, [], 'events');
    const result = generateEventEntries(
      events,
      {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        hours: Number.isFinite(Number(req.query.hours)) ? Number(req.query.hours) : undefined,
        categories: csv(req.query.category),
        timezone: tzFrom(req),
        nowMs: Date.now()
      },
      settings,
      (ev, sourceIdx) => eventStreamUrl(req, ev.id, sourceIdx)
    );
    if (result.body) lines.push(result.body);
    else if (lines.length <= 1) lines.push(placeholderEntry(`${base}/`));
  }
  sendM3u(res, lines.join('\n') + '\n');
});

export default router;
