/** Shared client helpers for the BinTV viewer and admin UI. */

export interface StreamHeaders { referer?: string; userAgent?: string }
export interface EventSource { label: string; url: string }
export interface Channel {
  id: string; number: number; name: string; streamUrl: string;
  logo?: string; group: string; tvgId?: string; enabled: boolean; headers?: StreamHeaders;
}
export interface StatusInfo {
  status: 'upcoming' | 'live' | 'ended';
  startMs: number; endMs: number; liveFromMs: number; liveUntilMs: number;
}
export interface EventItem {
  id: string; title: string; category: string; league?: string;
  startTime: string; endTime?: string; durationMinutes?: number;
  sources: EventSource[]; logo?: string; poster?: string;
  homeTeam?: string; awayTeam?: string; headers?: StreamHeaders; enabled: boolean;
  computed: StatusInfo;
}
export interface AppSettings {
  preStartMinutes: number; postEndGraceMinutes: number; retentionHours: number;
  defaultTimezone: string; eventFeedUrl?: string; eventFeedIntervalMinutes: number;
  adminTokenSet: boolean; playlistTokenSet: boolean;
}

export function escapeHtml(s: string | undefined | null): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const adminToken = localStorage.getItem('bintv_admin_token');
  if (adminToken) headers['x-admin-token'] = adminToken;
  const res = await fetch(path, { ...options, headers: { ...headers, ...(options.headers as Record<string, string>) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

/** Shows a brief toast. kind: info | error | ok */
export function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  let holder = document.getElementById('toast-holder');
  if (!holder) {
    holder = document.createElement('div');
    holder.id = 'toast-holder';
    holder.className = 'toast-holder';
    document.body.appendChild(holder);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  holder.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: number | undefined;
  return (...args: A) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}

export function fmtClock(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

export function fmtDayLabel(ms: number, tz: string): string {
  const local = new Date(ms).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const today = new Date(Date.now()).toLocaleDateString('en-CA', { timeZone: tz });
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: tz });
  if (local === today) return 'today';
  if (local === tomorrow) return 'tomorrow';
  return new Date(ms).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
}

export function countdown(msUntil: number): string {
  const s = Math.max(0, Math.floor((msUntil - Date.now()) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function elapsed(msSince: number): string {
  const s = Math.max(0, Math.floor((Date.now() - msSince) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Converts a "YYYY-MM-DDTHH:mm" local-looking string interpreted in `tz`
 * into a UTC ISO string (two-pass offset resolution, DST-safe in practice).
 */
export function zonedTimeToUtc(local: string, tz: string): string {
  if (!local) return '';
  const guess = Date.parse(`${local}:00Z`);
  if (Number.isNaN(guess)) return '';
  const offsetAt = (ms: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(new Date(ms));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUtc - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return new Date(ms).toISOString();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function initials(text: string): string {
  return text.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}
