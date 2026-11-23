<div align="center">

# BinTV

**A modern, self-hosted IPTV hub — 24/7 channels, live events, dynamic M3U playlists and XMLTV EPG in one lightweight Node.js server.**

[![License: MIT](https://img.shields.io/badge/License-MIT-2f6feb.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](package.json) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json) [![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg)](#docker) [![Tests](https://img.shields.io/badge/tests-27%20passing-8a2be2.svg)](#development)

</div>

---

BinTV turns a pair of JSON files into a complete IPTV backend: a polished web viewer for watching in the browser, and **dynamically generated M3U playlists plus XMLTV EPG** that plug straight into players like **TiviMate**, **IPTVnator**, VLC and Kodi. Every playlist request is regenerated from your data, so edits and the passage of time appear instantly — no restart, no cron.

---

## Screenshots

![Web viewer — 24/7 channels](docs/screenshots/viewer-247.png)

| Viewer — live events | Admin panel |
| --- | --- |
| ![Viewer — live events](docs/screenshots/viewer-events.png) | ![Admin panel](docs/screenshots/admin.png) |

| Playlists dialog | Fullscreen (controls auto-hide) | Mobile |
| --- | --- | --- |
| ![Playlists dialog](docs/screenshots/playlists.png) | ![Fullscreen player](docs/screenshots/fullscreen.png) | <img src="docs/screenshots/viewer-mobile.png" width="240" alt="Mobile viewer"> |

<!-- Screenshots live in docs/screenshots/ — regenerate any time the UI changes -->

---

## Highlights

**Web viewer** (`/`)

- Dark, responsive app-style layout with a single accent color: a large player on the left and a browsing sidebar on the right (the player stays pinned on top on phones and tablets)
- **24/7** and **Events** tabs, each with a live item count (the Events badge shows how many are live now); your last tab and group filter are remembered, and the idle player offers a **Resume** button for the last channel (it never autoplays on page load)
- **Channel browsing:** compact numbered rows, group chips with counts, a **★ Favorites** filter, live search (Enter plays the first match), and the playing channel is highlighted and scrolled into view
- **Event browsing:** compact rows with thumbnail, category, source count and LIVE badge or in-place countdown; sticky sections — *Live Now / Starting Soon / Later Today / Tomorrow / Upcoming* — plus category chips and a **Live** toggle
- **Player:** one clean control bar (previous/next, play/pause, stop, volume, quality, picture-in-picture, fullscreen), a favorite star next to the title, click to pause, double-click for fullscreen, multi-source switcher
- **Fullscreen:** the controls float over the video and fade out after a few idle seconds; move the mouse, tap or press a key to bring them back
- **Playlists dialog:** the **Playlists** button in the top bar opens the M3U URLs, QR codes, group/category filters and TiviMate setup notes
- Resilient playback: auto-retry with backoff and a friendly error overlay, empty states, toasts
- Quality of life: scroll position is kept across the background refreshes, the playlist filter selections survive auto-refresh, and every list row is keyboard-focusable

**Admin panel** (`/admin`)

- Full CRUD for channels and events, drag or button reorder, enable/disable, duplicate, "Start now" / "End now" quick actions
- Multi-source editing, `datetime-local` pickers with timezone handling
- M3U bulk import for both sections (default group / start time / duration), JSON export, settings editor, optional `ADMIN_TOKEN` gate

**Playlist & EPG engine**

- Two separate M3U playlists (24/7 and Events) plus a combined one, regenerated on every request
- Minimal XMLTV EPG generated on request; events carry real start/end times so TiviMate shows programme countdowns
- Event lifecycle is computed at request time — never stored: `upcoming` → `live` (from `start − preStartMinutes` to `end + postEndGraceMinutes`) → `ended`; ended events are pruned by a background sweep after `retentionHours` (default 24 h)

**Integration**

- Optional feed importer for the BinTV Public API (or any custom JSON feed), polled in the background with stable-key upserts
- Optional stream proxy that resolves embed wrappers, applies custom headers and rewrites HLS manifests back through the server
- QR codes for playlist URLs (`GET /qr?text=…`) — scan straight into a phone player

### Keyboard shortcuts

Press **?** in the viewer to see this list.

| Key | Action |
| --- | --- |
| `/` | Focus search (`Enter` plays the first result, `Esc` clears it) |
| `0`–`9` | Jump to a channel by number |
| `↑` `↓` / `PgUp` `PgDn` | Previous / next channel (or live event, on the Events tab) |
| `Space` / `K` | Play / pause |
| `T` | Switch between 24/7 and Events |
| `S` | Favorite the current channel |
| `N` | Next source (multi-source events) |
| `F` | Fullscreen |
| `M` | Mute |

> `Tab` is no longer used for switching tabs, so normal keyboard navigation through the page works.

## Architecture

```
                       ┌────────────────────────────────────────────┐
                       │                  BinTV                     │
 JSON data files       │  Express (strict TypeScript, Node ≥ 18)    │
┌───────────────┐      │                                            │
│ channels.json │─────▶│  /                web viewer (hls.js)      │
│ events.json   │      │  /admin           admin panel              │
│ settings.json │      │  /playlist/*.m3u  dynamic M3U playlists    │
└───────────────┘      │  /epg(/247|/events).xml  XMLTV EPG         │
                       │  /api/*           REST CRUD + settings     │
   feed (optional)     │  /stream/*        HLS proxy + resolver     │
┌───────────────┐      │  /qr              QR codes                 │
| BinTV Public  │─────▶│         background: feed poll + EPG sweep  │
| API / JSON    │      └────────────────────┬───────────────────────┘
└───────────────┘                           │
                                            ▼
                     TiviMate · IPTVnator · VLC · Kodi · any browser
```

Dependencies: **express, hls.js, qrcode — nothing else.**

## Quick start

### Node.js (local)

```bash
git clone <your-repo-url> bintv && cd bintv
npm install
npm start            # builds, then serves on 0.0.0.0:3010
```

| URL | What |
| --- | --- |
| `http://localhost:3010/` | Viewer |
| `http://localhost:3010/admin` | Admin panel |
| `http://localhost:3010/playlist/247.m3u` | 24/7 playlist |
| `http://localhost:3010/playlist/events.m3u` | Events playlist |
| `http://localhost:3010/playlist.m3u` | Combined playlist + EPG |

### Docker

**Docker Compose (recommended)**

```bash
cp .env.example .env        # optional: set tokens/ports
docker compose up -d --build
docker compose logs -f
```

**Docker Run**

```bash
docker build -t bintv:latest .
docker run -d \
  --name bintv \
  --restart unless-stopped \
  -p 3015:3010 \
  -v $(pwd)/data:/app/data \
  bintv:latest
```

The server binds `0.0.0.0`, so it is reachable on the LAN at `http://<your-lan-ip>:3010/`. Playlists are built from the incoming `Host` header (respecting `X-Forwarded-Host` / `X-Forwarded-Proto`), so the same URL works from localhost and the LAN. The UI shows the detected base URL.

## Configuration

Environment variables (they win over `data/settings.json`, which can also be edited live in the admin panel):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3010` | HTTP port (listens on `0.0.0.0`) |
| `ADMIN_TOKEN` | unset | If set, required for `/admin` write APIs and admin actions |
| `PLAYLIST_TOKEN` | unset | If set, required as `?token=…` on playlist/EPG routes |
| `PRE_START_MINUTES` | `10` | Event goes "live" this many minutes before start |
| `POST_END_GRACE_MINUTES` | `15` | Stays "live" this long after end |
| `RETENTION_HOURS` | `24` | Ended events pruned after this long |
| `DEFAULT_TZ` | `UTC` | Default IANA timezone for display times |
| `EVENT_FEED_URL` | BinTV Public API | Feed URL for the background importer |
| `EVENT_FEED_INTERVAL_MINUTES` | `5` | Feed poll interval (0 = off) |

Tokens live only in the environment — they are never persisted to disk.

## Data files

`data/channels.json`, `data/events.json`, `data/settings.json` — plain JSON, written atomically (tmp + rename). Missing files are created; corrupt files are backed up as `<name>.corrupt-<timestamp>` and recreated automatically.

| Field | Channel | Event |
| --- | --- | --- |
| identity | `id` (slug), `number`, `name` | `id`, `title`, `league` |
| streaming | `streamUrl`, optional `headers` (`referer` / `userAgent`) | `sources: [{label, url}]` (multi-source), `headers` |
| metadata | `logo`, `group` (Movies, News, Kids, Music…), `tvgId` | `category` (Football, UFC, NBA, Racing…), `logo` / `poster`, `homeTeam` / `awayTeam` |
| scheduling | — | `startTime` (ISO 8601 UTC), `endTime` or `durationMinutes` |
| flags | `enabled` | `enabled` |

## Playlists & EPG

```
GET /playlist/247.m3u                       ?group=Movies,News
GET /playlist/events.m3u                    ?status=live|upcoming|all&hours=N&category=Football,NBA&source=2&tz=America/Cayman
GET /playlist.m3u                           ?include=247,events
any of the above +                          ?proxy=1|0   &token=… (if configured)

GET /epg/247.xml                            channels EPG
GET /epg/events.xml                         events EPG (real start/end per source)
GET /epg.xml                                combined EPG (referenced by /playlist.m3u)
```

- Playlists are regenerated on every request — edits and the passage of time are reflected immediately.
- Default event filter: live events plus upcoming starting within 6 hours (`?hours=N` changes the look-ahead). `?tz=` formats display names like `LIVE | Arsenal vs Chelsea` or `19:30 | Arsenal vs Chelsea` in any IANA timezone; `?source=2` picks each event's second source only.
- Every entry **auto-routes through the built-in proxy when the upstream URL is an embed wrapper or needs custom headers** — so playlists work in players that cannot set Referer headers or resolve embed pages. Direct `.m3u8` sources stay direct; `?proxy=0` forces raw upstream URLs.
- The `#EXTM3U` header carries both `url-tvg` and `x-tvg-url` (players differ in which they read); event entries get unique per-source `tvg-id`s so de-duplicating players never drop extra sources.
- If no events match, a valid placeholder entry ("No live events right now") is returned so IPTV apps never error out.
- Content-Type is `audio/x-mpegurl; charset=utf-8` with `Cache-Control: no-cache, no-store`.

## Player setup

### TiviMate

1. Settings → Playlists → **Add playlist** → **M3U playlist**.
2. Paste the playlist URL (click **Playlists** in the viewer's top bar and press **Copy**, or scan the QR code).
3. Set the **playlist update interval to the shortest option** — the events playlist regenerates on every request, so new events appear automatically.
4. For EPG, point TiviMate at `/epg/247.xml`, `/epg/events.xml`, or use the combined playlist whose `url-tvg` already references `/epg.xml`.

### IPTVnator / VLC / Kodi

Open the same M3U URLs as an "M3U file / URL" playlist. IPTVnator reads the EPG URL from the playlist header automatically; in VLC the channels appear as a playlist.

## REST API

```
# 24/7 channels
GET    /api/channels
POST   /api/channels                    {name, streamUrl, number?, group?, logo?, tvgId?, enabled?, headers?}
PUT    /api/channels/:id                partial update
DELETE /api/channels/:id
POST   /api/channels/reorder            {order: ["id2","id1",…]}
POST   /api/channels/import             {m3u: "<pasted M3U>", defaultGroup?}
GET    /api/channels/export.json

# Events (status computed at request time in every response)
GET    /api/events                      ?status=live|upcoming|ended|all&category=…&q=
POST   /api/events                      {title, category, startTime, sources:[{label,url}], …}
PUT    /api/events/:id                  partial update (rejects end < start)
DELETE /api/events/:id
POST   /api/events/:id/duplicate
POST   /api/events/:id/start-now
POST   /api/events/:id/end-now
POST   /api/events/import               {m3u, category?, startTime, durationMinutes}
GET    /api/events/export.json

# Settings & feed sync
GET    /api/settings
PUT    /api/settings                    {preStartMinutes, postEndGraceMinutes, retentionHours, defaultTimezone, eventFeedUrl?, eventFeedIntervalMinutes}
POST   /api/feed/sync                   trigger an immediate feed sync
GET    /api/feed/status                 sync status, imported counts, errors

# Misc
GET    /api/status                      base URLs, server timezone, token flags
POST   /api/auth-check                  ADMIN_TOKEN session check
GET    /qr?text=…                       server-side QR code (SVG)
GET    /stream/247/:id                  24/7 channel proxy
GET    /stream/event/:id/:sourceIndex   event proxy (per source)
GET    /stream/p?u=…                    internal manifest/segment passthrough
```

Write APIs require `ADMIN_TOKEN` when configured — via `Authorization: Bearer …`, the `x-admin-token` header, or `?token=…`.

## BinTV Public API feed

BinTV natively integrates with the **BinTV Public API** (`https://api.bintv.link/api/public/bintvjson`, the data source behind `https://www.bintv.cc/?cat=Live`):

- Ingests 24/7 channels, live events and upcoming events — multi-source options, poster art, dates and categories are retained.
- Syncs automatically in the background (default every 5 minutes), on startup, or on demand via `POST /api/feed/sync` and the admin/viewer sync buttons.
- Upserts by stable `feedKey` — manual channels and events are never overwritten or deleted.
- Custom JSON feeds are supported through the isolated adapter in `src/eventSources/` (a clear `fetchEvents()` interface and one example `JsonFeedAdapter`; set `EVENT_FEED_URL` and `EVENT_FEED_INTERVAL_MINUTES`).

## Stream proxy

The optional proxy (`?proxy=1`, or automatic for embed/custom-header sources) rewrites every stream URL to `/stream/...` and then:

- **Resolves embed wrappers** (e.g. `bintv-sources.pages.dev` embed pages) to the real HLS URLs behind them, applying the resolver's final-host headers;
- **Fetches upstream with the item's `referer` / `userAgent` headers** and rewrites URIs in `.m3u8` manifests (segment lines, `#EXT-X-KEY` / `#EXT-X-MAP` `URI="…"`, variant playlists) back through `/stream/p`;
- **Retries transient upstream failures** (404/408/425/429/5xx) with backoff, and re-resolves tokens fresh before giving up on the client;
- **Decodes "pixel-packed" segments** — some CDNs disguise MPEG-TS inside PNG images; BinTV detects the KWP1 payload and transcodes it back to real `video/mp2t` on the fly;
- Never pipes HTML embed pages to players (a clear 502 instead), and serves permissive CORS on all `/stream/*` routes.

## Development

```bash
npm run build        # compile server + client TS, vendor hls.js
npm test             # build, then run unit tests (event status boundaries,
                     # playlist generation, PNG->TS decoder)
```

Project layout:

```
src/                server (strict TypeScript)
  routes/           playlists, EPG, REST APIs, stream proxy
  client/           vanilla TS viewer + admin UI (compiled to public/js/)
  eventSources/     isolated feed importers
  tests/            unit tests (node:test)
public/             static UI + vendored hls.js
docs/screenshots/   README screenshots
data/               JSON storage (channels, events, settings)
scripts/            build helpers (vendor copy)
```

Dependencies: express, hls.js, qrcode — nothing else. Requires Node ≥ 18.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Channels show "unavailable" in TiviMate / IPTVnator | Make sure you're on the current build — playlists now auto-proxy embed sources. Verify `http://<server>:3010/playlist/247.m3u` in a browser, then force a playlist refresh in the player. |
| No EPG / programme times rejected | Your player likely cached the old EPG. Reload the playlist so it re-reads `url-tvg`, then refresh EPG; timestamps are spec-compliant XMLTV (`YYYYMMDDHHmmss +0000`). |
| A specific channel returns 502 | The upstream is briefly unavailable — retry, or force a re-resolve by reloading. A few channels' upstreams go down intermittently. |
| Player controls disappeared in fullscreen | They auto-hide after ~3 s of inactivity by design. Move the mouse, tap the screen or press any key to show them again. For embedded (iframe) streams, hover or tap the thin strip along the bottom edge. |
| Player can't reach the server from another device | Use `http://<lan-ip>:3010/...`, not `localhost`. Playlists adapt to the incoming `Host` header automatically. |
| Admin actions rejected | If `ADMIN_TOKEN` is set, log in via the admin panel or pass the token (`Authorization: Bearer …`, `x-admin-token`, or `?token=…`). |
| Playlist asks for a token | If `PLAYLIST_TOKEN` is set, append `?token=…` to playlist and EPG URLs. |

## License

[MIT](LICENSE) — BinTV is a player and playlist generator. You are responsible for the stream sources you configure; only use streams you are licensed or otherwise entitled to use.
