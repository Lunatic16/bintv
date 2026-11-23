/**
 * Minimal XMLTV EPG generated on request.
 * - 24/7: rolling "Live 24/7" programme blocks (or per-channel schedule arrays if present).
 * - Events: one programme per event with real start/end times, so TiviMate shows
 *   the event as the current programme and a countdown for upcoming ones.
 */
import { Channel, EventItem, Settings } from './types';
import { computeStatus } from './eventStatus';
import { eventTvgId } from './playlists';

function xmlEsc(s: string | undefined): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmltvTime(ms: number): string {
  // XMLTV time format: YYYYMMDDHHmmss +0000 — note: NO "T" separator.
  // Strict parsers (TiviMate, IPTVnator) reject "20261123T180000 +0000".
  const d = new Date(ms);
  return d.toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, ' +0000');
}

export interface ChannelScheduleSlot {
  start: string;
  end: string;
  title: string;
}

/** Channels may optionally carry a `schedule` array in their JSON. */
function channelSchedule(ch: Channel & { schedule?: ChannelScheduleSlot[] }): string {
  const slots = ch.schedule || [];
  return slots
    .filter((s) => Date.parse(s.start) && Date.parse(s.end) && Date.parse(s.end) > Date.now() - 6 * 3600_000)
    .map((s) =>
      `  <programme start="${xmltvTime(Date.parse(s.start))}" stop="${xmltvTime(Date.parse(s.end))}" channel="${xmlEsc(ch.tvgId || ch.id)}">\n` +
      `    <title lang="en">${xmlEsc(s.title)}</title>\n` +
      `  </programme>`
    )
    .join('\n');
}

export function generateChannelsEpg(channels: Channel[], blockSizeMinutes = 120): string {
  const now = Date.now();
  const block = blockSizeMinutes * 60_000;
  const blockStart = Math.floor(now / block) * block;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="BinTV">'];
  for (const ch of channels) {
    if (!ch.enabled) continue;
    lines.push(`  <channel id="${xmlEsc(ch.tvgId || ch.id)}">`);
    lines.push(`    <display-name>${xmlEsc(ch.name)}</display-name>`);
    if (ch.logo) lines.push(`    <icon src="${xmlEsc(ch.logo)}"/>`);
    lines.push('  </channel>');
    const withSchedule = ch as Channel & { schedule?: ChannelScheduleSlot[] };
    if (withSchedule.schedule && withSchedule.schedule.length) {
      const s = channelSchedule(withSchedule);
      if (s) lines.push(s);
      continue;
    }
    // Rolling "Live 24/7" blocks: 2 already running/next plus the following 4.
    for (let i = -1; i < 5; i++) {
      const start = blockStart + i * block;
      const end = start + block;
      if (end < now) continue;
      lines.push(
        `  <programme start="${xmltvTime(start)}" stop="${xmltvTime(end)}" channel="${xmlEsc(ch.tvgId || ch.id)}">\n` +
        `    <title lang="en">Live 24/7</title>\n` +
        `    <category lang="en">${xmlEsc(ch.group || 'General')}</category>\n` +
        `  </programme>`
      );
    }
  }
  lines.push('</tv>');
  return lines.join('\n');
}

export function generateEventsEpg(events: EventItem[], settings: Pick<Settings, 'preStartMinutes' | 'postEndGraceMinutes'>): string {
  const now = Date.now();
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="BinTV">'];
  for (const ev of events) {
    if (!ev.enabled) continue;
    const info = computeStatus(ev, now, settings);
    if (info.status === 'ended') continue;
    const sourceCount = Math.max(1, ev.sources?.length || 1);
    for (let idx = 1; idx <= sourceCount; idx++) {
      // One channel per playlist entry (multi-source events use -sN tvg-ids).
      const chId = eventTvgId(ev, idx);
      lines.push(`  <channel id="${xmlEsc(chId)}">`);
      const suffix = sourceCount > 1 ? ` [Source ${idx}]` : '';
      lines.push(`    <display-name>${xmlEsc(ev.title)}${xmlEsc(suffix)}</display-name>`);
      if (ev.logo || ev.poster) lines.push(`    <icon src="${xmlEsc(ev.logo || ev.poster)}"/>`);
      lines.push('  </channel>');
      lines.push(
        `  <programme start="${xmltvTime(info.startMs)}" stop="${xmltvTime(info.endMs)}" channel="${xmlEsc(chId)}">\n` +
        `    <title lang="en">${xmlEsc(ev.title)}${info.status === 'live' ? ' [LIVE]' : ''}</title>\n` +
        `    <desc lang="en">${xmlEsc(ev.league ? `${ev.league} — ` : '')}${xmlEsc(ev.category)}</desc>\n` +
        `    <category lang="en">${xmlEsc(ev.category || 'Events')}</category>\n` +
        `  </programme>`
      );
    }
  }
  lines.push('</tv>');
  return lines.join('\n');
}

/**
 * Combined XMLTV (24/7 channels + events) served at /epg.xml and referenced by
 * the combined playlist, so players get a single EPG URL covering everything.
 */
export function generateCombinedEpg(
  channels: Channel[],
  events: EventItem[],
  settings: Pick<Settings, 'preStartMinutes' | 'postEndGraceMinutes'>
): string {
  const body = generateChannelsEpg(channels);
  const evBody = generateEventsEpg(events, settings);
  const strip = (s: string): string[] =>
    s.split('\n').filter((l) => !l.startsWith('<?xml') && l !== '<tv generator-info-name="BinTV">' && l !== '</tv>');
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="BinTV">',
    ...strip(body), ...strip(evBody), '</tv>'].join('\n');
}
