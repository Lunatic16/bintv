import * as fs from 'fs';
import * as path from 'path';
import { ResolvedSettings, Settings } from './types';

export const DATA_DIR = path.join(process.cwd(), 'data');
export const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
export const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const BINTV_PUBLIC_API_URL = 'https://api.bintv.link/api/public/bintvjson';

export const DEFAULT_SETTINGS: Settings = {
  preStartMinutes: 10,
  postEndGraceMinutes: 15,
  retentionHours: 24,
  defaultTimezone: 'UTC',
  eventFeedUrl: BINTV_PUBLIC_API_URL,
  eventFeedIntervalMinutes: 5
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Effective settings: defaults <- data/settings.json <- environment variables.
 * Tokens live only in the environment (never persisted to disk).
 */
export function loadSettings(): ResolvedSettings {
  let fromFile: Partial<Settings> = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      fromFile = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
    }
  } catch (err) {
    console.error('[config] settings.json unreadable, using defaults/env:', err);
  }
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...fromFile,
    preStartMinutes: numEnv('PRE_START_MINUTES', fromFile.preStartMinutes ?? DEFAULT_SETTINGS.preStartMinutes),
    postEndGraceMinutes: numEnv('POST_END_GRACE_MINUTES', fromFile.postEndGraceMinutes ?? DEFAULT_SETTINGS.postEndGraceMinutes),
    retentionHours: numEnv('RETENTION_HOURS', fromFile.retentionHours ?? DEFAULT_SETTINGS.retentionHours),
    defaultTimezone: process.env.DEFAULT_TZ || fromFile.defaultTimezone || DEFAULT_SETTINGS.defaultTimezone,
    eventFeedUrl: process.env.EVENT_FEED_URL || fromFile.eventFeedUrl || DEFAULT_SETTINGS.eventFeedUrl,
    eventFeedIntervalMinutes: numEnv('EVENT_FEED_INTERVAL_MINUTES', fromFile.eventFeedIntervalMinutes ?? DEFAULT_SETTINGS.eventFeedIntervalMinutes)
  };
  return {
    ...merged,
    playlistToken: process.env.PLAYLIST_TOKEN,
    adminToken: process.env.ADMIN_TOKEN
  };
}

export function validTimezone(tz: string | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
