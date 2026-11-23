/**
 * Adapter and helpers for the BinTV Public API (https://api.bintv.link/api/public/bintvjson).
 * Ingests 24/7 channels, Live events, and Upcoming events with embeds from bintv.cc.
 */
import { Channel, EventItem, EventSource } from '../types';

export const BINTV_PUBLIC_API_URL = 'https://api.bintv.link/api/public/bintvjson';

export interface RawBinTvStream {
  Name?: string;
  Iframe?: string;
  url?: string;
}

export interface RawBinTvItem {
  ID: string;
  Name: string;
  Poster?: string | null;
  Category?: string | null;
  Date?: string | number | null;
  Status?: string | null;
  Streams?: RawBinTvStream[];
  Viewers?: number | string | null;
}

export interface RawBinTvResponse {
  'Live Events'?: RawBinTvItem[];
  'Upcoming Events'?: RawBinTvItem[];
  '24/7 Channels'?: RawBinTvItem[];
}

const FEED_POSTER_CATS: Record<string, string> = {
  nba: 'NBA',
  nhl: 'Hockey',
  nfl: 'American Football',
  mlb: 'Baseball',
  cfb: 'College Football',
  cbb: 'College Basketball',
  mls: 'Soccer',
  epl: 'Soccer'
};

/**
 * Guesses or refines event category based on poster filename or event title keywords.
 */
export function guessCategory(name: string, poster?: string | null): string {
  if (poster) {
    const m = String(poster).match(/\/([a-z]+)-\d+\.\w+(?:\?|$)/i);
    if (m && FEED_POSTER_CATS[m[1].toLowerCase()]) {
      return FEED_POSTER_CATS[m[1].toLowerCase()];
    }
  }
  const n = String(name || '');
  if (/\b(ufc|mma|one fight night|boxing|bellator|wwe|aew)\b/i.test(n)) return 'MMA / Boxing';
  if (/\b(cricket|t20|odi|ipl|icc|big bash|test)\b/i.test(n)) return 'Cricket';
  if (/\b(dirt track|nascar|formula|f1|grand prix|motogp|racing|indycar)\b/i.test(n)) return 'Motorsport';
  if (/\b(nfl|american football|football league|chiefs|bills|patriots|packers|cowboys|eagles|49ers|steelers|dolphins|chargers|raiders|broncos|giants|jaguars|ravens|bengals|browns|texans|colts|titans|vikings|bears|lions|saints|buccaneers|falcons|panthers|cardinals|rams|seahawks)\b/i.test(n)) return 'American Football';
  if (/\b(nba|basketball|wnba|euroleague|celtics|lakers|warriors|bulls|heat|nuggets|knicks|nets|sixers|76ers|bucks|cavaliers|pacers|pistons|raptors|hawks|hornets|magic|wizards|timberwolves|thunder|blazers|jazz|suns|kings|clippers|mavericks|rockets|grizzlies|pelicans|spurs)\b/i.test(n)) return 'Basketball';
  if (/\b(nhl|hockey|stanley cup|hurricanes|rangers|sabres|lightning|oilers|blues|penguins|stars|blackhawks|canucks|bruins|maple leafs|canadiens|senators|red wings|flames|avalanche|wild|predators|jets|ducks|sharks|kraken|golden knights)\b/i.test(n)) return 'Hockey';
  if (/\b(soccer|football|fc|cf|premier league|la liga|serie a|bundesliga|champions league|mls|arsenal|chelsea|liverpool|manchester|tottenham|everton|newcastle|barcelona|real madrid|atletico|juventus|milan|inter|bayern|dortmund|psg)\b/i.test(n)) return 'Soccer';
  if (/\b(tennis|wimbledon|atp|wta|roland garros|us open)\b/i.test(n)) return 'Tennis';
  if (/\b(golf|pga|ryder cup|liv golf)\b/i.test(n)) return 'Golf';
  return 'Sports';
}

/**
 * Categorizes 24/7 channels into standard IPTV groups.
 */
export function guessChannelGroup(name: string): string {
  const n = String(name || '').toLowerCase();
  if (
    /\b(sport|sports|espn|fs1|fs2|fox sports|sky sports|tnt sports|bein|nfl|nba|nhl|mlb|golf|tennis|racing|fight|ufc|wwe|tudn|canal\+ sport|super sport|optus|tsn|dazn|willow|cricket|fubo|eurosport|red bull|nbcsn|pac-12|sec network|acc network|big ten|motogp|formula 1|racing|fight pass|deportes|sportsnet)\b/i.test(n)
  ) {
    return 'Sports';
  }
  if (/\b(news|cnn|msnbc|fox news|bbc news|c-span|bloomberg|cnbc|weather|al jazeera|euronews|sky news|cbc news|cbs news|abc news)\b/i.test(n)) {
    return 'News';
  }
  if (/\b(kids|disney|cartoon|nickelodeon|nick|nicktoons|boomerang|cbeebies|pbs kids|junior|family)\b/i.test(n)) {
    return 'Kids';
  }
  if (/\b(cinema|movie|movies|hbo|cinemax|showtime|starz|hallmark|film|flims)\b/i.test(n)) {
    return 'Movies';
  }
  if (/\b(mtv|vh1|music|stingray|bet)\b/i.test(n)) {
    return 'Music';
  }
  if (/\b(documentary|doc|history|national geographic|nat geo|discovery|animal planet|science|smithsonian)\b/i.test(n)) {
    return 'Documentary';
  }
  return 'Entertainment';
}

/**
 * Parses dates from the feed into ISO 8601 strings.
 * Handles patterns like "2026-11-22 18:00 UTC", timestamps, and null dates.
 */
export function parseFeedDate(v: string | number | null | undefined, isLive: boolean): string {
  if (v == null || v === '') {
    // If Live and date is null, event is happening now (anchor 15 mins ago)
    return isLive
      ? new Date(Date.now() - 15 * 60 * 1000).toISOString()
      : new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }
  if (typeof v === 'number') {
    const ms = v < 1e11 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?\s*(?:UTC|GMT|Z)?$/i);
  if (m) {
    const iso = `${m[1]}T${m[2]}:${m[3] || '00'}Z`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return isLive ? new Date(Date.now() - 15 * 60 * 1000).toISOString() : new Date().toISOString();
}

/**
 * Decodes a base64 or base64url string safely.
 */
export function decodeBase64Url(value: string): string | null {
  try {
    const b = value.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b.length % 4)) % 4;
    return Buffer.from(b + '='.repeat(pad), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * If a stream URL is wrapped in bintv-sources.pages.dev?id=..., extracts the underlying target URL.
 * If that target URL is a nodelay player containing a second base64 m3u8, extracts that too.
 */
export function extractUnderlyingStream(url: string): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    const id = u.searchParams.get('id');
    if (id) {
      const dec = decodeBase64Url(id);
      if (dec) {
        if (dec.includes('/nodelay/player/')) {
          const parts = dec.split('/nodelay/player/');
          if (parts[1]) {
            const decInner = decodeBase64Url(parts[1]);
            if (decInner && /^https?:\/\//i.test(decInner)) return decInner;
          }
        }
        if (/^https?:\/\//i.test(dec)) return dec;
      }
    }
  } catch {
    // Return original url if parsing fails
  }
  return url;
}

/**
 * Fetches the BinTV Public API feed and normalizes it into Channel[] and EventItem[].
 */
export async function fetchBinTvData(
  apiUrl = BINTV_PUBLIC_API_URL
): Promise<{ channels: Channel[]; events: EventItem[] }> {
  const res = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'BinTV/1.0 (+https://bintv.cc)',
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(20_000)
  });
  if (!res.ok) {
    throw new Error(`BinTV API HTTP ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as RawBinTvResponse;
  const rawLive = data['Live Events'] || [];
  const rawUpcoming = data['Upcoming Events'] || [];
  const rawChannels = data['24/7 Channels'] || [];

  // Map 24/7 Channels
  const channels: Channel[] = [];
  let channelNum = 1;
  for (const rc of rawChannels) {
    if (!rc || !rc.Name) continue;
    const streams = (rc.Streams || []).filter((s) => s && (s.Iframe || s.url));
    const streamUrl = streams[0]?.Iframe || streams[0]?.url || '';
    if (!streamUrl) continue;

    const group = rc.Category && rc.Category.trim() ? rc.Category.trim() : guessChannelGroup(rc.Name);
    const id = rc.ID || `ch-${slug(rc.Name)}`;

    channels.push({
      id,
      number: channelNum++,
      name: rc.Name,
      streamUrl,
      logo: rc.Poster || undefined,
      group,
      tvgId: id,
      enabled: true,
      feedKey: rc.ID || `bintv-ch-${rc.Name}`,
      headers: {
        referer: 'https://bintv-sources.pages.dev/'
      }
    });
  }

  // Map Events (both Live and Upcoming)
  const events: EventItem[] = [];
  const seenEventKeys = new Set<string>();

  const processEventItem = (item: RawBinTvItem, isLive: boolean): void => {
    if (!item || !item.Name) return;
    const key = item.ID || `ev-${slug(item.Name)}`;
    if (seenEventKeys.has(key)) return;
    seenEventKeys.add(key);

    const streams: EventSource[] = (item.Streams || [])
      .filter((s) => s && (s.Iframe || s.url))
      .map((s, idx) => ({
        label: s.Name || `Source ${idx + 1}`,
        url: s.Iframe || s.url || ''
      }));

    if (!streams.length) return;

    const category = item.Category && item.Category.trim()
      ? item.Category.trim()
      : guessCategory(item.Name, item.Poster);

    const startTime = parseFeedDate(item.Date, isLive);

    events.push({
      id: key,
      title: item.Name,
      category,
      startTime,
      durationMinutes: 150, // Standard 2.5 hour window for sporting events
      sources: streams,
      logo: item.Poster || undefined,
      poster: item.Poster || undefined,
      enabled: true,
      feedKey: item.ID || `bintv-ev-${item.Name}@${startTime}`,
      headers: {
        referer: 'https://bintv-sources.pages.dev/'
      }
    });
  };

  for (const item of rawLive) processEventItem(item, true);
  for (const item of rawUpcoming) processEventItem(item, false);

  return { channels, events };
}

function slug(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
