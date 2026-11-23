/**
 * BinTV server entry point.
 * Express app that serves the viewer UI, the admin UI, the REST API, dynamic
 * M3U playlists, XMLTV EPG and the optional stream proxy.
 *
 * Run: npm install && npm start   (listens on 0.0.0.0, PORT env, default 3010)
 */
import * as path from 'path';
import express, { Express, Request, Response } from 'express';
import { loadSettings } from './config';
import { baseUrlFrom } from './baseUrl';
import { hasAdminAccess } from './auth';
import { startBackgroundJobs } from './background';
import playlistRoutes from './routes/playlists';
import epgRoutes from './routes/epgRoutes';
import apiChannels from './routes/apiChannels';
import apiEvents from './routes/apiEvents';
import apiSettings from './routes/apiSettings';
import apiFeed from './routes/apiFeed';
import proxyRoutes from './routes/proxy';

const PORT = Number(process.env.PORT) || 3010;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app: Express = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// --- dynamic playlists + EPG (no auth unless PLAYLIST_TOKEN is set) ---------
app.use(playlistRoutes);
app.use(epgRoutes);

// --- REST API ---------------------------------------------------------------
app.use(apiChannels);
app.use(apiEvents);
app.use(apiSettings);
app.use(apiFeed);

// --- optional stream proxy (permissive CORS, isolated module) ---------------
app.use(proxyRoutes);

// --- misc endpoints ----------------------------------------------------------
import QRCode from 'qrcode';

/** Server-side QR renderer: GET /qr?text=<playlist url> -> SVG. */
app.get('/qr', (req: Request, res: Response) => {
  const text = String(req.query.text || '');
  if (!text) { res.status(400).json({ error: 'Missing text parameter' }); return; }
  QRCode.toString(text, { type: 'svg', margin: 1, width: 180, color: { dark: '#0b0f14', light: '#ffffff' } })
    .then((svg: string) => {
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(svg);
    })
    .catch(() => res.status(500).json({ error: 'QR generation failed' }));
});

app.get('/api/status', (req: Request, res: Response) => {
  const settings = loadSettings();
  const base = baseUrlFrom(req);
  res.json({
    app: 'BinTV',
    version: '1.0.0',
    baseUrl: base,
    urls: {
      viewer: `${base}/`,
      admin: `${base}/admin`,
      playlist247: `${base}/playlist/247.m3u`,
      playlistEvents: `${base}/playlist/events.m3u`,
      playlistCombined: `${base}/playlist.m3u`,
      epg247: `${base}/epg/247.xml`,
      epgEvents: `${base}/epg/events.xml`
    },
    serverTime: new Date().toISOString(),
    serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    adminRequired: Boolean(settings.adminToken),
    playlistTokenRequired: Boolean(settings.playlistToken)
  });
});

/** Admin UI session check: does the caller hold a valid ADMIN_TOKEN? */
app.post('/api/auth-check', (req: Request, res: Response) => {
  res.json({ ok: hasAdminAccess(req, loadSettings()) });
});

// --- static frontend ---------------------------------------------------------
app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));
app.get('/admin', (_req: Request, res: Response) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// 404 for everything else (JSON for /api, plain for the rest)
app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/api/')) res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
  else res.status(404).send('Not found');
});

// JSON error handler (bad JSON bodies, unexpected throws)
app.use((err: Error, _req: Request, res: Response, _next: unknown) => {
  console.error('[server] error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  const settings = loadSettings();
  console.log(`BinTV running on http://0.0.0.0:${PORT}`);
  console.log(`  Viewer:    http://localhost:${PORT}/`);
  console.log(`  Admin:     http://localhost:${PORT}/admin`);
  console.log(`  Playlist:  http://localhost:${PORT}/playlist/247.m3u`);
  console.log(`             http://localhost:${PORT}/playlist/events.m3u`);
  console.log(`  Admin protection: ${settings.adminToken ? 'ON (ADMIN_TOKEN set)' : 'off'}`);
  console.log(`  Playlist token:   ${settings.playlistToken ? 'ON (PLAYLIST_TOKEN set)' : 'off'}`);
  startBackgroundJobs(loadSettings, () => console.log('[events] data changed'));
});
