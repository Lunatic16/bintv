/** Settings API: GET/PUT /api/settings (pre-start/grace/retention windows, default timezone, feed). */
import { Request, Response, Router } from 'express';
import { DATA_DIR, DEFAULT_SETTINGS, loadSettings, validTimezone } from '../config';
import { saveJson } from '../storage';
import { Settings } from '../types';
import { requireAdmin } from '../auth';

const router = Router();
const FILE = `${DATA_DIR}/settings.json`;

router.get('/api/settings', (_req: Request, res: Response) => {
  const s = loadSettings();
  // Do not leak tokens to the client; expose booleans instead.
  res.json({
    ...s,
    adminToken: undefined,
    playlistToken: undefined,
    adminTokenSet: Boolean(s.adminToken),
    playlistTokenSet: Boolean(s.playlistToken)
  });
});

router.put('/api/settings', requireAdmin(loadSettings), (req: Request, res: Response) => {
  const body = req.body as Partial<Settings>;
  const errors: string[] = [];
  const current = loadSettings();

  const next: Settings = { ...DEFAULT_SETTINGS, ...pickPersisted(current) };

  if (body.preStartMinutes !== undefined) {
    const n = Number(body.preStartMinutes);
    if (!Number.isFinite(n) || n < 0 || n > 240) errors.push('preStartMinutes must be 0..240');
    else next.preStartMinutes = n;
  }
  if (body.postEndGraceMinutes !== undefined) {
    const n = Number(body.postEndGraceMinutes);
    if (!Number.isFinite(n) || n < 0 || n > 240) errors.push('postEndGraceMinutes must be 0..240');
    else next.postEndGraceMinutes = n;
  }
  if (body.retentionHours !== undefined) {
    const n = Number(body.retentionHours);
    if (!Number.isFinite(n) || n < 1 || n > 24 * 30) errors.push('retentionHours must be 1..720');
    else next.retentionHours = n;
  }
  if (body.defaultTimezone !== undefined) {
    const tz = String(body.defaultTimezone);
    if (!validTimezone(tz)) errors.push(`'${tz}' is not a valid IANA timezone`);
    else next.defaultTimezone = tz;
  }
  if (body.eventFeedUrl !== undefined) {
    const url = body.eventFeedUrl ? String(body.eventFeedUrl).trim() : '';
    if (url && !/^https?:\/\//i.test(url)) errors.push('eventFeedUrl must be an http(s) URL or empty to disable');
    else next.eventFeedUrl = url || undefined;
  }
  if (body.eventFeedIntervalMinutes !== undefined) {
    const n = Number(body.eventFeedIntervalMinutes);
    if (!Number.isFinite(n) || n < 0 || n > 1440) errors.push('eventFeedIntervalMinutes must be 0..1440 (0 = off)');
    else next.eventFeedIntervalMinutes = n;
  }

  if (errors.length) { res.status(400).json({ error: errors.join('; ') }); return; }

  saveJson(FILE, next, 'settings');
  res.json({ ...loadSettings(), adminToken: undefined, playlistToken: undefined });
});

function pickPersisted(s: Settings): Settings {
  return {
    preStartMinutes: s.preStartMinutes,
    postEndGraceMinutes: s.postEndGraceMinutes,
    retentionHours: s.retentionHours,
    defaultTimezone: s.defaultTimezone,
    eventFeedUrl: s.eventFeedUrl,
    eventFeedIntervalMinutes: s.eventFeedIntervalMinutes
  };
}

export default router;
