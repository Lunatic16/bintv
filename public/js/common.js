/** Shared client helpers for the BinTV viewer and admin UI. */
export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const adminToken = localStorage.getItem('bintv_admin_token');
    if (adminToken)
        headers['x-admin-token'] = adminToken;
    const res = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const message = data.error || `HTTP ${res.status}`;
        throw new Error(message);
    }
    return data;
}
/** Shows a brief toast. kind: info | error | ok */
export function toast(message, kind = 'info') {
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
export function debounce(fn, ms) {
    let t;
    return (...args) => {
        window.clearTimeout(t);
        t = window.setTimeout(() => fn(...args), ms);
    };
}
export function fmtClock(ms, tz) {
    try {
        return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
    }
    catch {
        return new Date(ms).toISOString().slice(11, 16);
    }
}
export function fmtDayLabel(ms, tz) {
    const local = new Date(ms).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const today = new Date(Date.now()).toLocaleDateString('en-CA', { timeZone: tz });
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: tz });
    if (local === today)
        return 'today';
    if (local === tomorrow)
        return 'tomorrow';
    return new Date(ms).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
}
export function countdown(msUntil) {
    const s = Math.max(0, Math.floor((msUntil - Date.now()) / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0)
        return `${d}d ${h}h ${m}m`;
    if (h > 0)
        return `${h}h ${m}m`;
    if (m > 0)
        return `${m}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
}
export function elapsed(msSince) {
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
export function zonedTimeToUtc(local, tz) {
    if (!local)
        return '';
    const guess = Date.parse(`${local}:00Z`);
    if (Number.isNaN(guess))
        return '';
    const offsetAt = (ms) => {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).formatToParts(new Date(ms));
        const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? '0');
        const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
        return asUtc - ms;
    };
    let ms = guess - offsetAt(guess);
    ms = guess - offsetAt(ms);
    return new Date(ms).toISOString();
}
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch {
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
export function initials(text) {
    return text.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}
