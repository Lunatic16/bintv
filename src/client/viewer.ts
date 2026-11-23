/**
 * BinTV viewer SPA.
 * Layout: big player + a browser sidebar (24/7 | Events) with group/category
 * filters, search, favorites. Playlist URLs live in a dialog.
 * hls.js playback with native HLS fallback, live countdowns, resilient playback.
 */
import {
  AppSettings, Channel, EventItem, api, countdown, copyText, elapsed,
  escapeHtml, fmtClock, fmtDayLabel, initials, toast
} from './common.js';

interface StatusInfoResponse {
  baseUrl: string;
  urls: Record<string, string>;
  serverTimezone: string;
  adminRequired: boolean;
}

const state = {
  channels: [] as Channel[],
  events: [] as EventItem[],
  settings: null as AppSettings | null,
  status: null as StatusInfoResponse | null,
  tab: '247' as '247' | 'events',
  search: '',
  eventCategory: 'all',
  eventLiveOnly: false,
  group: 'all' as string, // 'all' | '__fav' | <group name>
  playing: null as null | { type: '247' | 'event'; id: string; sourceIndex: number },
  favorites: new Set<string>((() => { try { return JSON.parse(localStorage.getItem('bintv_favorites') || '[]') as string[]; } catch { return []; } })()),
  lastWatched: null as null | { type: '247' | 'event'; id: string },
  numberBuffer: ''
};

const store = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* ignore */ } }
};

const ICON = {
  play: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  volume: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  muted: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5v-.7zM19 12a6.9 6.9 0 0 1-.9 3.4l1.5 1.5A9 9 0 0 0 21 12a9 9 0 0 0-7-8.8v2.1A7 7 0 0 1 19 12zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.2 4.2c-.7.5-1.4.9-2.2 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3L12 7.7zM12 4 9.9 6.1 12 8.2z"/></svg>'
};

let hls: Hls | null = null;
let retryAttempt = 0;
let currentQualityLevels: Array<{ index: number; label: string }> = [];

const viewerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ---------------------------------------------------------------- helpers
function el<T extends HTMLElement>(sel: string): T {
  const node = document.querySelector(sel);
  if (!node) throw new Error(`Missing element ${sel}`);
  return node as T;
}

function saveFavorites(): void {
  store.set('bintv_favorites', JSON.stringify([...state.favorites]));
}

function saveLastWatched(): void {
  if (state.lastWatched) store.set('bintv_last_watched', JSON.stringify(state.lastWatched));
}

/** Browser cannot set Referer/UA, so items with custom headers go through the proxy. */
function streamUrlFor(type: '247' | 'event', item: Channel | EventItem, sourceIndex = 1): string {
  const hasHeaders = Boolean((item as Channel).headers || (item as EventItem).headers);
  if (hasHeaders) {
    return type === '247'
      ? `/stream/247/${encodeURIComponent(item.id)}`
      : `/stream/event/${encodeURIComponent(item.id)}/${sourceIndex}`;
  }
  if (type === '247') return (item as Channel).streamUrl;
  const ev = item as EventItem;
  const src = ev.sources[Math.max(0, sourceIndex - 1)];
  return src ? src.url : ev.sources[0]?.url || '';
}

// ---------------------------------------------------------------- player
const video = (): HTMLVideoElement => el<HTMLVideoElement>('#video');
const iframePlayer = (): HTMLIFrameElement => el<HTMLIFrameElement>('#player-iframe');

function isEmbedStream(url: string): boolean {
  if (!url) return false;
  if (/\.m3u8(\?|#|$)/i.test(url)) return false;
  // Internal proxy routes always deliver a rewritten HLS manifest — hls.js
  // territory, never an iframe (they carry no media file extension, so the
  // extension check below would misclassify them as embeds).
  if (url.startsWith('/stream/')) return false;
  return /bintv-sources\.pages\.dev|bintv\.link|bintv\.cc|shoewiki\.click|bantertalks\.com|\/player\/|\/embed\//i.test(url)
    || !/\.(m3u8|mpd|mp4|ts)(\?|#|$)/i.test(url);
}

function destroyHls(): void {
  if (hls) { hls.destroy(); hls = null; }
}

function showPlayerOverlay(kind: 'spinner' | 'error' | 'none', message = '', sub = ''): void {
  const overlay = el<HTMLDivElement>('#player-overlay');
  overlay.dataset.kind = kind;
  overlay.classList.toggle('hidden', kind === 'none');
  el('#overlay-error').classList.toggle('hidden', kind !== 'error');
  el('#overlay-spinner').classList.toggle('hidden', kind !== 'spinner');
  el('#overlay-error-msg').textContent = message;
  el('#overlay-error-sub').textContent = sub;
}

function setIdle(idle: boolean): void {
  el('#player-idle').classList.toggle('hidden', !idle);
}

function updatePlayPauseIcon(): void {
  const v = video();
  const btn = el<HTMLButtonElement>('#play-pause');
  btn.innerHTML = v.paused ? ICON.play : ICON.pause;
  btn.title = v.paused ? 'Play (Space)' : 'Pause (Space)';
}

function updateMuteIcon(): void {
  const v = video();
  el<HTMLButtonElement>('#mute-btn').innerHTML = v.muted || v.volume === 0 ? ICON.muted : ICON.volume;
}

function updateFavButton(): void {
  const btn = el<HTMLButtonElement>('#player-fav');
  const p = state.playing;
  if (!p || p.type !== '247') { btn.classList.add('hidden'); return; }
  const fav = state.favorites.has(p.id);
  btn.classList.remove('hidden');
  btn.classList.toggle('active', fav);
  btn.textContent = fav ? '★' : '☆';
}

function toggleFavorite(id: string): void {
  const ch = state.channels.find((c) => c.id === id);
  const name = ch ? ch.name : 'channel';
  if (state.favorites.has(id)) { state.favorites.delete(id); toast(`Removed ${name} from favorites`); }
  else { state.favorites.add(id); toast(`Added ${name} to favorites`, 'ok'); }
  saveFavorites();
  renderChannels();
  updateFavButton();
}

function showBanner(text: string): void {
  const banner = el<HTMLDivElement>('#switch-banner');
  banner.textContent = text;
  banner.classList.add('show');
  window.clearTimeout((banner as unknown as { _t?: number })._t);
  (banner as unknown as { _t?: number })._t = window.setTimeout(() => banner.classList.remove('show'), 2200);
}

function populateQualitySelect(): void {
  const select = el<HTMLSelectElement>('#quality-select');
  select.innerHTML = '';
  if (currentQualityLevels.length <= 1) { select.classList.add('hidden'); return; }
  select.classList.remove('hidden');
  const auto = document.createElement('option');
  auto.value = '-1';
  auto.textContent = 'Auto';
  select.appendChild(auto);
  for (const lvl of currentQualityLevels) {
    const opt = document.createElement('option');
    opt.value = String(lvl.index);
    opt.textContent = lvl.label;
    select.appendChild(opt);
  }
  select.value = hls && hls.currentLevel === -1 ? '-1' : String(hls ? hls.currentLevel : '-1');
}

function attachHls(src: string): void {
  destroyHls();
  currentQualityLevels = [];
  const v = video();
  const nativeHls = v.canPlayType('application/vnd.apple.mpegurl') !== '';

  const Ctor = window.Hls;
  if (Ctor && Ctor.isSupported()) {
    hls = new Ctor({ maxBufferLength: 30, liveSyncDurationCount: 3 });
    hls.loadSource(src);
    hls.attachMedia(v);
    hls.on(Ctor.Events.MANIFEST_PARSED, () => {
      retryAttempt = 0;
      currentQualityLevels = hls!.levels.map((l, i) => ({ index: i, label: l.height ? `${l.height}p` : `Level ${i + 1}` })).reverse();
      populateQualitySelect();
      void video().play().catch(() => {});
      showPlayerOverlay('none');
    });
    hls.on(Ctor.Events.LEVEL_SWITCHED, (_e, data) => {
      const select = el<HTMLSelectElement>('#quality-select');
      if (select.value === '-1' && hls) {
        const lvl = data.level !== undefined ? hls.levels[data.level] : undefined;
        if (lvl) select.options[0].textContent = `Auto (${lvl.height ? lvl.height + 'p' : data.level})`;
      }
    });
    hls.on(Ctor.Events.ERROR, (_e, data) => {
      if (!data.fatal || !hls) return;
      if (data.type === Ctor.ErrorTypes.NETWORK_ERROR) {
        if (retryAttempt < 3) {
          retryAttempt += 1;
          const delay = Math.min(8000, 1000 * Math.pow(2, retryAttempt));
          showPlayerOverlay('spinner');
          window.setTimeout(() => { if (hls) { hls.destroy(); hls = null; attachHls(src); } }, delay);
        } else {
          showPlaybackFailure('Stream network error');
        }
      } else if (data.type === Ctor.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        showPlaybackFailure('Unrecoverable playback error');
      }
    });
  } else if (nativeHls) {
    // Safari / iOS native HLS fallback
    v.src = src;
    v.play().catch(() => {});
    v.onerror = () => showPlaybackFailure('Stream error');
    retryAttempt = 0;
  } else {
    showPlaybackFailure('HLS is not supported in this browser');
  }
}

/** After 3 failed retries: friendly overlay + "try next" affordances. */
function showPlaybackFailure(message: string): void {
  destroyHls();
  const playing = state.playing;
  let sub = '';
  if (playing?.type === 'event') {
    const ev = state.events.find((e) => e.id === playing.id);
    if (ev && playing.sourceIndex < ev.sources.length) sub = `Tip: this event has ${ev.sources.length} sources — try Source ${playing.sourceIndex + 1}.`;
  } else if (playing?.type === '247') {
    sub = 'Tip: use the arrow keys or click "Try next channel".';
  }
  showPlayerOverlay('error', message, sub);
}

function playStream(type: '247' | 'event', id: string, sourceIndex = 1): void {
  let item: Channel | EventItem | undefined;
  if (type === '247') item = state.channels.find((c) => c.id === id);
  else item = state.events.find((e) => e.id === id);
  if (!item) { toast('Item not found', 'error'); return; }

  const ev = type === 'event' ? (item as EventItem) : null;
  if (ev) {
    const now = Date.now();
    const liveFrom = ev.computed.liveFromMs;
    if (now < liveFrom) {
      toast(`Not yet available — opens ${countdown(liveFrom)} before start`, 'info');
      return;
    }
    if (ev.computed.status === 'ended') { toast('This event has ended', 'error'); return; }
  }

  state.playing = { type, id, sourceIndex };
  state.lastWatched = { type, id };
  saveLastWatched();

  // Player header
  const title = type === '247' ? `${(item as Channel).number} · ${(item as Channel).name}` : (item as EventItem).title;
  el('#player-title').textContent = title;
  el('#player-sub').textContent = type === 'event'
    ? `${(item as EventItem).category}${(item as EventItem).league ? ' · ' + (item as EventItem).league : ''}`
    : (item as Channel).group;

  // Source switcher for multi-source events
  const sourceWrap = el<HTMLDivElement>('#source-switcher');
  sourceWrap.innerHTML = '';
  if (ev && ev.sources.length > 1) {
    sourceWrap.classList.remove('hidden');
    ev.sources.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.className = 'chip source-chip' + (i + 1 === sourceIndex ? ' active' : '');
      btn.textContent = s.label || `Source ${i + 1}`;
      btn.addEventListener('click', () => playStream('event', ev.id, i + 1));
      sourceWrap.appendChild(btn);
    });
  } else {
    sourceWrap.classList.add('hidden');
  }

  updateNowPlayingHighlight();
  updateFavButton();
  setIdle(false);
  document.title = `${title} — BinTV`;
  showPlayerOverlay('spinner');
  const url = streamUrlFor(type, item, sourceIndex);

  const openEmbedBtn = el<HTMLButtonElement>('#open-embed-btn');
  const iframe = iframePlayer();
  const v = video();

  if (isEmbedStream(url)) {
    destroyHls();
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.classList.add('hidden');
    iframe.classList.remove('hidden');
    iframe.src = url;
    iframe.onload = () => showPlayerOverlay('none');
    window.setTimeout(() => showPlayerOverlay('none'), 1800);
    openEmbedBtn.classList.remove('hidden');
    openEmbedBtn.onclick = () => window.open(url, '_blank');
    el('#quality-select').classList.add('hidden');
  } else {
    iframe.src = 'about:blank';
    iframe.classList.add('hidden');
    openEmbedBtn.classList.add('hidden');
    v.classList.remove('hidden');
    attachHls(url);
  }

  el('#live-badge').classList.toggle('hidden', !(ev && ev.computed.status === 'live'));
}

function nextChannel(delta: number): void {
  const list = filteredChannels();
  if (!list.length) return;
  const idx = list.findIndex((c) => state.playing?.type === '247' && c.id === state.playing.id);
  const next = idx === -1
    ? (delta > 0 ? list[0] : list[list.length - 1])
    : list[(idx + delta + list.length) % list.length];
  playStream('247', next.id);
  showBanner(`${next.number} · ${next.name}`);
  scrollToPlaying();
}

/** Previous/next among currently visible live events. */
function nextLiveEvent(delta: number): void {
  const list = state.events
    .filter((e) => e.computed.status === 'live' && eventMatchesFilters(e))
    .sort((a, b) => a.computed.startMs - b.computed.startMs);
  if (!list.length) { toast('No live events to switch to', 'info'); return; }
  const idx = list.findIndex((e) => state.playing?.type === 'event' && e.id === state.playing.id);
  const next = idx === -1
    ? (delta > 0 ? list[0] : list[list.length - 1])
    : list[(idx + delta + list.length) % list.length];
  playStream('event', next.id, 1);
  showBanner(next.homeTeam && next.awayTeam ? `${next.homeTeam} vs ${next.awayTeam}` : next.title);
  scrollToPlaying();
}

/** Surf within whichever tab the viewer is browsing. */
function surf(delta: number): void {
  if (state.tab === '247') nextChannel(delta); else nextLiveEvent(delta);
}

function scrollToPlaying(): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('.now-playing')?.scrollIntoView({ block: 'nearest' });
  });
}

function nextSource(): void {
  const playing = state.playing;
  if (playing?.type !== 'event') { toast('No multi-source event playing', 'info'); return; }
  const ev = state.events.find((e) => e.id === playing.id);
  if (!ev || ev.sources.length < 2) { toast('This event has no alternative sources', 'info'); return; }
  const next = (playing.sourceIndex % ev.sources.length) + 1;
  playStream('event', ev.id, next);
  showBanner(`${ev.title} — Source ${next}`);
}

function stopPlayback(): void {
  destroyHls();
  const v = video();
  v.removeAttribute('src');
  v.load();
  v.classList.remove('hidden');
  const iframe = iframePlayer();
  iframe.src = 'about:blank';
  iframe.classList.add('hidden');
  el('#open-embed-btn').classList.add('hidden');
  state.playing = null;
  updateNowPlayingHighlight();
  showPlayerOverlay('none');
  el('#player-title').textContent = 'Nothing playing';
  el('#player-sub').textContent = 'Pick a channel or event';
  el('#live-badge').classList.add('hidden');
  el('#source-switcher').classList.add('hidden');
  el('#quality-select').classList.add('hidden');
  updateFavButton();
  setIdle(true);
  document.title = 'BinTV — Live TV & Events';
}

// ---------------------------------------------------------------- 24/7 render
function matchesSearch(c: Channel): boolean {
  const q = state.search.trim().toLowerCase();
  return !q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q) || String(c.number).includes(q);
}

function filteredChannels(): Channel[] {
  return state.channels
    .filter((c) => c.enabled)
    .filter((c) => state.group === 'all' || (state.group === '__fav' ? state.favorites.has(c.id) : c.group === state.group))
    .filter(matchesSearch)
    .sort((a, b) => (a.number - b.number) || a.name.localeCompare(b.name))
    .sort((a, b) => Number(state.favorites.has(b.id)) - Number(state.favorites.has(a.id)));
}

function renderChannelFilters(): void {
  const holder = el<HTMLDivElement>('#channel-filters');
  const enabled = state.channels.filter((c) => c.enabled);
  const groups = [...new Set(enabled.map((c) => c.group))].sort();
  if (state.group !== 'all' && state.group !== '__fav' && !groups.includes(state.group)) state.group = 'all';
  const favCount = enabled.filter((c) => state.favorites.has(c.id)).length;
  holder.innerHTML = '';
  holder.classList.toggle('hidden', enabled.length === 0);
  const make = (value: string, label: string, count: number): void => {
    const b = document.createElement('button');
    b.className = 'chip chip-btn' + (state.group === value ? ' active' : '');
    b.innerHTML = `${escapeHtml(label)} <span class="chip-count">${count}</span>`;
    b.addEventListener('click', () => {
      state.group = value;
      store.set('bintv_group', value);
      renderChannels();
      el<HTMLDivElement>('#channel-list').scrollTop = 0;
    });
    holder.appendChild(b);
  };
  make('all', 'All', enabled.length);
  if (favCount || state.group === '__fav') make('__fav', '★ Favorites', favCount);
  for (const g of groups) make(g, g, enabled.filter((c) => c.group === g).length);
  holder.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderChannels(): void {
  const holder = el<HTMLDivElement>('#channel-list');
  const scrollTop = holder.scrollTop;
  const list = filteredChannels();
  el('#count-247').textContent = String(state.channels.filter((c) => c.enabled).length);
  renderChannelFilters();
  holder.innerHTML = '';
  if (!list.length) {
    const searching = state.search.trim() !== '';
    const inFav = state.group === '__fav';
    holder.innerHTML = state.channels.length === 0
      ? `<div class="empty"><h3>No channels yet</h3><p>Add channels in <a href="/admin">/admin</a>, import an M3U playlist, or press <strong>⟳ Sync</strong>.</p></div>`
      : `<div class="empty"><h3>${inFav && !searching ? 'No favorites yet' : 'No channels found'}</h3><p>${inFav && !searching ? 'Tap the ☆ on a channel to pin it here.' : 'Try a different search or filter.'}</p>${state.group !== 'all' || searching ? '<button class="btn" id="clear-filters">Show all channels</button>' : ''}</div>`;
    holder.querySelector('#clear-filters')?.addEventListener('click', () => {
      state.group = 'all';
      state.search = '';
      el<HTMLInputElement>('#search').value = '';
      renderChannels();
    });
    return;
  }
  const playingId = state.playing?.type === '247' ? state.playing.id : null;
  for (const ch of list) {
    const fav = state.favorites.has(ch.id);
    const row = document.createElement('div');
    row.className = 'row channel-row' + (playingId === ch.id ? ' now-playing' : '');
    row.dataset.id = ch.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${ch.number} ${ch.name}`);
    row.innerHTML = `
      <div class="row-num">${ch.number}</div>
      <div class="row-logo">${ch.logo ? `<img src="${escapeHtml(ch.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<span class="initials">${escapeHtml(initials(ch.name))}</span>`}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(ch.name)}</div>
        <div class="row-sub">${escapeHtml(ch.group)}</div>
      </div>
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
      <button class="icon-btn fav-btn${fav ? ' active' : ''}" title="Favorite" aria-label="Toggle favorite" aria-pressed="${fav}">${fav ? '★' : '☆'}</button>`;
    row.querySelector('.fav-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(ch.id);
    });
    const play = (): void => { playStream('247', ch.id); showBanner(`${ch.number} · ${ch.name}`); };
    row.addEventListener('click', play);
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); }
    });
    holder.appendChild(row);
  }
  holder.scrollTop = scrollTop;
}

// ---------------------------------------------------------------- events render
interface EventGroup { label: string; events: EventItem[] }

function groupEvents(events: EventItem[]): EventGroup[] {
  const live: EventItem[] = [];
  const soon: EventItem[] = [];
  const laterToday: EventItem[] = [];
  const tomorrow: EventItem[] = [];
  const later: EventItem[] = [];
  const now = Date.now();
  const localDay = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', { timeZone: viewerTimezone });
  const today = localDay(now);
  const tomorrowDay = localDay(now + 86_400_000);
  for (const ev of events) {
    if (ev.computed.status === 'live') { live.push(ev); continue; }
    if (ev.computed.status !== 'upcoming') continue;
    const startsIn = ev.computed.startMs - now;
    if (startsIn <= 60 * 60_000) soon.push(ev);
    else if (localDay(ev.computed.startMs) === today) laterToday.push(ev);
    else if (localDay(ev.computed.startMs) === tomorrowDay) tomorrow.push(ev);
    else later.push(ev);
  }
  const byStart = (a: EventItem, b: EventItem): number => a.computed.startMs - b.computed.startMs;
  const groups: EventGroup[] = [
    { label: 'Live Now', events: live.sort(byStart) },
    { label: 'Starting Soon', events: soon.sort(byStart) },
    { label: 'Later Today', events: laterToday.sort(byStart) },
    { label: 'Tomorrow', events: tomorrow.sort(byStart) },
    { label: 'Upcoming', events: later.sort(byStart) }
  ];
  return groups.filter((g) => g.events.length > 0);
}

function eventMatchesFilters(ev: EventItem): boolean {
  const q = state.search.trim().toLowerCase();
  const qMatch = !q || ev.title.toLowerCase().includes(q) || ev.category.toLowerCase().includes(q)
    || (ev.league || '').toLowerCase().includes(q)
    || `${ev.homeTeam || ''} ${ev.awayTeam || ''}`.toLowerCase().includes(q);
  const catMatch = state.eventCategory === 'all' || ev.category === state.eventCategory;
  const liveMatch = !state.eventLiveOnly || ev.computed.status === 'live';
  return qMatch && catMatch && liveMatch;
}

function renderEvents(): void {
  const holder = el<HTMLDivElement>('#event-list');
  const scrollTop = holder.scrollTop;
  holder.innerHTML = '';
  const visible = state.events.filter(eventMatchesFilters);
  const categories = [...new Set(state.events.map((e) => e.category))].sort();
  renderCategoryChips(categories);
  const liveCount = state.events.filter((e) => e.computed.status === 'live').length;
  const countEl = el('#count-events');
  countEl.textContent = String(liveCount);
  countEl.classList.toggle('count-live', liveCount > 0);
  countEl.title = `${liveCount} live now`;

  if (!visible.length) {
    const next = [...state.events]
      .filter((e) => e.computed.status === 'upcoming')
      .sort((a, b) => a.computed.startMs - b.computed.startMs)[0];
    const filtered = state.eventLiveOnly || state.eventCategory !== 'all' || state.search.trim() !== '';
    holder.innerHTML = `
      <div class="empty">
        <h3>${filtered ? 'No matching events' : 'No live events right now'}</h3>
        ${filtered ? '<p>Try a different search or filter.</p><button class="btn" id="clear-event-filters">Show all events</button>'
          : next ? `<p>Next up: <strong>${escapeHtml(next.title)}</strong> at ${fmtClock(next.computed.startMs, viewerTimezone)} <span class="chip">${escapeHtml(next.category)}</span></p>` : '<p>Nothing scheduled — add events in <a href="/admin">/admin</a> or press <strong>⟳ Sync</strong>.</p>'}
      </div>`;
    holder.querySelector('#clear-event-filters')?.addEventListener('click', () => {
      state.eventLiveOnly = false;
      state.eventCategory = 'all';
      state.search = '';
      el<HTMLInputElement>('#search').value = '';
      renderEvents();
    });
    return;
  }

  for (const group of groupEvents(visible)) {
    const section = document.createElement('div');
    section.className = 'event-section';
    section.innerHTML = `<h3 class="section-title"><span class="dot ${group.label === 'Live Now' ? 'dot-live' : ''}"></span>${group.label}<span class="section-count">${group.events.length}</span></h3>`;
    const grid = document.createElement('div');
    grid.className = 'event-grid';
    for (const ev of group.events) grid.appendChild(eventCard(ev));
    section.appendChild(grid);
    holder.appendChild(section);
  }
  holder.scrollTop = scrollTop;
}

function eventCard(ev: EventItem): HTMLElement {
  const card = document.createElement('div');
  card.className = 'event-card' + (ev.computed.status === 'live' ? ' live-card' : '');
  card.dataset.id = ev.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  const isLive = ev.computed.status === 'live';
  const title = ev.homeTeam && ev.awayTeam ? `${ev.homeTeam} vs ${ev.awayTeam}` : ev.title;
  card.setAttribute('aria-label', title);
  const multi = ev.sources.length > 1 ? `<span class="chip chip-dim">${ev.sources.length} sources</span>` : '';
  const thumbSrc = ev.poster || ev.logo;
  const thumb = thumbSrc
    ? `<div class="event-thumb"><img src="${escapeHtml(thumbSrc)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-img');this.remove()"></div>`
    : '';
  card.innerHTML = `
    ${thumb}
    <div class="event-body">
      <div class="event-top">
        <span class="chip cat-chip">${escapeHtml(ev.category)}</span>
        ${multi}
      </div>
      <div class="event-title">${escapeHtml(title)}</div>
      <div class="event-meta">
        ${ev.league ? escapeHtml(ev.league) + ' · ' : ''}<span data-start="${ev.computed.startMs}">${fmtClock(ev.computed.startMs, viewerTimezone)} ${fmtDayLabel(ev.computed.startMs, viewerTimezone)}</span>
      </div>
    </div>
    <div class="event-action">
      ${isLive
        ? '<span class="live-badge small">● LIVE</span><span class="event-play btn btn-primary">▶ Watch</span>'
        : `<span class="event-play btn">⏱ <span data-count-until="${ev.computed.liveFromMs}">${countdown(ev.computed.liveFromMs)}</span></span>`}
    </div>`;
  const play = (): void => playStream('event', ev.id, 1);
  card.addEventListener('click', play);
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); }
  });
  if (state.playing?.type === 'event' && state.playing.id === ev.id) card.classList.add('now-playing');
  return card;
}

function renderCategoryChips(categories: string[]): void {
  const holder = el<HTMLDivElement>('#category-chips');
  holder.innerHTML = '';
  const liveCount = state.events.filter((e) => e.computed.status === 'live').length;
  const add = (label: string, active: boolean, onClick: () => void, extra = ''): void => {
    const b = document.createElement('button');
    b.className = 'chip chip-btn' + (active ? ' active' : '') + extra;
    b.innerHTML = label;
    b.addEventListener('click', onClick);
    holder.appendChild(b);
  };
  add('All', state.eventCategory === 'all' && !state.eventLiveOnly, () => { state.eventCategory = 'all'; state.eventLiveOnly = false; renderEvents(); });
  add(`<span class="dot dot-live"></span> Live <span class="chip-count">${liveCount}</span>`, state.eventLiveOnly, () => { state.eventLiveOnly = !state.eventLiveOnly; renderEvents(); });
  for (const cat of categories) {
    add(escapeHtml(cat), state.eventCategory === cat, () => { state.eventCategory = state.eventCategory === cat ? 'all' : cat; renderEvents(); });
  }
  holder.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------------------------------------------------------------- ticker
let refreshingEvents = false;
let lastFlipRefresh = 0;

function tick(): void {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>('[data-count-until]').forEach((node) => {
    const until = Number(node.dataset.countUntil);
    if (!until) return;
    const isLive = now >= until;
    const card = node.closest('.event-card');
    if (isLive && card) {
      // upcoming -> live: poll (throttled) so the card flips to LIVE
      if (!refreshingEvents && now - lastFlipRefresh > 5000) {
        lastFlipRefresh = now;
        void refreshEvents().catch(() => {});
      }
      return;
    }
    node.textContent = countdown(until);
  });
  document.querySelectorAll<HTMLElement>('[data-elapsed-from]').forEach((node) => {
    node.textContent = ` · ${elapsed(Number(node.dataset.elapsedFrom))}`;
  });
  if (state.playing?.type === 'event') {
    const ev = state.events.find((e) => e.id === state.playing!.id);
    const badge = el<HTMLSpanElement>('#live-badge');
    if (ev && ev.computed.status === 'live') {
      badge.classList.remove('hidden');
      const elapsedSpan = el<HTMLSpanElement>('#live-badge-elapsed');
      elapsedSpan.textContent = elapsed(ev.computed.startMs);
    } else {
      badge.classList.add('hidden');
    }
  }
}

// ---------------------------------------------------------------- playlist panel
function buildPlaylistUrls(): void {
  const origin = window.location.origin;
  const tz = encodeURIComponent(viewerTimezone);
  const groupFilters = [...el<HTMLDivElement>('#pl-groups').querySelectorAll('input:checked')].map((i) => (i as HTMLInputElement).value);
  const groupQ = groupFilters.length ? `?group=${encodeURIComponent(groupFilters.join(','))}` : '';
  const status = el<HTMLSelectElement>('#pl-events-status').value;
  const hours = el<HTMLInputElement>('#pl-events-hours').value || '6';
  const catFilters = [...el<HTMLDivElement>('#pl-cats').querySelectorAll('input:checked')].map((i) => (i as HTMLInputElement).value);
  const params = new URLSearchParams();
  if (status && status !== 'default') params.set('status', status);
  if (hours && hours !== '6') params.set('hours', hours);
  if (catFilters.length) params.set('category', catFilters.join(','));
  params.set('tz', decodeURIComponent(tz));
  const eventsQ = `?${params.toString()}`;

  const url247 = `${origin}/playlist/247.m3u${groupQ}`;
  const urlEvents = `${origin}/playlist/events.m3u${eventsQ}`;
  el<HTMLInputElement>('#pl-url-247').value = url247;
  el<HTMLInputElement>('#pl-url-events').value = urlEvents;
  el<HTMLAnchorElement>('#pl-link-combined').href = `${origin}/playlist.m3u`;
  el<HTMLSpanElement>('#pl-link-combined-text').textContent = `${origin}/playlist.m3u`;

  drawQr('pl-qr-247', url247);
  drawQr('pl-qr-events', urlEvents);
}

function drawQr(imgId: string, text: string): void {
  const img = document.getElementById(imgId) as HTMLImageElement | null;
  if (!img) return;
  const next = `/qr?text=${encodeURIComponent(text)}`;
  if (img.dataset.src !== next) {
    img.dataset.src = next;
    img.src = next;
  }
}

function renderPlaylistPanelFilters(): void {
  const checkedIn = (id: string): Set<string> => new Set([...el<HTMLDivElement>(id).querySelectorAll('input:checked')].map((i) => (i as HTMLInputElement).value));
  const keepGroups = checkedIn('#pl-groups');
  const keepCats = checkedIn('#pl-cats');
  const groups = [...new Set(state.channels.filter((c) => c.enabled).map((c) => c.group))].sort();
  const gHolder = el<HTMLDivElement>('#pl-groups');
  gHolder.innerHTML = '';
  for (const g of groups) {
    const label = document.createElement('label');
    label.className = 'chip chip-btn';
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(g)}"${keepGroups.has(g) ? ' checked' : ''}> ${escapeHtml(g)}`;
    (label.querySelector('input') as HTMLInputElement).addEventListener('change', buildPlaylistUrls);
    gHolder.appendChild(label);
  }
  const cats = [...new Set(state.events.map((e) => e.category))].sort();
  const cHolder = el<HTMLDivElement>('#pl-cats');
  cHolder.innerHTML = '';
  for (const c of cats) {
    const label = document.createElement('label');
    label.className = 'chip chip-btn';
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(c)}"${keepCats.has(c) ? ' checked' : ''}> ${escapeHtml(c)}`;
    (label.querySelector('input') as HTMLInputElement).addEventListener('change', buildPlaylistUrls);
    cHolder.appendChild(label);
  }
}

// ---------------------------------------------------------------- data loading
async function refreshChannels(): Promise<void> {
  state.channels = await api<Channel[]>('/api/channels');
  renderChannels();
  renderPlaylistPanelFilters();
  buildPlaylistUrls();
}

async function refreshEvents(): Promise<void> {
  refreshingEvents = true;
  try {
    state.events = await api<EventItem[]>('/api/events');
  } finally {
    refreshingEvents = false;
  }
  renderEvents();
  renderPlaylistPanelFilters();
  buildPlaylistUrls();
}

function updateNowPlayingHighlight(): void {
  document.querySelectorAll('.now-playing').forEach((n) => n.classList.remove('now-playing'));
  if (!state.playing) return;
  const selector = state.playing.type === '247' ? '.channel-row' : '.event-card';
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    if (node.dataset.id === state.playing.id) node.classList.add('now-playing');
  }
}

// ---------------------------------------------------------------- keyboard
function initKeyboard(): void {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.fullscreenElement) el('#player-panel').dispatchEvent(new Event('mousemove'));
    if (document.querySelector('dialog[open]')) return; // dialogs handle their own keys (Esc closes)
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
    if (e.key === 'Escape' && target.id === 'search') {
      const input = target as HTMLInputElement;
      if (input.value) { input.value = ''; state.search = ''; rerenderList(); } else input.blur();
      return;
    }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); el<HTMLInputElement>('#search').focus(); return; }
    if (e.key === '?') { e.preventDefault(); el<HTMLDialogElement>('#help-dialog').showModal(); return; }
    const onButton = target.closest('button, a, [role="button"]') !== null;
    if ((e.key === ' ' || e.key === 'k' || e.key === 'K') && !onButton) {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.key === 't' || e.key === 'T') { switchTab(state.tab === '247' ? 'events' : '247'); return; }
    if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
    if (e.key === 'm' || e.key === 'M') { toggleMute(); return; }
    if (e.key === 'n' || e.key === 'N') { nextSource(); return; }
    if (e.key === 's' || e.key === 'S') {
      if (state.playing?.type === '247') toggleFavorite(state.playing.id);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); surf(1); return; }
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); surf(-1); return; }
    if (/^[0-9]$/.test(e.key)) {
      state.numberBuffer += e.key;
      const banner = el<HTMLDivElement>('#number-buffer');
      banner.textContent = state.numberBuffer;
      banner.classList.add('show');
      window.clearTimeout((banner as unknown as { _t?: number })._t);
      (banner as unknown as { _t?: number })._t = window.setTimeout(() => { banner.classList.remove('show'); state.numberBuffer = ''; }, 1200);
      const num = Number(state.numberBuffer);
      const match = state.channels.find((c) => c.number === num && c.enabled);
      if (match) {
        state.numberBuffer = '';
        banner.classList.remove('show');
        playStream('247', match.id);
        showBanner(`${match.number} · ${match.name}`);
        scrollToPlaying();
      }
    }
  });
}

function rerenderList(): void {
  if (state.tab === '247') renderChannels(); else renderEvents();
}

function togglePlay(): void {
  const v = video();
  if (!state.playing) return;
  if (v.classList.contains('hidden')) return; // embedded iframe player has its own controls
  if (v.paused) void v.play().catch(() => {}); else v.pause();
}

function toggleFullscreen(): void {
  const panel = el<HTMLDivElement>('#player-panel');
  if (document.fullscreenElement) void document.exitFullscreen();
  else if (panel.requestFullscreen) void panel.requestFullscreen().catch(() => toast('Fullscreen not available', 'error'));
  else {
    // iPhone Safari only supports fullscreen on the <video> element itself
    const v = video() as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); else toast('Fullscreen not available', 'error');
  }
}

/** In fullscreen the control bar floats over the video and fades after a few idle seconds. */
function initFullscreenAutoHide(): void {
  const panel = el<HTMLElement>('#player-panel');
  let timer: number | undefined;
  const isFs = (): boolean => document.fullscreenElement === panel
    || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement === panel;
  const showControls = (): void => {
    panel.classList.remove('controls-hidden');
    window.clearTimeout(timer);
    if (!isFs()) return;
    timer = window.setTimeout(() => {
      const info = panel.querySelector('.player-info');
      const busy = info?.matches(':hover') || info?.contains(document.activeElement as Node)
        && (document.activeElement as HTMLElement | null)?.tagName === 'SELECT';
      if (isFs() && !busy) panel.classList.add('controls-hidden');
      else if (isFs()) showControls();
    }, 3000);
  };
  for (const evt of ['mousemove', 'mousedown', 'touchstart', 'keydown', 'wheel']) {
    panel.addEventListener(evt, showControls, { passive: true });
  }
  panel.querySelector('#fs-reveal')?.addEventListener('mousemove', showControls);
  panel.querySelector('#fs-reveal')?.addEventListener('touchstart', showControls, { passive: true });
  document.addEventListener('fullscreenchange', () => {
    panel.classList.toggle('is-fs', isFs());
    showControls();
  });
}

function toggleMute(): void {
  const v = video();
  v.muted = !v.muted;
  el<HTMLInputElement>('#volume').value = v.muted ? '0' : String(v.volume);
  updateMuteIcon();
}

// ---------------------------------------------------------------- wiring
function switchTab(tab: '247' | 'events'): void {
  state.tab = tab;
  store.set('bintv_tab', tab);
  for (const [id, key] of [['#tab-247', '247'], ['#tab-events', 'events']] as const) {
    const b = el<HTMLButtonElement>(id);
    b.classList.toggle('active', tab === key);
    b.setAttribute('aria-selected', String(tab === key));
  }
  el<HTMLDivElement>('#tab-panel-247').classList.toggle('hidden', tab !== '247');
  el<HTMLDivElement>('#tab-panel-events').classList.toggle('hidden', tab !== 'events');
  el<HTMLInputElement>('#search').placeholder = tab === '247' ? 'Search channels…  ( / )' : 'Search events…  ( / )';
  window.requestAnimationFrame(() => {
    el<HTMLDivElement>(tab === '247' ? '#channel-filters' : '#category-chips').querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    scrollToPlaying();
  });
}

function initPlayerControls(): void {
  const v0 = video();
  for (const evt of ['play', 'pause', 'playing', 'emptied']) v0.addEventListener(evt, updatePlayPauseIcon);
  v0.addEventListener('volumechange', updateMuteIcon);
  v0.addEventListener('click', togglePlay);
  v0.addEventListener('dblclick', toggleFullscreen);
  updatePlayPauseIcon();
  updateMuteIcon();
  el<HTMLButtonElement>('#play-pause').addEventListener('click', togglePlay);
  el<HTMLButtonElement>('#prev-btn').addEventListener('click', () => surf(-1));
  el<HTMLButtonElement>('#next-btn').addEventListener('click', () => surf(1));
  el<HTMLButtonElement>('#player-fav').addEventListener('click', () => {
    if (state.playing?.type === '247') toggleFavorite(state.playing.id);
  });
  el<HTMLButtonElement>('#mute-btn').addEventListener('click', toggleMute);
  el<HTMLInputElement>('#volume').addEventListener('input', (e) => {
    const v = video();
    v.volume = Number((e.target as HTMLInputElement).value);
    v.muted = v.volume === 0;
    updateMuteIcon();
  });
  el<HTMLButtonElement>('#fullscreen-btn').addEventListener('click', toggleFullscreen);
  el<HTMLButtonElement>('#pip-btn').addEventListener('click', async () => {
    try {
      const v = video();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch { toast('Picture-in-picture not available', 'error'); }
  });
  el<HTMLSelectElement>('#quality-select').addEventListener('change', (e) => {
    if (!hls) return;
    hls.currentLevel = Number((e.target as HTMLSelectElement).value);
  });
  el<HTMLButtonElement>('#overlay-retry').addEventListener('click', () => {
    const p = state.playing;
    if (p) playStream(p.type, p.id, p.sourceIndex);
  });
  el<HTMLButtonElement>('#overlay-next').addEventListener('click', () => {
    const p = state.playing;
    if (!p) return;
    if (p.type === 'event') nextSource();
    else nextChannel(1);
  });
  el<HTMLButtonElement>('#stop-btn').addEventListener('click', stopPlayback);
}

function initDialogs(): void {
  const open = (id: string): void => el<HTMLDialogElement>(id).showModal();
  el<HTMLButtonElement>('#open-playlists').addEventListener('click', () => open('#playlist-dialog'));
  el<HTMLButtonElement>('#open-help').addEventListener('click', () => open('#help-dialog'));
  document.querySelectorAll<HTMLDialogElement>('dialog.modal').forEach((dlg) => {
    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
    // click on the backdrop closes
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  });
}

function initPlaylistPanel(): void {
  el<HTMLButtonElement>('#copy-url-247').addEventListener('click', async () => {
    const ok = await copyText(el<HTMLInputElement>('#pl-url-247').value);
    toast(ok ? '24/7 playlist URL copied' : 'Copy failed', ok ? 'ok' : 'error');
  });
  el<HTMLButtonElement>('#copy-url-events').addEventListener('click', async () => {
    const ok = await copyText(el<HTMLInputElement>('#pl-url-events').value);
    toast(ok ? 'Events playlist URL copied' : 'Copy failed', ok ? 'ok' : 'error');
  });
  el<HTMLSelectElement>('#pl-events-status').addEventListener('change', buildPlaylistUrls);
  el<HTMLInputElement>('#pl-events-hours').addEventListener('input', buildPlaylistUrls);
  el<HTMLButtonElement>('#qr-toggle-247').addEventListener('click', () => el<HTMLDivElement>('#qr-wrap-247').classList.toggle('hidden'));
  el<HTMLButtonElement>('#qr-toggle-events').addEventListener('click', () => el<HTMLDivElement>('#qr-wrap-events').classList.toggle('hidden'));
}

/** Offer (never auto-start) the last watched item on the idle player. */
function setupResume(): void {
  const btn = el<HTMLButtonElement>('#resume-btn');
  const lw = state.lastWatched;
  let label = '';
  if (lw?.type === '247') {
    const ch = state.channels.find((c) => c.id === lw.id && c.enabled);
    if (ch) label = `${ch.number} · ${ch.name}`;
  } else if (lw?.type === 'event') {
    const ev = state.events.find((e) => e.id === lw.id && e.computed.status === 'live');
    if (ev) label = ev.title;
  }
  if (!label || !lw) { btn.classList.add('hidden'); return; }
  btn.textContent = `▶ Resume ${label}`;
  btn.classList.remove('hidden');
  btn.onclick = () => playStream(lw.type, lw.id);
}

async function init(): Promise<void> {
  initPlayerControls();
  initPlaylistPanel();
  initDialogs();
  initKeyboard();
  initFullscreenAutoHide();

  el<HTMLButtonElement>('#tab-247').addEventListener('click', () => switchTab('247'));
  el<HTMLButtonElement>('#tab-events').addEventListener('click', () => switchTab('events'));
  el<HTMLInputElement>('#search').addEventListener('input', (e) => {
    state.search = (e.target as HTMLInputElement).value;
    rerenderList();
  });
  el<HTMLInputElement>('#search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    (e.target as HTMLInputElement).blur();
    if (state.tab === '247') {
      const first = filteredChannels()[0];
      if (first) { playStream('247', first.id); showBanner(`${first.number} · ${first.name}`); scrollToPlaying(); }
    } else {
      const first = state.events.filter((ev) => ev.computed.status === 'live' && eventMatchesFilters(ev))[0];
      if (first) playStream('event', first.id, 1);
      else toast('No live event matches — pick one from the list', 'info');
    }
  });

  const syncTopbarBtn = document.querySelector<HTMLButtonElement>('#feed-sync-topbar');
  if (syncTopbarBtn) {
    const syncLabel = syncTopbarBtn.querySelector('.label');
    syncTopbarBtn.addEventListener('click', async () => {
      syncTopbarBtn.disabled = true;
      syncTopbarBtn.classList.add('busy');
      if (syncLabel) syncLabel.textContent = 'Syncing…';
      try {
        const res = await api<{ ok: boolean; importedChannels: number; importedEvents: number }>('/api/feed/sync', { method: 'POST' });
        toast(`Synced ${res.importedChannels} channels & ${res.importedEvents} events`, 'ok');
        await Promise.allSettled([refreshChannels(), refreshEvents()]);
      } catch (err) {
        toast(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        syncTopbarBtn.disabled = false;
        syncTopbarBtn.classList.remove('busy');
        if (syncLabel) syncLabel.textContent = 'Sync';
      }
    });
  }

  try {
    state.status = await api<StatusInfoResponse>('/api/status');
    state.settings = await api<AppSettings>('/api/settings');
    el<HTMLSpanElement>('#server-tz').textContent = `Server time zone: ${state.status.serverTimezone} · LAN URL: ${state.status.baseUrl}`;
  } catch { /* non-fatal */ }

  state.group = store.get('bintv_group') || 'all';
  setIdle(true);
  switchTab(store.get('bintv_tab') === 'events' ? 'events' : '247');
  await Promise.allSettled([refreshChannels(), refreshEvents()]);

  // restore last watched (highlight it, start playback)
  try {
    state.lastWatched = JSON.parse(store.get('bintv_last_watched') || 'null') as null | { type: '247' | 'event'; id: string };
  } catch { state.lastWatched = null; }
  setupResume();

  // poll events every 45s; channels every 2 min
  window.setInterval(() => { void refreshEvents().catch(() => {}); }, 45_000);
  window.setInterval(() => { void refreshChannels().catch(() => {}); }, 120_000);
  window.setInterval(tick, 1000);
  tick();
}

void init();
