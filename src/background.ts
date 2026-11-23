/**
 * Background jobs:
 * 1. Retention sweep — prunes events that have been "ended" for longer than
 *    the retention window (default 24h). Runs every 60s.
 * 2. Event and Channel Feed synchronizer (BinTV Public API or custom JSON feed).
 */
import { CHANNELS_FILE, EVENTS_FILE } from './config';
import { loadJson, saveJson } from './storage';
import { Channel, EventItem, ResolvedSettings } from './types';
import { computeStatus } from './eventStatus';
import { syncFeedData } from './eventSources';

let sweepTimer: NodeJS.Timeout | null = null;
let feedTimer: NodeJS.Timeout | null = null;

export interface FeedSyncStatus {
  feedUrl?: string;
  intervalMinutes: number;
  lastSyncTime: string | null;
  lastSyncError: string | null;
  importedChannels: number;
  importedEvents: number;
}

const syncStatus: FeedSyncStatus = {
  feedUrl: undefined,
  intervalMinutes: 0,
  lastSyncTime: null,
  lastSyncError: null,
  importedChannels: 0,
  importedEvents: 0
};

export function getFeedSyncStatus(): FeedSyncStatus {
  return { ...syncStatus };
}

export function startBackgroundJobs(getSettings: () => ResolvedSettings, onDataChanged: () => void): void {
  stopBackgroundJobs();

  sweepTimer = setInterval(() => {
    try {
      const settings = getSettings();
      const now = Date.now();
      const events = loadJson<EventItem[]>(EVENTS_FILE, [], 'events');
      const kept = events.filter((ev) => {
        if (!ev.enabled) return true; // disabled events are kept for the admin to re-enable
        const info = computeStatus(ev, now, settings);
        if (info.status !== 'ended') return true;
        return now < info.liveUntilMs + settings.retentionHours * 3_600_000;
      });
      if (kept.length !== events.length) {
        saveJson(EVENTS_FILE, kept, 'events');
        console.log(`[sweep] pruned ${events.length - kept.length} ended event(s)`);
        onDataChanged();
      }
    } catch (err) {
      console.error('[sweep] failed:', err);
    }
  }, 60_000);
  sweepTimer.unref?.();

  scheduleFeedPoll(getSettings, onDataChanged);
}

export async function executeFeedSync(
  getSettings: () => ResolvedSettings,
  onDataChanged?: () => void
): Promise<{ ok: boolean; importedChannels: number; importedEvents: number; error?: string }> {
  const settings = getSettings();
  syncStatus.feedUrl = settings.eventFeedUrl;
  syncStatus.intervalMinutes = settings.eventFeedIntervalMinutes;

  if (!settings.eventFeedUrl) {
    return { ok: false, importedChannels: 0, importedEvents: 0, error: 'No feed URL configured' };
  }

  const currentChannels = loadJson<Channel[]>(CHANNELS_FILE, [], 'channels');
  const currentEvents = loadJson<EventItem[]>(EVENTS_FILE, [], 'events');

  const result = await syncFeedData(settings.eventFeedUrl, currentChannels, currentEvents);

  if (result.error) {
    syncStatus.lastSyncError = result.error;
    console.error('[feed] sync error:', result.error);
    return { ok: false, importedChannels: 0, importedEvents: 0, error: result.error };
  }

  syncStatus.lastSyncTime = new Date().toISOString();
  syncStatus.lastSyncError = null;
  syncStatus.importedChannels = result.importedChannels;
  syncStatus.importedEvents = result.importedEvents;

  let changed = false;

  if (result.importedChannels > 0 || JSON.stringify(currentChannels) !== JSON.stringify(result.channels)) {
    saveJson(CHANNELS_FILE, result.channels, 'channels');
    changed = true;
  }

  if (result.importedEvents > 0 || JSON.stringify(currentEvents) !== JSON.stringify(result.events)) {
    saveJson(EVENTS_FILE, result.events, 'events');
    changed = true;
  }

  console.log(`[feed] synced ${result.importedChannels} channel(s) and ${result.importedEvents} event(s) from ${settings.eventFeedUrl}`);

  if (changed && onDataChanged) {
    onDataChanged();
  }

  return {
    ok: true,
    importedChannels: result.importedChannels,
    importedEvents: result.importedEvents
  };
}

function scheduleFeedPoll(getSettings: () => ResolvedSettings, onDataChanged: () => void): void {
  const loop = (): void => {
    const settings = getSettings();
    if (!settings.eventFeedUrl || settings.eventFeedIntervalMinutes <= 0) {
      feedTimer = setTimeout(loop, 120_000);
      feedTimer.unref?.();
      return;
    }
    executeFeedSync(getSettings, onDataChanged)
      .catch((err) => console.error('[feed] poll failed:', err))
      .finally(() => {
        const minutes = Math.max(1, getSettings().eventFeedIntervalMinutes);
        feedTimer = setTimeout(loop, minutes * 60_000);
        feedTimer.unref?.();
      });
  };

  // Run initial sync shortly after server start
  setTimeout(() => {
    const settings = getSettings();
    if (settings.eventFeedUrl && settings.eventFeedIntervalMinutes > 0) {
      executeFeedSync(getSettings, onDataChanged).catch((err) =>
        console.error('[feed] initial sync failed:', err)
      );
    }
  }, 1000).unref?.();

  loop();
}

export function stopBackgroundJobs(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  if (feedTimer) clearTimeout(feedTimer);
  sweepTimer = null;
  feedTimer = null;
}
