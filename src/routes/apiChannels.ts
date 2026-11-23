/**
 * REST API for 24/7 channels.
 *   GET    /api/channels
 *   POST   /api/channels
 *   PUT    /api/channels/:id
 *   DELETE /api/channels/:id
 *   POST   /api/channels/reorder
 *   POST   /api/channels/import          (paste M3U)
 *   GET    /api/channels/export.json
 */
import { Request, Response, Router } from 'express';
import { DATA_DIR } from '../config';
import { loadJson, saveJson, slugify, uniqueSlug } from '../storage';
import { Channel } from '../types';
import { parseM3u } from '../m3uImport';
import { requireAdmin } from '../auth';
import { loadSettings } from '../config';

const router = Router();
const FILE = `${DATA_DIR}/channels.json`;

const readAll = (): Channel[] => loadJson<Channel[]>(FILE, [], 'channels');
const writeAll = (channels: Channel[]): void => saveJson(FILE, channels, 'channels');

/** Validates & normalizes a channel payload; returns errors via throw. */
function validateChannel(body: Partial<Channel>): Partial<Channel> {
  const errors: string[] = [];
  if (body.name !== undefined && !String(body.name).trim()) errors.push('name must not be empty');
  if (body.streamUrl !== undefined && !/^https?:\/\//i.test(String(body.streamUrl))) errors.push('streamUrl must be an http(s) URL');
  if (errors.length) throw new ValidationError(errors.join('; '));
  const out: Partial<Channel> = {};
  if (body.name !== undefined) out.name = String(body.name).trim();
  if (body.streamUrl !== undefined) out.streamUrl = String(body.streamUrl).trim();
  if (body.number !== undefined) out.number = Number(body.number) || 0;
  if (body.logo !== undefined) out.logo = body.logo ? String(body.logo) : undefined;
  if (body.group !== undefined) out.group = String(body.group || 'General').trim() || 'General';
  if (body.tvgId !== undefined) out.tvgId = body.tvgId ? String(body.tvgId) : undefined;
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
  if (body.headers !== undefined) {
    out.headers = body.headers?.referer || body.headers?.userAgent
      ? { referer: body.headers.referer || undefined, userAgent: body.headers.userAgent || undefined }
      : undefined;
  }
  return out;
}

export class ValidationError extends Error {}

router.get('/api/channels', (_req: Request, res: Response) => {
  res.json(readAll());
});

router.post('/api/channels', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const channels = readAll();
  const data = validateChannel(req.body as Partial<Channel>);
  if (!data.name || !data.streamUrl) {
    res.status(400).json({ error: 'name and streamUrl are required' });
    return;
  }
  const existing = new Set(channels.map((c) => c.id));
  const id = uniqueSlug(slugify(String(req.body.id || data.name)), existing);
  const maxNumber = channels.reduce((m, c) => Math.max(m, c.number || 0), 0);
  const channel: Channel = {
    id,
    number: data.number ?? maxNumber + 1,
    name: data.name,
    streamUrl: data.streamUrl,
    logo: data.logo,
    group: data.group || 'General',
    tvgId: data.tvgId ?? id,
    enabled: data.enabled ?? true,
    headers: data.headers
  };
  channels.push(channel);
  writeAll(channels);
  res.status(201).json(channel);
});

router.put('/api/channels/:id', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const channels = readAll();
  const idx = channels.findIndex((c) => c.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: `Channel '${req.params.id}' not found` }); return; }
  try {
    const data = validateChannel(req.body as Partial<Channel>);
    channels[idx] = { ...channels[idx], ...data, id: channels[idx].id };
    writeAll(channels);
    res.json(channels[idx]);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid payload' });
  }
});

router.delete('/api/channels/:id', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const channels = readAll();
  const idx = channels.findIndex((c) => c.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: `Channel '${req.params.id}' not found` }); return; }
  const [removed] = channels.splice(idx, 1);
  writeAll(channels);
  res.json({ ok: true, removed });
});

/** Body: { order: ["id2","id1",...] } — reorders the whole list. */
router.post('/api/channels/reorder', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const order: unknown = (req.body as { order?: unknown }).order;
  if (!Array.isArray(order) || order.some((x) => typeof x !== 'string')) {
    res.status(400).json({ error: 'Body must be {"order": ["id", ...]}' });
    return;
  }
  const channels = readAll();
  const byId = new Map(channels.map((c) => [c.id, c]));
  const ordered: Channel[] = [];
  for (const id of order as string[]) {
    const ch = byId.get(id);
    if (ch) { ordered.push(ch); byId.delete(id); }
  }
  for (const ch of byId.values()) ordered.push(ch); // keep anything missing from `order` at the end
  ordered.forEach((ch, i) => { ch.number = i + 1; });
  writeAll(ordered);
  res.json(ordered);
});

/** Body: { m3u: "<pasted M3U text>", defaultGroup?: "Movies" } */
router.post('/api/channels/import', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const { m3u, defaultGroup } = req.body as { m3u?: string; defaultGroup?: string };
  if (!m3u || !m3u.trim()) { res.status(400).json({ error: 'Body must include {"m3u": "..."}' }); return; }
  const parsed = parseM3u(m3u);
  if (parsed.length === 0) { res.status(400).json({ error: 'No entries found in the pasted M3U' }); return; }
  const channels = readAll();
  const existing = new Set(channels.map((c) => c.id));
  let nextNumber = channels.reduce((m, c) => Math.max(m, c.number || 0), 0);
  let imported = 0;
  for (const entry of parsed) {
    const id = uniqueSlug(slugify(entry.name), existing);
    existing.add(id);
    nextNumber += 1;
    channels.push({
      id,
      number: entry.tvgChno ?? nextNumber,
      name: entry.name,
      streamUrl: entry.url,
      logo: entry.logo,
      group: entry.group || defaultGroup || 'Imported',
      tvgId: entry.tvgId || id,
      enabled: true
    });
    imported += 1;
  }
  writeAll(channels);
  res.status(201).json({ ok: true, imported, total: channels.length });
});

router.get('/api/channels/export.json', (_req: Request, res: Response) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="bintv-channels.json"');
  res.send(JSON.stringify(readAll(), null, 2));
});

export default router;
