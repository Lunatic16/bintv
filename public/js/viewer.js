/**
 * BinTV viewer SPA.
 * Tabs: 24/7 channels & Events. hls.js playback with native HLS fallback,
 * favorites, search, live countdowns, resilient playback, playlist panel.
 */
import { api, countdown, copyText, elapsed, escapeHtml, fmtClock, fmtDayLabel, initials, toast } from './common.js';
const state = {
    channels: [],
    events: [],
    settings: null,
    status: null,
    tab: '247',
    search: '',
    eventCategory: 'all',
    playing: null,
    favorites: new Set(JSON.parse(localStorage.getItem('bintv_favorites') || '[]')),
    lastWatched: null,
    numberBuffer: ''
};
let hls = null;
let retryAttempt = 0;
let currentQualityLevels = [];
const viewerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
// ---------------------------------------------------------------- helpers
function el(sel) {
    const node = document.querySelector(sel);
    if (!node)
        throw new Error(`Missing element ${sel}`);
    return node;
}
function saveFavorites() {
    localStorage.setItem('bintv_favorites', JSON.stringify([...state.favorites]));
}
function saveLastWatched() {
    if (state.lastWatched)
        localStorage.setItem('bintv_last_watched', JSON.stringify(state.lastWatched));
}
/** Browser cannot set Referer/UA, so items with custom headers go through the proxy. */
function streamUrlFor(type, item, sourceIndex = 1) {
    const hasHeaders = Boolean(item.headers || item.headers);
    if (hasHeaders) {
        return type === '247'
            ? `/stream/247/${encodeURIComponent(item.id)}`
            : `/stream/event/${encodeURIComponent(item.id)}/${sourceIndex}`;
    }
    if (type === '247')
        return item.streamUrl;
    const ev = item;
    const src = ev.sources[Math.max(0, sourceIndex - 1)];
    return src ? src.url : ev.sources[0]?.url || '';
}
// ---------------------------------------------------------------- player
const video = () => el('#video');
const iframePlayer = () => el('#player-iframe');
function isEmbedStream(url) {
    if (!url)
        return false;
    if (/\.m3u8(\?|#|$)/i.test(url))
        return false;
    // Internal proxy routes always deliver a rewritten HLS manifest — hls.js
    // territory, never an iframe (they carry no media file extension, so the
    // extension check below would misclassify them as embeds).
    if (url.startsWith('/stream/'))
        return false;
    return /bintv-sources\.pages\.dev|bintv\.link|bintv\.cc|shoewiki\.click|bantertalks\.com|\/player\/|\/embed\//i.test(url)
        || !/\.(m3u8|mpd|mp4|ts)(\?|#|$)/i.test(url);
}
function destroyHls() {
    if (hls) {
        hls.destroy();
        hls = null;
    }
}
function showPlayerOverlay(kind, message = '', sub = '') {
    const overlay = el('#player-overlay');
    overlay.dataset.kind = kind;
    overlay.classList.toggle('hidden', kind === 'none');
    el('#overlay-error').classList.toggle('hidden', kind !== 'error');
    el('#overlay-spinner').classList.toggle('hidden', kind !== 'spinner');
    el('#overlay-error-msg').textContent = message;
    el('#overlay-error-sub').textContent = sub;
}
function showBanner(text) {
    const banner = el('#switch-banner');
    banner.textContent = text;
    banner.classList.add('show');
    window.clearTimeout(banner._t);
    banner._t = window.setTimeout(() => banner.classList.remove('show'), 2200);
}
function populateQualitySelect() {
    const select = el('#quality-select');
    select.innerHTML = '';
    if (currentQualityLevels.length <= 1) {
        select.classList.add('hidden');
        return;
    }
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
function attachHls(src) {
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
            currentQualityLevels = hls.levels.map((l, i) => ({ index: i, label: l.height ? `${l.height}p` : `Level ${i + 1}` })).reverse();
            populateQualitySelect();
            void video().play().catch(() => { });
            showPlayerOverlay('none');
        });
        hls.on(Ctor.Events.LEVEL_SWITCHED, (_e, data) => {
            const select = el('#quality-select');
            if (select.value === '-1' && hls) {
                const lvl = data.level !== undefined ? hls.levels[data.level] : undefined;
                if (lvl)
                    select.options[0].textContent = `Auto (${lvl.height ? lvl.height + 'p' : data.level})`;
            }
        });
        hls.on(Ctor.Events.ERROR, (_e, data) => {
            if (!data.fatal || !hls)
                return;
            if (data.type === Ctor.ErrorTypes.NETWORK_ERROR) {
                if (retryAttempt < 3) {
                    retryAttempt += 1;
                    const delay = Math.min(8000, 1000 * Math.pow(2, retryAttempt));
                    showPlayerOverlay('spinner');
                    window.setTimeout(() => { if (hls) {
                        hls.destroy();
                        hls = null;
                        attachHls(src);
                    } }, delay);
                }
                else {
                    showPlaybackFailure('Stream network error');
                }
            }
            else if (data.type === Ctor.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
            }
            else {
                showPlaybackFailure('Unrecoverable playback error');
            }
        });
    }
    else if (nativeHls) {
        // Safari / iOS native HLS fallback
        v.src = src;
        v.play().catch(() => { });
        v.onerror = () => showPlaybackFailure('Stream error');
        retryAttempt = 0;
    }
    else {
        showPlaybackFailure('HLS is not supported in this browser');
    }
}
/** After 3 failed retries: friendly overlay + "try next" affordances. */
function showPlaybackFailure(message) {
    destroyHls();
    const playing = state.playing;
    let sub = '';
    if (playing?.type === 'event') {
        const ev = state.events.find((e) => e.id === playing.id);
        if (ev && playing.sourceIndex < ev.sources.length)
            sub = `Tip: this event has ${ev.sources.length} sources — try Source ${playing.sourceIndex + 1}.`;
    }
    else if (playing?.type === '247') {
        sub = 'Tip: use the arrow keys or click "Try next channel".';
    }
    showPlayerOverlay('error', message, sub);
}
function playStream(type, id, sourceIndex = 1) {
    let item;
    if (type === '247')
        item = state.channels.find((c) => c.id === id);
    else
        item = state.events.find((e) => e.id === id);
    if (!item) {
        toast('Item not found', 'error');
        return;
    }
    const ev = type === 'event' ? item : null;
    if (ev) {
        const now = Date.now();
        const liveFrom = ev.computed.liveFromMs;
        if (now < liveFrom) {
            toast(`Not yet available — opens ${countdown(liveFrom)} before start`, 'info');
            return;
        }
        if (ev.computed.status === 'ended') {
            toast('This event has ended', 'error');
            return;
        }
    }
    state.playing = { type, id, sourceIndex };
    state.lastWatched = { type, id };
    saveLastWatched();
    // Player header
    const title = type === '247' ? `${item.number} · ${item.name}` : item.title;
    el('#player-title').textContent = title;
    el('#player-sub').textContent = type === 'event'
        ? `${item.category}${item.league ? ' · ' + item.league : ''}`
        : item.group;
    // Source switcher for multi-source events
    const sourceWrap = el('#source-switcher');
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
    }
    else {
        sourceWrap.classList.add('hidden');
    }
    updateNowPlayingHighlight();
    showPlayerOverlay('spinner');
    const url = streamUrlFor(type, item, sourceIndex);
    const openEmbedBtn = el('#open-embed-btn');
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
    }
    else {
        iframe.src = 'about:blank';
        iframe.classList.add('hidden');
        openEmbedBtn.classList.add('hidden');
        v.classList.remove('hidden');
        attachHls(url);
    }
    el('#live-badge').classList.toggle('hidden', !(ev && ev.computed.status === 'live'));
}
function nextChannel(delta) {
    const list = filteredChannels();
    if (!list.length)
        return;
    const idx = list.findIndex((c) => state.playing?.type === '247' && c.id === state.playing.id);
    const next = list[(idx + delta + list.length) % list.length] || list[0];
    playStream('247', next.id);
    showBanner(`${next.number} · ${next.name}`);
}
function nextSource() {
    const playing = state.playing;
    if (playing?.type !== 'event') {
        toast('No multi-source event playing', 'info');
        return;
    }
    const ev = state.events.find((e) => e.id === playing.id);
    if (!ev || ev.sources.length < 2) {
        toast('This event has no alternative sources', 'info');
        return;
    }
    const next = (playing.sourceIndex % ev.sources.length) + 1;
    playStream('event', ev.id, next);
    showBanner(`${ev.title} — Source ${next}`);
}
function stopPlayback() {
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
    el('#player-sub').textContent = 'Pick a channel or event below';
    el('#live-badge').classList.add('hidden');
}
// ---------------------------------------------------------------- 24/7 render
function filteredChannels() {
    const q = state.search.trim().toLowerCase();
    return state.channels
        .filter((c) => c.enabled)
        .filter((c) => !q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q) || String(c.number).includes(q))
        .sort((a, b) => (a.number - b.number) || a.name.localeCompare(b.name))
        .sort((a, b) => Number(state.favorites.has(b.id)) - Number(state.favorites.has(a.id)));
}
function renderChannels() {
    const holder = el('#channel-list');
    const list = filteredChannels();
    holder.innerHTML = '';
    if (!list.length) {
        holder.innerHTML = `<div class="empty"><h3>No channels found</h3><p>Add channels in <a href="/admin">/admin</a> or import an M3U playlist.</p></div>`;
        return;
    }
    for (const ch of list) {
        const row = document.createElement('div');
        row.className = 'row channel-row' + (state.playing?.type === '247' && state.playing.id === ch.id ? ' now-playing' : '');
        row.dataset.id = ch.id;
        row.innerHTML = `
      <div class="row-logo">${ch.logo ? `<img src="${escapeHtml(ch.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<span class="initials">${escapeHtml(initials(ch.name))}</span>`}</div>
      <div class="row-num">${ch.number}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(ch.name)}</div>
        <div class="row-meta"><span class="chip">${escapeHtml(ch.group)}</span></div>
      </div>
      <button class="icon-btn fav-btn${state.favorites.has(ch.id) ? ' active' : ''}" title="Favorite" aria-label="Toggle favorite">${state.favorites.has(ch.id) ? '★' : '☆'}</button>`;
        row.querySelector('.fav-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.favorites.has(ch.id)) {
                state.favorites.delete(ch.id);
                toast(`Removed ${ch.name} from favorites`);
            }
            else {
                state.favorites.add(ch.id);
                toast(`Added ${ch.name} to favorites`, 'ok');
            }
            saveFavorites();
            renderChannels();
        });
        row.addEventListener('click', () => { playStream('247', ch.id); showBanner(`${ch.number} · ${ch.name}`); });
        holder.appendChild(row);
    }
}
function groupEvents(events) {
    const live = [];
    const soon = [];
    const laterToday = [];
    const tomorrow = [];
    const later = [];
    const now = Date.now();
    const localDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: viewerTimezone });
    const today = localDay(now);
    const tomorrowDay = localDay(now + 86400000);
    for (const ev of events) {
        if (ev.computed.status === 'live') {
            live.push(ev);
            continue;
        }
        if (ev.computed.status !== 'upcoming')
            continue;
        const startsIn = ev.computed.startMs - now;
        if (startsIn <= 60 * 60000)
            soon.push(ev);
        else if (localDay(ev.computed.startMs) === today)
            laterToday.push(ev);
        else if (localDay(ev.computed.startMs) === tomorrowDay)
            tomorrow.push(ev);
        else
            later.push(ev);
    }
    const byStart = (a, b) => a.computed.startMs - b.computed.startMs;
    const groups = [
        { label: 'Live Now', events: live.sort(byStart) },
        { label: 'Starting Soon', events: soon.sort(byStart) },
        { label: 'Later Today', events: laterToday.sort(byStart) },
        { label: 'Tomorrow', events: tomorrow.sort(byStart) },
        { label: 'Upcoming', events: later.sort(byStart) }
    ];
    return groups.filter((g) => g.events.length > 0);
}
function eventMatchesFilters(ev) {
    const q = state.search.trim().toLowerCase();
    const qMatch = !q || ev.title.toLowerCase().includes(q) || ev.category.toLowerCase().includes(q)
        || (ev.league || '').toLowerCase().includes(q)
        || `${ev.homeTeam || ''} ${ev.awayTeam || ''}`.toLowerCase().includes(q);
    const catMatch = state.eventCategory === 'all' || ev.category === state.eventCategory;
    return qMatch && catMatch;
}
function renderEvents() {
    const holder = el('#event-list');
    holder.innerHTML = '';
    const visible = state.events.filter(eventMatchesFilters);
    const categories = [...new Set(state.events.map((e) => e.category))].sort();
    renderCategoryChips(categories);
    if (!visible.length) {
        const next = [...state.events]
            .filter((e) => e.computed.status === 'upcoming')
            .sort((a, b) => a.computed.startMs - b.computed.startMs)[0];
        holder.innerHTML = `
      <div class="empty">
        <h3>No live events right now</h3>
        ${next ? `<p>Next up: <strong>${escapeHtml(next.title)}</strong> at ${fmtClock(next.computed.startMs, viewerTimezone)} <span class="chip">${escapeHtml(next.category)}</span></p>` : '<p>Nothing scheduled — add events in <a href="/admin">/admin</a>.</p>'}
      </div>`;
        return;
    }
    for (const group of groupEvents(visible)) {
        const section = document.createElement('div');
        section.className = 'event-section';
        section.innerHTML = `<h3 class="section-title"><span class="dot ${group.label === 'Live Now' ? 'dot-live' : ''}"></span>${group.label}</h3>`;
        const grid = document.createElement('div');
        grid.className = 'event-grid';
        for (const ev of group.events)
            grid.appendChild(eventCard(ev));
        section.appendChild(grid);
        holder.appendChild(section);
    }
}
function eventCard(ev) {
    const card = document.createElement('div');
    card.className = 'card event-card' + (ev.computed.status === 'live' ? ' live-card' : '');
    card.dataset.id = ev.id;
    const isLive = ev.computed.status === 'live';
    const title = ev.homeTeam && ev.awayTeam ? `${ev.homeTeam} vs ${ev.awayTeam}` : ev.title;
    const multi = ev.sources.length > 1 ? `<span class="chip chip-dim">+${ev.sources.length - 1} source${ev.sources.length > 2 ? 's' : ''}</span>` : '';
    const posterHtml = (ev.poster || ev.logo)
        ? `<div class="event-poster-wrap"><img src="${escapeHtml(ev.poster || ev.logo)}" class="event-poster" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
        : '';
    card.innerHTML = `
    ${posterHtml}
    <div class="event-top">
      <span class="chip cat-chip">${escapeHtml(ev.category)}</span>
      ${isLive ? '<span class="live-badge small">● LIVE</span>' : `<span class="chip chip-dim" data-count-until="${ev.computed.liveFromMs}"></span>`}
    </div>
    <div class="event-title">${escapeHtml(title)}</div>
    <div class="event-meta">
      ${ev.league ? escapeHtml(ev.league) + ' · ' : ''}<span data-start="${ev.computed.startMs}">${fmtClock(ev.computed.startMs, viewerTimezone)} ${fmtDayLabel(ev.computed.startMs, viewerTimezone)}</span>${multi}
    </div>
    <button class="btn btn-primary event-play">
      ${isLive ? '▶ Watch now' : `⏱ Opens in <span data-count-until="${ev.computed.liveFromMs}">${countdown(ev.computed.liveFromMs)}</span>`}
    </button>`;
    const playBtn = card.querySelector('.event-play');
    playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playStream('event', ev.id, 1);
    });
    card.addEventListener('click', () => playStream('event', ev.id, 1));
    if (state.playing?.type === 'event' && state.playing.id === ev.id)
        card.classList.add('now-playing');
    return card;
}
function renderCategoryChips(categories) {
    const holder = el('#category-chips');
    holder.innerHTML = '';
    const all = document.createElement('button');
    all.className = 'chip chip-btn' + (state.eventCategory === 'all' ? ' active' : '');
    all.textContent = 'All';
    all.addEventListener('click', () => { state.eventCategory = 'all'; renderEvents(); });
    holder.appendChild(all);
    for (const cat of categories) {
        const chip = document.createElement('button');
        chip.className = 'chip chip-btn' + (state.eventCategory === cat ? ' active' : '');
        chip.textContent = cat;
        chip.addEventListener('click', () => { state.eventCategory = cat; renderEvents(); });
        holder.appendChild(chip);
    }
}
// ---------------------------------------------------------------- ticker
function tick() {
    const now = Date.now();
    document.querySelectorAll('[data-count-until]').forEach((node) => {
        const until = Number(node.dataset.countUntil);
        if (!until)
            return;
        const isLive = now >= until;
        const card = node.closest('.event-card');
        if (isLive && card) {
            // upcoming -> live: poll immediately so the card flips to LIVE
            void refreshEvents();
            return;
        }
        node.textContent = countdown(until);
    });
    document.querySelectorAll('[data-elapsed-from]').forEach((node) => {
        node.textContent = ` · ${elapsed(Number(node.dataset.elapsedFrom))}`;
    });
    if (state.playing?.type === 'event') {
        const ev = state.events.find((e) => e.id === state.playing.id);
        const badge = el('#live-badge');
        if (ev && ev.computed.status === 'live') {
            badge.classList.remove('hidden');
            const elapsedSpan = el('#live-badge-elapsed');
            elapsedSpan.textContent = elapsed(ev.computed.startMs);
        }
        else {
            badge.classList.add('hidden');
        }
    }
}
// ---------------------------------------------------------------- playlist panel
function buildPlaylistUrls() {
    const origin = window.location.origin;
    const tz = encodeURIComponent(viewerTimezone);
    const groupFilters = [...el('#pl-groups').querySelectorAll('input:checked')].map((i) => i.value);
    const groupQ = groupFilters.length ? `?group=${encodeURIComponent(groupFilters.join(','))}` : '';
    const status = el('#pl-events-status').value;
    const hours = el('#pl-events-hours').value || '6';
    const catFilters = [...el('#pl-cats').querySelectorAll('input:checked')].map((i) => i.value);
    const params = new URLSearchParams();
    if (status && status !== 'default')
        params.set('status', status);
    if (hours && hours !== '6')
        params.set('hours', hours);
    if (catFilters.length)
        params.set('category', catFilters.join(','));
    params.set('tz', decodeURIComponent(tz));
    const eventsQ = `?${params.toString()}`;
    const url247 = `${origin}/playlist/247.m3u${groupQ}`;
    const urlEvents = `${origin}/playlist/events.m3u${eventsQ}`;
    el('#pl-url-247').value = url247;
    el('#pl-url-events').value = urlEvents;
    el('#pl-link-combined').href = `${origin}/playlist.m3u`;
    el('#pl-link-combined-text').textContent = `${origin}/playlist.m3u`;
    drawQr('pl-qr-247', url247);
    drawQr('pl-qr-events', urlEvents);
}
function drawQr(imgId, text) {
    const img = document.getElementById(imgId);
    if (!img)
        return;
    const next = `/qr?text=${encodeURIComponent(text)}`;
    if (img.dataset.src !== next) {
        img.dataset.src = next;
        img.src = next;
    }
}
function renderPlaylistPanelFilters() {
    const groups = [...new Set(state.channels.filter((c) => c.enabled).map((c) => c.group))].sort();
    const gHolder = el('#pl-groups');
    gHolder.innerHTML = '';
    for (const g of groups) {
        const label = document.createElement('label');
        label.className = 'chip chip-btn';
        label.innerHTML = `<input type="checkbox" value="${escapeHtml(g)}"> ${escapeHtml(g)}`;
        label.querySelector('input').addEventListener('change', buildPlaylistUrls);
        gHolder.appendChild(label);
    }
    const cats = [...new Set(state.events.map((e) => e.category))].sort();
    const cHolder = el('#pl-cats');
    cHolder.innerHTML = '';
    for (const c of cats) {
        const label = document.createElement('label');
        label.className = 'chip chip-btn';
        label.innerHTML = `<input type="checkbox" value="${escapeHtml(c)}"> ${escapeHtml(c)}`;
        label.querySelector('input').addEventListener('change', buildPlaylistUrls);
        cHolder.appendChild(label);
    }
}
// ---------------------------------------------------------------- data loading
async function refreshChannels() {
    state.channels = await api('/api/channels');
    renderChannels();
    renderPlaylistPanelFilters();
    buildPlaylistUrls();
}
async function refreshEvents() {
    state.events = await api('/api/events');
    renderEvents();
    renderPlaylistPanelFilters();
    buildPlaylistUrls();
}
function updateNowPlayingHighlight() {
    document.querySelectorAll('.now-playing').forEach((n) => n.classList.remove('now-playing'));
    if (!state.playing)
        return;
    const selector = state.playing.type === '247' ? '.channel-row' : '.event-card';
    for (const node of document.querySelectorAll(selector)) {
        if (node.dataset.id === state.playing.id)
            node.classList.add('now-playing');
    }
}
// ---------------------------------------------------------------- keyboard
function initKeyboard() {
    document.addEventListener('keydown', (e) => {
        const target = e.target;
        const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
        if (e.key === '/' && !typing) {
            e.preventDefault();
            el('#search').focus();
            return;
        }
        if (e.key === 'Tab' && !typing) {
            e.preventDefault();
            switchTab(state.tab === '247' ? 'events' : '247');
            return;
        }
        if (typing)
            return;
        if (e.key === 'f' || e.key === 'F') {
            toggleFullscreen();
            return;
        }
        if (e.key === 'm' || e.key === 'M') {
            toggleMute();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (state.tab === '247')
                nextChannel(1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (state.tab === '247')
                nextChannel(-1);
            return;
        }
        if (/^[0-9]$/.test(e.key) && state.tab === '247') {
            state.numberBuffer += e.key;
            const banner = el('#number-buffer');
            banner.textContent = state.numberBuffer;
            banner.classList.add('show');
            window.clearTimeout(banner._t);
            banner._t = window.setTimeout(() => banner.classList.remove('show'), 1200);
            const num = Number(state.numberBuffer);
            const match = state.channels.find((c) => c.number === num && c.enabled);
            if (match) {
                state.numberBuffer = '';
                banner.classList.remove('show');
                playStream('247', match.id);
                showBanner(`${match.number} · ${match.name}`);
            }
        }
    });
}
function toggleFullscreen() {
    const panel = el('#player-panel');
    if (document.fullscreenElement)
        void document.exitFullscreen();
    else
        void panel.requestFullscreen().catch(() => toast('Fullscreen not available', 'error'));
}
function toggleMute() {
    const v = video();
    v.muted = !v.muted;
    el('#volume').value = v.muted ? '0' : String(v.volume);
    el('#mute-btn').textContent = v.muted ? '🔇' : '🔊';
}
// ---------------------------------------------------------------- wiring
function switchTab(tab) {
    state.tab = tab;
    el('#tab-247').classList.toggle('active', tab === '247');
    el('#tab-events').classList.toggle('active', tab === 'events');
    el('#tab-panel-247').classList.toggle('hidden', tab !== '247');
    el('#tab-panel-events').classList.toggle('hidden', tab !== 'events');
    el('#search').placeholder = tab === '247' ? 'Search channels… (press /)' : 'Search events… (press /)';
}
function initPlayerControls() {
    el('#play-pause').addEventListener('click', () => {
        const v = video();
        if (v.paused)
            void v.play().catch(() => { });
        else
            v.pause();
    });
    el('#mute-btn').addEventListener('click', toggleMute);
    el('#volume').addEventListener('input', (e) => {
        const v = video();
        v.volume = Number(e.target.value);
        v.muted = v.volume === 0;
        el('#mute-btn').textContent = v.muted ? '🔇' : '🔊';
    });
    el('#fullscreen-btn').addEventListener('click', toggleFullscreen);
    el('#pip-btn').addEventListener('click', async () => {
        try {
            const v = video();
            if (document.pictureInPictureElement)
                await document.exitPictureInPicture();
            else
                await v.requestPictureInPicture();
        }
        catch {
            toast('Picture-in-picture not available', 'error');
        }
    });
    el('#quality-select').addEventListener('change', (e) => {
        if (!hls)
            return;
        hls.currentLevel = Number(e.target.value);
    });
    el('#overlay-retry').addEventListener('click', () => {
        const p = state.playing;
        if (p)
            playStream(p.type, p.id, p.sourceIndex);
    });
    el('#overlay-next').addEventListener('click', () => {
        const p = state.playing;
        if (!p)
            return;
        if (p.type === 'event')
            nextSource();
        else
            nextChannel(1);
    });
    el('#stop-btn').addEventListener('click', stopPlayback);
}
function initPlaylistPanel() {
    el('#copy-url-247').addEventListener('click', async () => {
        const ok = await copyText(el('#pl-url-247').value);
        toast(ok ? '24/7 playlist URL copied' : 'Copy failed', ok ? 'ok' : 'error');
    });
    el('#copy-url-events').addEventListener('click', async () => {
        const ok = await copyText(el('#pl-url-events').value);
        toast(ok ? 'Events playlist URL copied' : 'Copy failed', ok ? 'ok' : 'error');
    });
    el('#pl-events-status').addEventListener('change', buildPlaylistUrls);
    el('#pl-events-hours').addEventListener('input', buildPlaylistUrls);
    el('#qr-toggle-247').addEventListener('click', () => el('#qr-wrap-247').classList.toggle('hidden'));
    el('#qr-toggle-events').addEventListener('click', () => el('#qr-wrap-events').classList.toggle('hidden'));
}
async function init() {
    initPlayerControls();
    initPlaylistPanel();
    initKeyboard();
    el('#tab-247').addEventListener('click', () => switchTab('247'));
    el('#tab-events').addEventListener('click', () => switchTab('events'));
    el('#search').addEventListener('input', (e) => {
        state.search = e.target.value;
        if (state.tab === '247')
            renderChannels();
        else
            renderEvents();
    });
    const syncTopbarBtn = document.querySelector('#feed-sync-topbar');
    if (syncTopbarBtn) {
        syncTopbarBtn.addEventListener('click', async () => {
            syncTopbarBtn.disabled = true;
            syncTopbarBtn.textContent = '⟳ Syncing…';
            try {
                const res = await api('/api/feed/sync', { method: 'POST' });
                toast(`Synced ${res.importedChannels} channels & ${res.importedEvents} events`, 'ok');
                await Promise.allSettled([refreshChannels(), refreshEvents()]);
            }
            catch (err) {
                toast(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
            }
            finally {
                syncTopbarBtn.disabled = false;
                syncTopbarBtn.textContent = '⟳ Sync';
            }
        });
    }
    try {
        state.status = await api('/api/status');
        state.settings = await api('/api/settings');
        el('#server-tz').textContent = `Server time zone: ${state.status.serverTimezone} · LAN URL: ${state.status.baseUrl}`;
    }
    catch { /* non-fatal */ }
    switchTab('247');
    await Promise.allSettled([refreshChannels(), refreshEvents()]);
    // restore last watched (highlight it, start playback)
    try {
        state.lastWatched = JSON.parse(localStorage.getItem('bintv_last_watched') || 'null');
    }
    catch {
        state.lastWatched = null;
    }
    if (state.lastWatched) {
        if (state.lastWatched.type === '247' && state.channels.some((c) => c.id === state.lastWatched.id && c.enabled)) {
            playStream('247', state.lastWatched.id);
        }
        else if (state.lastWatched.type === 'event' && state.events.some((e) => e.id === state.lastWatched.id && e.computed.status === 'live')) {
            playStream('event', state.lastWatched.id);
        }
    }
    // poll events every 45s; channels every 2 min
    window.setInterval(() => { void refreshEvents().catch(() => { }); }, 45000);
    window.setInterval(() => { void refreshChannels().catch(() => { }); }, 120000);
    window.setInterval(tick, 1000);
    tick();
}
void init();
