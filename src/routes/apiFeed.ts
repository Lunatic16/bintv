/**
 * REST API endpoints for feed synchronization (BinTV Public API & custom feeds).
 *   POST /api/feed/sync   -> trigger an immediate sync
 *   GET  /api/feed/status -> get current sync status & counts
 *   POST /api/bintv/sync  -> alias for sync
 *   GET  /api/bintv/status-> alias for status
 */
import { Request, Response, Router } from 'express';
import { loadSettings } from '../config';
import { executeFeedSync, getFeedSyncStatus } from '../background';
import { hasAdminAccess } from '../auth';

const router = Router();

router.get(['/api/feed/status', '/api/bintv/status'], (_req: Request, res: Response) => {
  res.json(getFeedSyncStatus());
});

router.post(['/api/feed/sync', '/api/bintv/sync'], async (req: Request, res: Response) => {
  const settings = loadSettings();
  if (settings.adminToken && !hasAdminAccess(req, settings)) {
    res.status(401).json({ error: 'Admin access required to trigger feed sync' });
    return;
  }

  try {
    const result = await executeFeedSync(loadSettings);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Sync failed' });
      return;
    }
    res.json({
      ok: true,
      importedChannels: result.importedChannels,
      importedEvents: result.importedEvents,
      status: getFeedSyncStatus()
    });
  } catch (err) {
    console.error('[apiFeed] sync error:', err);
    res.status(500).json({ error: String(err) });
  }
});

export default router;
