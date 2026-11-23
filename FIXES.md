# BinTV — Stream Playback Fixes (v1.1)

## Symptom
Streams would not play: the viewer showed endless spinner / error overlays, and
the /stream proxy endpoints returned HTML player pages or PNG images instead of
video.

## Root causes found

1. **The stream resolver was never wired in.** `src/resolver.ts` (which unwraps
   bintv-sources.pages.dev / shoewiki.click / nodelay embeds into real HLS
   URLs) was dead code. The proxy (`src/routes/proxy.ts`) only stripped the
   first wrapper layer, so it fetched the shoewiki *embed page* (HTML) and sent
   it to media players as if it were a stream.

2. **The viewer misrouted proxy URLs into an iframe.** `isEmbedStream()` in
   `src/client/viewer.ts` classified `/stream/247/:id` and `/stream/event/:id/:n`
   as "embed" URLs (no media file extension), so even when the proxy was fixed,
   hls.js never got the stream — it was dumped into an <iframe>.

3. **Upstream anti-hotlinking: video hidden inside PNG images.** The upstream
   CDN serves HLS segments as PNG images ("lossless pixel-packed" KWP1 format,
   revealed by decoding the shoewiki player script). hls.js received PNGs and
   could not decode them.

4. **Flaky upstream tokens.** The secure-token server intermittently returns
   404 bursts on perfectly valid tickets, breaking manifest loads and segment
   fetches.

## Fixes

- `src/routes/proxy.ts`
  - Now resolves every item through `resolveStream()` before fetching, and uses
    the resolver's final-host headers (e.g. Referer: shoewiki.click).
  - Retries transient upstream failures (404/408/425/429/5xx) with backoff.
  - Two-pass resolution: cached ticket first, forced fresh re-resolution on
    failure, before giving up on the client.
  - Registers per-URL headers for every rewritten child URL (segments, variant
    playlists, keys) so /stream/p fetches them with the same identity.
  - Detects pixel-packed PNG segments (via new `src/pngTs.ts`) and decodes them
    back to real MPEG-TS on the fly; returns a clear 502 for undecodable ones.
  - Never pipes HTML embed pages to players anymore (clear 502 instead).
- `src/pngTs.ts` (new) — PNG chunk parser + zlib inflate + PNG unfiltering
  (None/Sub/Up/Average/Paeth), alpha stripping, kwLn truncation, KWP1/raw-TS
  payload extraction.
- `src/client/viewer.ts` — internal `/stream/` proxy URLs are now played with
  hls.js instead of being treated as embed iframes.
- `src/tests/pngTs.test.ts` (new) — unit tests for the PNG->TS decoder.
  All 27 tests pass.

## Verified
- 8/8 channels return valid HLS manifests through /stream/247/:id.
- Manifest -> variant playlist -> segment chain fully rewritten through
  /stream/p; segments decode to aligned MPEG-TS (0x47 sync bytes).
- Live events work identically through /stream/event/:id/:n.

# M3U Playlist Fixes for IPTV Players (v1.2)

## Symptom
The M3U playlist loaded (or half-loaded) in TiviMate / IPTVnator but channels
showed "unavailable" or no EPG.

## Root causes found

1. **Every playlist entry pointed at an HTML embed wrapper.** Without the
   `?proxy=1` query param (which nobody adds), the playlists emitted the raw
   `bintv-sources.pages.dev/?id=...` URLs. IPTV apps fetch stream URLs directly:
   they cannot resolve embed wrappers, set Referer headers, or render HTML
   player pages — so all 255 entries were unplayable. (The web viewer worked
   because it silently routes through /stream.)

2. **XMLTV timestamps contained a "T"** (`20261123T180000 +0000`). The XMLTV
   spec requires `YYYYMMDDHHmmss +0000`; strict parsers in TiviMate and
   IPTVnator rejected every programme time, so EPG never attached.

3. **The combined playlist referenced only the 24/7 EPG** (`/epg/247.xml`), so
   event channels could never get EPG data from a single-EPG player.

4. **Multi-source events emitted duplicate tvg-ids.** Players like TiviMate
   de-duplicate channels by tvg-id, so sources 2+ were dropped.

## Fixes

- `src/routes/playlists.ts` — entries now auto-proxy through BinTV whenever
  the upstream URL is an embed wrapper or needs custom headers (mirroring the
  web viewer). Direct `.m3u8` sources stay direct. `?proxy=0` is an explicit
  escape hatch for raw upstream URLs.
- `src/epg.ts` — spec-compliant XMLTV times (no "T"); events EPG now emits one
  channel + programme per source variant; new `generateCombinedEpg()`.
- `src/routes/epgRoutes.ts` — new combined `GET /epg.xml`.
- `src/routes/playlists.ts` — `/playlist.m3u` now references `/epg.xml` (one
  EPG URL for everything); `/playlist/247.m3u` and `/playlist/events.m3u`
  keep their dedicated EPGs.
- `src/playlists.ts` — `#EXTM3U` header now carries both `url-tvg` and
  `x-tvg-url` (different players read different attributes); event entries get
  unique per-source tvg-ids (`bintv-event-<id>-sN` for source N>1).

## Verified
- Parsed the generated playlist like an IPTV app: 255/255 entries valid, all
  URLs playable, zero duplicate tvg-ids.
- Spot-fetched entries with a plain HTTP client (no Referer): HLS manifests
  returned (failures only when the upstream itself is briefly down).
- Combined EPG: 342 channels / 1294 programmes, strict XMLTV time regex passes,
  every programme references an existing channel.
