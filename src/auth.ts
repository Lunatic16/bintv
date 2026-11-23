import { NextFunction, Request, Response } from 'express';
import { ResolvedSettings } from './types';

function tokenFromRequest(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-admin-token'];
  if (typeof header === 'string' && header) return header.trim();
  const q = req.query['token'];
  if (typeof q === 'string' && q) return q.trim();
  return null;
}

export function requireAdmin(getSettings: () => ResolvedSettings) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = getSettings().adminToken;
    if (!token) return next(); // protection disabled
    if (tokenFromRequest(req) === token) return next();
    res.status(401).json({ error: 'Unauthorized: valid ADMIN_TOKEN required (Authorization: Bearer <token>, x-admin-token header, or ?token=)' });
  };
}

export function requirePlaylistToken(getSettings: () => ResolvedSettings) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = getSettings().playlistToken;
    if (!token) return next(); // protection disabled
    if (tokenFromRequest(req) === token) return next();
    res.status(401).type('text/plain').send('# Playlist token required. Append ?token=... to the playlist URL.');
  };
}

/** True when the supplied request carries the admin token (used by the admin UI session check). */
export function hasAdminAccess(req: Request, settings: ResolvedSettings): boolean {
  if (!settings.adminToken) return true;
  return tokenFromRequest(req) === settings.adminToken;
}
