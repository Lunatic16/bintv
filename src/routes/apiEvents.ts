/**
 * REST API for events. Status is COMPUTED at request time, never stored.
 *   GET    /api/events            (?status=, ?category=, ?q=, computed status included)
 *   POST   /api/events
 *   PUT    /api/events/:id
 *   DELETE /api/events/:id
 *   POST   /api/events/:id/duplicate
 *   POST   /api/events/:id/start-now
 *   POST   /api/events/:id/end-now
 *   POST   /api/events/import
 *   GET    /api/events/export.json
 */
import { Request, Response, Router } from 'express';
import { DATA_DIR, loadSettings, validTimezone } from '../config';
import { loadJson, saveJson, slugify, uniqueSlug } from '../storage';
import { EventItem, EventSource, StatusInfo } from '../types';
import { computeStatus, passesStatusFilter, resolveStartMs, resolveEndMs } from '../eventStatus';
import { parseM3u } from '../m3uImport';
import { requireAdmin } from '../auth';

const router = Router();
const FILE = `${DATA_DIR}/events.json`;

const readAll = (): EventItem[] => loadJson<EventItem[]>(FILE, [], 'events');
const writeAll = (events: EventItem[]): void => saveJson(FILE, events, 'events');

/** Public event shape: stored fields + computed status. */
export interface EventWithStatus extends EventItem {
  computed: StatusInfo;
}

function withStatus(ev: EventItem, settings = loadSettings()): EventWithStatus {
  return { ...ev, computed: computeStatus(ev, Date.now(), settings) };
}

interface NormalizedEvent {
  title: string; category: string; league?: string; startTime: string;
  endTime?: string; durationMinutes?: number; sources: EventSource[];
  logo?: string; poster?: string; homeTeam?: string; awayTeam?: string;
  headers?: EventItem['headers']; enabled: boolean;
}

/** Validates & normalizes an event payload. Throws Error with a clear message. */
function normalizeEvent(body: Record<string, unknown>, partial: boolean, existing?: EventItem): NormalizedEvent {
  const errors: string[] = [];
  const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '') ? undefined : String(v).trim();

  const title = body.title !== undefined ? str(body.title) : existing?.title;
  if (!title) errors.push('title is required');

  const category = body.category !== undefined ? str(body.category) : existing?.category;
  if (!category) errors.push('category is required');

  const startRaw = body.startTime !== undefined ? str(body.startTime) : existing?.startTime;
  if (!startRaw) errors.push('startTime is required (ISO 8601)');
  const startMs = startRaw ? Date.parse(startRaw) : NaN;
  if (Number.isNaN(startMs)) errors.push(`startTime '${startRaw}' is not a valid ISO 8601 date`);

  const endRaw = body.endTime !== undefined ? str(body.endTime) : existing?.endTime;
  const duration = body.durationMinutes !== undefined ? Number(body.durationMinutes) : existing?.durationMinutes;
  const endMs = endRaw ? Date.parse(endRaw) : NaN;
  if (endRaw && Number.isNaN(endMs)) errors.push(`endTime '${endRaw}' is not a valid ISO 8601 date`);

  if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs < startMs) {
    errors.push('endTime is before startTime');
  }

  let sources: EventSource[] | undefined;
  if (body.sources !== undefined || !partial) {
    const rawSources = (body.sources ?? existing?.sources) as Array<{ label?: string; url?: string }> | undefined;
    if (!Array.isArray(rawSources) || rawSources.length === 0) {
      errors.push('at least one source with a url is required');
    } else {
      sources = [];
      rawSources.forEach((s, i) => {
        const url = str(s?.url);
        if (!url || !/^https?:\/\//i.test(url)) errors.push(`sources[${i}].url must be an http(s) URL`);
        sources!.push({ label: str(s?.label) || `Source ${i + 1}`, url: url! });
      });
    }
  }

  if (errors.length) throw new Error(errors.join('; '));

  const normalized: NormalizedEvent = {
    title: title!,
    category: category!,
    league: body.league !== undefined ? str(body.league) : existing?.league,
    startTime: startRaw!,
    endTime: endRaw,
    durationMinutes: Number.isFinite(duration) && (duration as number) > 0 ? duration : undefined,
    sources: (sources ?? existing?.sources)!,
    logo: body.logo !== undefined ? str(body.logo) : existing?.logo,
    poster: body.poster !== undefined ? str(body.poster) : existing?.poster,
    homeTeam: body.homeTeam !== undefined ? str(body.homeTeam) : existing?.homeTeam,
    awayTeam: body.awayTeam !== undefined ? str(body.awayTeam) : existing?.awayTeam,
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing?.enabled ?? true
  };
  const headers = (body.headers ?? existing?.headers) as EventItem['headers'] | undefined;
  if (headers && (headers.referer || headers.userAgent)) {
    normalized.headers = { referer: headers.referer || undefined, userAgent: headers.userAgent || undefined };
  }
  return normalized;
}

/** GET /api/events — computed status included; ?status=live|upcoming|ended|all, ?category=, ?q= */
router.get('/api/events', (req: Request, res: Response) => {
  const settings = loadSettings();
  const now = Date.now();
  let events = readAll().filter((e) => e.enabled).map((e) => withStatus(e, settings));

  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status && status !== 'all') {
    if (status === 'default') {
      events = events.filter((info) => passesStatusFilter(info.computed, { lookaheadHours: 6, nowMs: now }));
    } else {
      events = events.filter((e) => e.computed.status === status);
    }
  } else if (!status) {
    // Default API view: hide ended entirely (viewer-facing).
    events = events.filter((e) => e.computed.status !== 'ended');
  }

  const categories = typeof req.query.category === 'string' && req.query.category.trim()
    ? new Set(req.query.category.split(',').map((c) => c.trim().toLowerCase()))
    : null;
  if (categories) events = events.filter((e) => categories.has(e.category.toLowerCase()));

  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  if (q) {
    events = events.filter((e) =>
      e.title.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      (e.league || '').toLowerCase().includes(q) ||
      `${e.homeTeam || ''} ${e.awayTeam || ''}`.toLowerCase().includes(q)
    );
  }

  res.json(events);
});

/** POST /api/events */
router.post('/api/events', requireAdmin(loadSettings), (req: Request, res: Response) => {
  try {
    const data = normalizeEvent(req.body as Record<string, unknown>, false);
    const events = readAll();
    const existing = new Set(events.map((e) => e.id));
    const id = uniqueSlug(slugify(String(req.body.id || data.title)), existing);
    const event: EventItem = {
      id, ...data,
      startTime: new Date(data.startTime).toISOString(),
      endTime: data.endTime ? new Date(data.endTime).toISOString() : undefined
    };
    events.push(event);
    writeAll(events);
    res.status(201).json(withStatus(event));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid payload' });
  }
});

/** PUT /api/events/:id */
router.put('/api/events/:id', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: `Event '${req.params.id}' not found` }); return; }
  try {
    const data = normalizeEvent(req.body as Record<string, unknown>, true, events[idx]);
    events[idx] = {
      ...events[idx],
      ...data,
      startTime: new Date(data.startTime).toISOString(),
      endTime: data.endTime ? new Date(data.endTime).toISOString() : undefined,
      id: events[idx].id
    };
    writeAll(events);
    res.json(withStatus(events[idx]));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid payload' });
  }
});

/** DELETE /api/events/:id */
router.delete('/api/events/:id', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: `Event '${req.params.id}' not found` }); return; }
  const [removed] = events.splice(idx, 1);
  writeAll(events);
  res.json({ ok: true, removed });
});

/** POST /api/events/:id/duplicate */
router.post('/api/events/:id/duplicate', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: `Event '${req.params.id}' not found` }); return; }
  const src = events[idx];
  const existing = new Set(events.map((e) => e.id));
  const id = uniqueSlug(slugify(`${src.title}-copy`), existing);
  const copy: EventItem = { ...src, id, feedKey: undefined, title: `${src.title} (copy)` };
  events.push(copy);
  writeAll(events);
  res.status(201).json(withStatus(copy));
});

/** POST /api/events/:id/start-now — shifts startTime (and endTime) so the event is live immediately. */
router.post('/api/events/:id/start-now', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: `Event '${req.params.id}' not found` }); return; }
  const ev = events[idx];
  const now = Date.now();
  const end = resolveEndMs(ev);
  const duration = Math.max(1, end - resolveStartMs(ev));
  ev.startTime = new Date(now).toISOString();
  ev.endTime = new Date(now + duration).toISOString();
  ev.durationMinutes = undefined;
  writeAll(events);
  res.json(withStatus(ev));
});

/** POST /api/events/:id/end-now — sets endTime to now (event leaves "live" after the grace window). */
router.post('/api/events/:id/end-now', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: `Event '${req.params.id}' not found` }); return; }
  const ev = events[idx];
  const now = Date.now();
  if (resolveStartMs(ev) > now) ev.startTime = new Date(now - 60_000).toISOString();
  ev.endTime = new Date(now).toISOString();
  ev.durationMinutes = undefined;
  writeAll(events);
  res.json(withStatus(ev));
});

/** POST /api/events/import — paste M3U; optional startTime/durationMinutes applied to all entries. */
router.post('/api/events/import', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const { m3u, category, startTime, durationMinutes } = req.body as {
    m3u?: string; category?: string; startTime?: string; durationMinutes?: number;
  };
  if (!m3u || !m3u.trim()) { res.status(400).json({ error: 'Body must include {"m3u": "..."}' }); return; }
  let startMs: number | null = null;
  if (startTime) {
    startMs = Date.parse(startTime);
    if (Number.isNaN(startMs)) { res.status(400).json({ error: `startTime '${startTime}' is not a valid ISO 8601 date` }); return; }
  }
  const parsed = parseM3u(m3u);
  if (parsed.length === 0) { res.status(400).json({ error: 'No entries found in the pasted M3U' }); return; }
  const events = readAll();
  const existing = new Set(events.map((e) => e.id));
  let imported = 0;
  for (const entry of parsed) {
    const id = uniqueSlug(slugify(entry.name), existing);
    existing.add(id);
    events.push({
      id,
      title: entry.name,
      category: category || entry.group || 'Events',
      startTime: new Date(startMs ?? Date.now()).toISOString(),
      durationMinutes: Number(durationMinutes) > 0 ? Number(durationMinutes) : 120,
      sources: [{ label: 'Source 1', url: entry.url }],
      logo: entry.logo,
      enabled: true
    });
    imported += 1;
  }
  writeAll(events);
  res.status(201).json({ ok: true, imported, total: events.length });
});

router.get('/api/events/export.json', (_req: Request, res: Response) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="bintv-events.json"');
  res.send(JSON.stringify(readAll(), null, 2));
});

export default router;
