/**
 * Event status computation — pure functions, fully unit-tested.
 * Internal times are epoch milliseconds (UTC); timezone conversion happens
 * only at display time.
 *
 * Rules (defaults preStart=10min, grace=15min):
 *   upcoming : now < start - preStart
 *   live     : start - preStart <= now < end + grace
 *   ended    : now >= end + grace
 */
import { EventItem, Settings, StatusInfo } from './types';

const DEFAULT_DURATION_MINUTES = 120; // safety net when neither endTime nor durationMinutes given

export function resolveStartMs(ev: EventItem): number {
  const t = Date.parse(ev.startTime);
  return Number.isFinite(t) ? t : NaN;
}

export function resolveEndMs(ev: EventItem): number {
  if (ev.endTime) {
    const t = Date.parse(ev.endTime);
    if (Number.isFinite(t)) return t;
  }
  const start = resolveStartMs(ev);
  const minutes = ev.durationMinutes && ev.durationMinutes > 0
    ? ev.durationMinutes
    : DEFAULT_DURATION_MINUTES;
  return start + minutes * 60_000;
}

export function computeStatus(ev: EventItem, nowMs: number, settings: Pick<Settings, 'preStartMinutes' | 'postEndGraceMinutes'>): StatusInfo {
  const startMs = resolveStartMs(ev);
  const endMs = resolveEndMs(ev);
  const liveFromMs = startMs - settings.preStartMinutes * 60_000;
  const liveUntilMs = endMs + settings.postEndGraceMinutes * 60_000;
  let status: StatusInfo['status'];
  if (nowMs < liveFromMs) status = 'upcoming';
  else if (nowMs < liveUntilMs) status = 'live';
  else status = 'ended';
  return { status, startMs, endMs, liveFromMs, liveUntilMs };
}

export interface StatusFilterOptions {
  /** undefined = default (live + upcoming within lookaheadHours) */
  status?: string;
  lookaheadHours: number;
  nowMs: number;
}

/** Decides whether an event passes a playlist/API status filter. */
export function passesStatusFilter(info: StatusInfo, opts: StatusFilterOptions): boolean {
  const s = (opts.status || 'default').toLowerCase();
  if (s === 'all') return true;
  if (s === 'live') return info.status === 'live';
  if (s === 'upcoming') return info.status === 'upcoming';
  if (s === 'ended') return info.status === 'ended';
  // default: live + upcoming starting within the lookahead window
  if (info.status === 'live') return true;
  if (info.status === 'upcoming') {
    return info.startMs <= opts.nowMs + opts.lookaheadHours * 3_600_000;
  }
  return false;
}
