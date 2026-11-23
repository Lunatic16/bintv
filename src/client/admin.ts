/**
 * BinTV admin UI.
 * Two sections (24/7 Channels, Events) with full CRUD, reorder, M3U bulk
 * import, JSON export, quick actions, settings, and optional ADMIN_TOKEN gate.
 */
import {
  AppSettings, Channel, EventItem, api, debounce, escapeHtml, fmtClock, toast, zonedTimeToUtc
} from './common.js';

interface EventSource { label: string; url: string }
interface AdminEvent {
  id: string; title: string; category: string; league?: string;
  startTime: string; endTime?: string; durationMinutes?: number;
  sources: EventSource[]; logo?: string; poster?: string;
  homeTeam?: string; awayTeam?: string;
  headers?: { referer?: string; userAgent?: string }; enabled: boolean;
  computed?: { status: 'upcoming' | 'live' | 'ended'; startMs: number };
}

function el<T extends HTMLElement>(sel: string): T {
  const node = document.querySelector(sel);
  if (!node) throw new Error(`Missing element ${sel}`);
  return node as T;
}

let channels: Channel[] = [];
let events: AdminEvent[] = [];
let settings: AppSettings | null = null;
let adminToken: string = localStorage.getItem('bintv_admin_token') || '';
let editingChannelId: string | null = null;
let editingEventId: string | null = null;
let eventSources: EventSource[] = [];

const tzOptions = (): string[] => [
  settings?.defaultTimezone || 'UTC',
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Cayman', 'America/Mexico_City', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'Europe/Madrid', 'Africa/Lagos', 'Africa/Johannesburg', 'Asia/Dubai',
  'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney'
].filter((v, i, a) => v && a.indexOf(v) === i);

function fillTimezoneSelect(select: HTMLSelectElement, selected?: string): void {
  select.innerHTML = '';
  for (const tz of tzOptions()) {
    const opt = document.createElement('option');
    opt.value = tz;
    opt.textContent = tz;
    select.appendChild(opt);
  }
  if (selected) select.value = selected;
}

// ---------------------------------------------------------------- auth gate
async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch('/api/status');
    const status = (await res.json()) as { adminRequired: boolean };
    if (!status.adminRequired) return true;
    const res2 = await fetch('/api/auth-check', { method: 'POST', headers: { 'x-admin-token': adminToken } });
    const ok = ((await res2.json()) as { ok: boolean }).ok;
    return ok;
  } catch { return false; }
}

function showTokenGate(): void {
  const gate = el<HTMLDivElement>('#token-gate');
  gate.classList.remove('hidden');
  el<HTMLButtonElement>('#token-submit').addEventListener('click', async () => {
    adminToken = el<HTMLInputElement>('#token-input').value.trim();
    const res = await fetch('/api/auth-check', { method: 'POST', headers: { 'x-admin-token': adminToken } });
    if (((await res.json()) as { ok: boolean }).ok) {
      localStorage.setItem('bintv_admin_token', adminToken);
      gate.classList.add('hidden');
      void loadAll();
      toast('Unlocked', 'ok');
    } else {
      el<HTMLDivElement>('#token-error').textContent = 'Invalid token';
    }
  });
}

// ---------------------------------------------------------------- channels
function renderChannels(): void {
  const holder = el<HTMLDivElement>('#channels-table');
  holder.innerHTML = '';
  if (!channels.length) {
    holder.innerHTML = '<div class="empty small">No channels yet. Add one below or import an M3U.</div>';
    return;
  }
  channels.forEach((ch, idx) => {
    const row = document.createElement('div');
    row.className = 'row admin-row' + (ch.enabled ? '' : ' disabled');
    row.draggable = true;
    row.dataset.id = ch.id;
    row.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
      <div class="row-num">${ch.number}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(ch.name)}</div>
        <div class="row-meta"><span class="chip">${escapeHtml(ch.group)}</span><span class="chip chip-dim">${escapeHtml(ch.streamUrl.slice(0, 42))}…</span></div>
      </div>
      <label class="switch" title="Enabled"><input type="checkbox" data-act="toggle" ${ch.enabled ? 'checked' : ''}><span></span></label>
      <button class="icon-btn" data-act="up" title="Move up">↑</button>
      <button class="icon-btn" data-act="down" title="Move down">↓</button>
      <button class="icon-btn" data-act="edit" title="Edit">✎</button>
      <button class="icon-btn danger" data-act="delete" title="Delete">🗑</button>`;
    row.querySelector('[data-act="toggle"]')!.addEventListener('change', async (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      await api(`/api/channels/${ch.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      ch.enabled = enabled;
      toast(enabled ? `${ch.name} enabled` : `${ch.name} disabled`, 'ok');
      row.classList.toggle('disabled', !enabled);
    });
    row.querySelector('[data-act="up"]')!.addEventListener('click', () => void moveChannel(idx, -1));
    row.querySelector('[data-act="down"]')!.addEventListener('click', () => void moveChannel(idx, 1));
    row.querySelector('[data-act="edit"]')!.addEventListener('click', () => openChannelForm(ch));
    row.querySelector('[data-act="delete"]')!.addEventListener('click', async () => {
      if (!window.confirm(`Delete channel "${ch.name}"?`)) return;
      await api(`/api/channels/${ch.id}`, { method: 'DELETE' });
      toast(`Deleted ${ch.name}`, 'ok');
      await reloadChannels();
    });
    // drag & drop reorder
    row.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/plain', ch.id); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      const draggedId = e.dataTransfer?.getData('text/plain');
      if (!draggedId || draggedId === ch.id) return;
      const order = channels.map((c) => c.id);
      order.splice(order.indexOf(draggedId), 1);
      order.splice(order.indexOf(ch.id), 0, draggedId);
      await persistOrder(order);
    });
    holder.appendChild(row);
  });
}

async function moveChannel(idx: number, delta: number): Promise<void> {
  const target = idx + delta;
  if (target < 0 || target >= channels.length) return;
  const order = channels.map((c) => c.id);
  [order[idx], order[target]] = [order[target], order[idx]];
  await persistOrder(order);
}

async function persistOrder(order: string[]): Promise<void> {
  channels = await api<Channel[]>('/api/channels/reorder', { method: 'POST', body: JSON.stringify({ order }) });
  renderChannels();
}

function openChannelForm(ch?: Channel): void {
  editingChannelId = ch?.id ?? null;
  el<HTMLHeadingElement>('#channel-form-title').textContent = ch ? `Edit: ${ch.name}` : 'Add channel';
  (el<HTMLInputElement>('#ch-name').value as unknown) = ch?.name ?? '';
  (el<HTMLInputElement>('#ch-number').value as unknown) = ch?.number ?? (channels.length + 1);
  (el<HTMLInputElement>('#ch-group').value as unknown) = ch?.group ?? '';
  (el<HTMLInputElement>('#ch-url').value as unknown) = ch?.streamUrl ?? '';
  (el<HTMLInputElement>('#ch-logo').value as unknown) = ch?.logo ?? '';
  (el<HTMLInputElement>('#ch-tvgid').value as unknown) = ch?.tvgId ?? '';
  (el<HTMLInputElement>('#ch-referer').value as unknown) = ch?.headers?.referer ?? '';
  (el<HTMLInputElement>('#ch-ua').value as unknown) = ch?.headers?.userAgent ?? '';
  (el<HTMLInputElement>('#ch-enabled').checked as unknown) = ch?.enabled ?? true;
  el<HTMLDivElement>('#channel-form').classList.remove('hidden');
  el<HTMLInputElement>('#ch-name').focus();
}

async function saveChannelForm(): Promise<void> {
  const payload = {
    name: el<HTMLInputElement>('#ch-name').value.trim(),
    number: Number(el<HTMLInputElement>('#ch-number').value) || 1,
    group: el<HTMLInputElement>('#ch-group').value.trim() || 'General',
    streamUrl: el<HTMLInputElement>('#ch-url').value.trim(),
    logo: el<HTMLInputElement>('#ch-logo').value.trim() || undefined,
    tvgId: el<HTMLInputElement>('#ch-tvgid').value.trim() || undefined,
    headers: {
      referer: el<HTMLInputElement>('#ch-referer').value.trim() || undefined,
      userAgent: el<HTMLInputElement>('#ch-ua').value.trim() || undefined
    },
    enabled: el<HTMLInputElement>('#ch-enabled').checked
  };
  if (!payload.name || !payload.streamUrl) { toast('Name and stream URL are required', 'error'); return; }
  try {
    if (editingChannelId) {
      await api(`/api/channels/${editingChannelId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Channel updated', 'ok');
    } else {
      await api('/api/channels', { method: 'POST', body: JSON.stringify(payload) });
      toast('Channel added', 'ok');
    }
    el<HTMLDivElement>('#channel-form').classList.add('hidden');
    await reloadChannels();
  } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error'); }
}

// ---------------------------------------------------------------- events
function renderEvents(): void {
  const holder = el<HTMLDivElement>('#events-table');
  holder.innerHTML = '';
  if (!events.length) {
    holder.innerHTML = '<div class="empty small">No events yet. Add one below, import an M3U, or configure a feed.</div>';
    return;
  }
  const sorted = [...events].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  for (const ev of sorted) {
    const status = ev.computed?.status || 'upcoming';
    const row = document.createElement('div');
    row.className = 'row admin-row' + (ev.enabled ? '' : ' disabled');
    row.dataset.id = ev.id;
    row.innerHTML = `
      <div class="row-main">
        <div class="row-title">${escapeHtml(ev.title)}</div>
        <div class="row-meta">
          <span class="chip">${escapeHtml(ev.category)}</span>
          <span class="status-pill status-${status}">${status.toUpperCase()}</span>
          <span class="chip chip-dim">${fmtClock(Date.parse(ev.startTime), settings?.defaultTimezone || 'UTC')} · ${ev.sources.length} src</span>
        </div>
      </div>
      <label class="switch" title="Enabled"><input type="checkbox" data-act="toggle" ${ev.enabled ? 'checked' : ''}><span></span></label>
      <button class="icon-btn" data-act="start" title="Start now">▶</button>
      <button class="icon-btn" data-act="end" title="End now">■</button>
      <button class="icon-btn" data-act="duplicate" title="Duplicate">⧉</button>
      <button class="icon-btn" data-act="edit" title="Edit">✎</button>
      <button class="icon-btn danger" data-act="delete" title="Delete">🗑</button>`;
    row.querySelector('[data-act="toggle"]')!.addEventListener('change', async (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      await api(`/api/events/${ev.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      ev.enabled = enabled;
      row.classList.toggle('disabled', !enabled);
      toast(enabled ? 'Event enabled' : 'Event disabled', 'ok');
    });
    row.querySelector('[data-act="start"]')!.addEventListener('click', async () => {
      await api(`/api/events/${ev.id}/start-now`, { method: 'POST' });
      toast(`"${ev.title}" is now live`, 'ok');
      await reloadEvents();
    });
    row.querySelector('[data-act="end"]')!.addEventListener('click', async () => {
      await api(`/api/events/${ev.id}/end-now`, { method: 'POST' });
      toast(`"${ev.title}" ended`, 'ok');
      await reloadEvents();
    });
    row.querySelector('[data-act="duplicate"]')!.addEventListener('click', async () => {
      await api(`/api/events/${ev.id}/duplicate`, { method: 'POST' });
      toast('Event duplicated', 'ok');
      await reloadEvents();
    });
    row.querySelector('[data-act="edit"]')!.addEventListener('click', () => openEventForm(ev));
    row.querySelector('[data-act="delete"]')!.addEventListener('click', async () => {
      if (!window.confirm(`Delete event "${ev.title}"?`)) return;
      await api(`/api/events/${ev.id}`, { method: 'DELETE' });
      toast('Event deleted', 'ok');
      await reloadEvents();
    });
    holder.appendChild(row);
  }
}

function toLocalInputValue(iso: string, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(iso));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
  } catch {
    return new Date(iso).toISOString().slice(0, 16);
  }
}

function openEventForm(ev?: AdminEvent): void {
  editingEventId = ev?.id ?? null;
  const tz = settings?.defaultTimezone || 'UTC';
  el<HTMLHeadingElement>('#event-form-title').textContent = ev ? `Edit: ${ev.title}` : 'Add event';
  (el<HTMLInputElement>('#ev-title').value as unknown) = ev?.title ?? '';
  (el<HTMLInputElement>('#ev-category').value as unknown) = ev?.category ?? '';
  (el<HTMLInputElement>('#ev-league').value as unknown) = ev?.league ?? '';
  (el<HTMLInputElement>('#ev-home').value as unknown) = ev?.homeTeam ?? '';
  (el<HTMLInputElement>('#ev-away').value as unknown) = ev?.awayTeam ?? '';
  fillTimezoneSelect(el<HTMLSelectElement>('#ev-tz'), tz);
  (el<HTMLInputElement>('#ev-start').value as unknown) = toLocalInputValue(ev?.startTime || new Date(Date.now() + 3_600_000).toISOString(), tz);
  (el<HTMLInputElement>('#ev-end').value as unknown) = ev?.endTime ? toLocalInputValue(ev.endTime, tz) : '';
  (el<HTMLInputElement>('#ev-duration').value as unknown) = ev?.durationMinutes ?? 120;
  (el<HTMLInputElement>('#ev-logo').value as unknown) = ev?.logo ?? '';
  (el<HTMLInputElement>('#ev-poster').value as unknown) = ev?.poster ?? '';
  (el<HTMLInputElement>('#ev-referer').value as unknown) = ev?.headers?.referer ?? '';
  (el<HTMLInputElement>('#ev-ua').value as unknown) = ev?.headers?.userAgent ?? '';
  (el<HTMLInputElement>('#ev-enabled').checked as unknown) = ev?.enabled ?? true;
  eventSources = ev ? ev.sources.map((s) => ({ ...s })) : [{ label: 'Source 1', url: '' }];
  renderEventSources();
  el<HTMLDivElement>('#event-form').classList.remove('hidden');
}

function renderEventSources(): void {
  const holder = el<HTMLDivElement>('#ev-sources');
  holder.innerHTML = '';
  eventSources.forEach((s, i) => {
    const line = document.createElement('div');
    line.className = 'source-line';
    line.innerHTML = `
      <input type="text" class="src-label" placeholder="Source ${i + 1}" value="${escapeHtml(s.label)}">
      <input type="url" class="src-url" placeholder="https://… m3u8 URL" value="${escapeHtml(s.url)}">
      <button type="button" class="icon-btn danger" title="Remove source">✕</button>`;
    (line.querySelector('.src-label') as HTMLInputElement).addEventListener('input', (e) => { s.label = (e.target as HTMLInputElement).value; });
    (line.querySelector('.src-url') as HTMLInputElement).addEventListener('input', (e) => { s.url = (e.target as HTMLInputElement).value; });
    line.querySelector('.icon-btn')!.addEventListener('click', () => { eventSources.splice(i, 1); renderEventSources(); });
    holder.appendChild(line);
  });
}

async function saveEventForm(): Promise<void> {
  const tz = el<HTMLSelectElement>('#ev-tz').value;
  const startLocal = el<HTMLInputElement>('#ev-start').value;
  const endLocal = el<HTMLInputElement>('#ev-end').value.trim();
  const durationRaw = el<HTMLInputElement>('#ev-duration').value.trim();
  const duration = durationRaw ? Number(durationRaw) : undefined;

  const sources = eventSources.filter((s) => s.url.trim()).map((s, i) => ({
    label: s.label.trim() || `Source ${i + 1}`,
    url: s.url.trim()
  }));
  if (!sources.length) { toast('At least one source URL is required', 'error'); return; }

  const payload: Record<string, unknown> = {
    title: el<HTMLInputElement>('#ev-title').value.trim(),
    category: el<HTMLInputElement>('#ev-category').value.trim() || 'Events',
    league: el<HTMLInputElement>('#ev-league').value.trim() || undefined,
    homeTeam: el<HTMLInputElement>('#ev-home').value.trim() || undefined,
    awayTeam: el<HTMLInputElement>('#ev-away').value.trim() || undefined,
    startTime: zonedTimeToUtc(startLocal, tz),
    endTime: endLocal ? zonedTimeToUtc(endLocal, tz) : undefined,
    durationMinutes: endLocal ? undefined : (duration && duration > 0 ? duration : 120),
    sources,
    logo: el<HTMLInputElement>('#ev-logo').value.trim() || undefined,
    poster: el<HTMLInputElement>('#ev-poster').value.trim() || undefined,
    headers: {
      referer: el<HTMLInputElement>('#ev-referer').value.trim() || undefined,
      userAgent: el<HTMLInputElement>('#ev-ua').value.trim() || undefined
    },
    enabled: el<HTMLInputElement>('#ev-enabled').checked
  };
  if (!payload.title) { toast('Title is required', 'error'); return; }

  try {
    if (editingEventId) {
      await api(`/api/events/${editingEventId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Event updated', 'ok');
    } else {
      await api('/api/events', { method: 'POST', body: JSON.stringify(payload) });
      toast('Event added', 'ok');
    }
    el<HTMLDivElement>('#event-form').classList.add('hidden');
    await reloadEvents();
  } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error'); }
}

// ---------------------------------------------------------------- import & export
async function importChannelsM3u(): Promise<void> {
  const m3u = el<HTMLTextAreaElement>('#import-channels-text').value.trim();
  const defaultGroup = el<HTMLInputElement>('#import-channels-group').value.trim() || undefined;
  if (!m3u) { toast('Paste an M3U first', 'error'); return; }
  try {
    const res = await api<{ imported: number }>('/api/channels/import', { method: 'POST', body: JSON.stringify({ m3u, defaultGroup }) });
    toast(`Imported ${res.imported} channel(s)`, 'ok');
    el<HTMLTextAreaElement>('#import-channels-text').value = '';
    await reloadChannels();
  } catch (err) { toast(err instanceof Error ? err.message : 'Import failed', 'error'); }
}

async function importEventsM3u(): Promise<void> {
  const m3u = el<HTMLTextAreaElement>('#import-events-text').value.trim();
  const category = el<HTMLInputElement>('#import-events-category').value.trim() || undefined;
  const tz = el<HTMLSelectElement>('#import-events-tz').value;
  const startLocal = el<HTMLInputElement>('#import-events-start').value;
  const durationRaw = el<HTMLInputElement>('#import-events-duration').value.trim();
  if (!m3u) { toast('Paste an M3U first', 'error'); return; }
  if (!startLocal) { toast('Start time is required for imported events', 'error'); return; }
  const payload = {
    m3u, category,
    startTime: zonedTimeToUtc(startLocal, tz),
    durationMinutes: durationRaw ? Number(durationRaw) : 120
  };
  try {
    const res = await api<{ imported: number }>('/api/events/import', { method: 'POST', body: JSON.stringify(payload) });
    toast(`Imported ${res.imported} event(s)`, 'ok');
    el<HTMLTextAreaElement>('#import-events-text').value = '';
    await reloadEvents();
  } catch (err) { toast(err instanceof Error ? err.message : 'Import failed', 'error'); }
}

// ---------------------------------------------------------------- settings
function fillSettingsForm(): void {
  if (!settings) return;
  (el<HTMLInputElement>('#set-prestart').value as unknown) = settings.preStartMinutes;
  (el<HTMLInputElement>('#set-grace').value as unknown) = settings.postEndGraceMinutes;
  (el<HTMLInputElement>('#set-retention').value as unknown) = settings.retentionHours;
  fillTimezoneSelect(el<HTMLSelectElement>('#set-tz'), settings.defaultTimezone);
  (el<HTMLInputElement>('#set-feedurl').value as unknown) = settings.eventFeedUrl ?? '';
  (el<HTMLInputElement>('#set-feedinterval').value as unknown) = settings.eventFeedIntervalMinutes;
}

async function saveSettings(): Promise<void> {
  const payload = {
    preStartMinutes: Number(el<HTMLInputElement>('#set-prestart').value),
    postEndGraceMinutes: Number(el<HTMLInputElement>('#set-grace').value),
    retentionHours: Number(el<HTMLInputElement>('#set-retention').value),
    defaultTimezone: el<HTMLSelectElement>('#set-tz').value,
    eventFeedUrl: el<HTMLInputElement>('#set-feedurl').value.trim() || undefined,
    eventFeedIntervalMinutes: Number(el<HTMLInputElement>('#set-feedinterval').value) || 0
  };
  try {
    settings = await api<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    fillSettingsForm();
    toast('Settings saved', 'ok');
    await reloadEvents(); // recompute statuses with new windows
  } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error'); }
}

// ---------------------------------------------------------------- data
async function reloadChannels(): Promise<void> {
  channels = await api<Channel[]>('/api/channels');
  renderChannels();
}

async function reloadEvents(): Promise<void> {
  // status=all includes ended events so the admin can still manage them.
  events = await api<AdminEvent[]>('/api/events?status=all');
  renderEvents();
}

async function updateFeedSyncStatus(): Promise<void> {
  const statusEl = document.querySelector<HTMLSpanElement>('#feed-sync-status');
  if (!statusEl) return;
  try {
    const res = await api<{ lastSyncTime: string | null; lastSyncError: string | null; importedChannels: number; importedEvents: number }>('/api/feed/status');
    if (res.lastSyncError) {
      statusEl.textContent = `Sync error: ${res.lastSyncError}`;
      statusEl.style.color = '#ef4444';
    } else if (res.lastSyncTime) {
      const time = new Date(res.lastSyncTime).toLocaleTimeString();
      statusEl.textContent = `Synced: ${time} (${res.importedChannels} ch, ${res.importedEvents} ev)`;
      statusEl.style.color = 'var(--text-dim)';
    } else {
      statusEl.textContent = 'Not synced yet';
    }
  } catch {
    /* ignore */
  }
}

async function loadAll(): Promise<void> {
  settings = await api<AppSettings>('/api/settings');
  fillSettingsForm();
  await Promise.all([reloadChannels(), reloadEvents(), updateFeedSyncStatus()]);
  // Playlist URLs panel
  const origin = window.location.origin;
  el<HTMLInputElement>('#pl-url-247').value = `${origin}/playlist/247.m3u`;
  el<HTMLInputElement>('#pl-url-events').value = `${origin}/playlist/events.m3u`;
  el<HTMLSpanElement>('#admin-upcoming').textContent = `${events.filter((e) => e.computed?.status !== 'ended').length} active event(s), ${channels.filter((c) => c.enabled).length} enabled channel(s)`;
}

function wire(): void {
  el<HTMLButtonElement>('#channel-add').addEventListener('click', () => openChannelForm());
  el<HTMLButtonElement>('#channel-cancel').addEventListener('click', () => el<HTMLDivElement>('#channel-form').classList.add('hidden'));
  el<HTMLButtonElement>('#channel-save').addEventListener('click', () => void saveChannelForm());
  el<HTMLButtonElement>('#event-add').addEventListener('click', () => openEventForm());
  el<HTMLButtonElement>('#event-cancel').addEventListener('click', () => el<HTMLDivElement>('#event-form').classList.add('hidden'));
  el<HTMLButtonElement>('#event-save').addEventListener('click', () => void saveEventForm());
  el<HTMLButtonElement>('#ev-add-source').addEventListener('click', () => {
    eventSources.push({ label: `Source ${eventSources.length + 1}`, url: '' });
    renderEventSources();
  });
  el<HTMLButtonElement>('#import-channels-btn').addEventListener('click', () => void importChannelsM3u());
  el<HTMLButtonElement>('#import-events-btn').addEventListener('click', () => void importEventsM3u());
  fillTimezoneSelect(el<HTMLSelectElement>('#import-events-tz'));
  el<HTMLButtonElement>('#export-channels').addEventListener('click', () => window.open('/api/channels/export.json', '_blank'));
  el<HTMLButtonElement>('#export-events').addEventListener('click', () => window.open('/api/events/export.json', '_blank'));
  el<HTMLButtonElement>('#settings-save').addEventListener('click', () => void saveSettings());

  const syncBtn = el<HTMLButtonElement>('#feed-sync-btn');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = '⟳ Syncing…';
    try {
      const res = await api<{ ok: boolean; importedChannels: number; importedEvents: number }>('/api/feed/sync', { method: 'POST' });
      toast(`Synced ${res.importedChannels} channels and ${res.importedEvents} events`, 'ok');
      await loadAll();
    } catch (err) {
      toast(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = '⟳ Sync Feed Now';
    }
  });

  const searchChannels = debounce((): void => {
    const q = el<HTMLInputElement>('#admin-search-channels').value.toLowerCase();
    const filtered = channels.filter((c) => !q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
    const backup = channels;
    channels = filtered;
    renderChannels();
    channels = backup;
  }, 200);
  el<HTMLInputElement>('#admin-search-channels').addEventListener('input', () => searchChannels());

  el<HTMLButtonElement>('#copy-url-247').addEventListener('click', () => {
    void navigator.clipboard.writeText(el<HTMLInputElement>('#pl-url-247').value).then(() => toast('Copied', 'ok'));
  });
  el<HTMLButtonElement>('#copy-url-events').addEventListener('click', () => {
    void navigator.clipboard.writeText(el<HTMLInputElement>('#pl-url-events').value).then(() => toast('Copied', 'ok'));
  });
}

async function init(): Promise<void> {
  wire();
  if (await checkAuth()) {
    el<HTMLDivElement>('#token-gate').classList.add('hidden');
    await loadAll();
  } else {
    showTokenGate();
  }
  window.setInterval(() => { void reloadEvents().catch(() => {}); }, 60_000);
}

void init();
