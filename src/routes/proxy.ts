/**
 * Optional stream proxy — ISOLATED module.
 *
 * Enabled per-request with ?proxy=1 on playlist URLs. Routes:
 *   GET /stream/247/:id                    -> proxy a 24/7 channel
 *   GET /stream/event/:id/:sourceIndex     -> proxy an event source
 *   GET /stream/p?u=<encoded upstream url> -> internal passthrough used by
 *                                             manifest rewriting (segments,
 *                                             child manifests, keys)
 *
 * How it works:
 * 1. The item's stream URL is fetched upstream with the item's custom headers
 *    (referer / user-agent), if any.
 * 2. If the response looks like an HLS manifest (.m3u8), every absolute and
 *    relative URI inside it (segment lines, URI="..." attributes, child
 *    playlists) is rewritten to point back through /stream/p, so all media
 *    traffic flows via BinTV with the same headers.
 * 3. Anything else (segments, keys) is piped straight through.
 *
 * Header bookkeeping: an in-memory LRU-ish Map maps upstream URL -> headers so
 * /stream/p knows which headers to use without leaking them in the URL.
 *
 * CORS is permissive on all /stream routes so web players (hls.js) can use
 * them from any origin.
 */
import { Request, Response as ExpressResponse, Router } from 'express';
import { loadJson, saveJson } from '../storage';
import { CHANNELS_FILE, EVENTS_FILE, DATA_DIR } from '../config';
import { Channel, EventItem } from '../types';
import { resolveStream } from '../resolver';
import { decodePngToTs, isPng } from '../pngTs';

const router = Router();

// ---------------------------------------------------------------- header map
const HEADER_MAP = new Map<string, { referer?: string; userAgent?: string }>();
const HEADER_MAP_MAX = 500;

function rememberHeaders(url: string, headers?: { referer?: string; userAgent?: string }): void {
  if (HEADER_MAP.size >= HEADER_MAP_MAX) {
    const oldest = HEADER_MAP.keys().next().value;
    if (oldest) HEADER_MAP.delete(oldest);
  }
  if (headers && (headers.referer || headers.userAgent)) HEADER_MAP.set(url, headers);
}

function upstreamFetchHeaders(url: string): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': HEADER_MAP.get(url)?.userAgent || 'BinTV/1.0' };
  const referer = HEADER_MAP.get(url)?.referer;
  if (referer) h['Referer'] = referer;
  return h;
}

function itemHeaders(h?: { referer?: string; userAgent?: string }): Record<string, string> {
  const out: Record<string, string> = { 'User-Agent': h?.userAgent || 'BinTV/1.0' };
  if (h?.referer) out['Referer'] = h.referer;
  return out;
}

// ---------------------------------------------------------------- helpers
function looksLikeManifest(url: string, contentType?: string): boolean {
  if (contentType && /mpegurl/i.test(contentType)) return true;
  return /\.m3u8(\?|$)/i.test(url);
}

function proxied(url: string, base: string): string {
  return `${base}/stream/p?u=${encodeURIComponent(url)}`;
}

/**
 * Rewrites every URI inside an HLS manifest to pass back through BinTV.
 * `onRewrite` (optional) is invoked with each absolute URL that now flows
 * through /stream/p so callers can register per-URL upstream headers.
 */
export function rewriteManifest(
  text: string,
  manifestUrl: string,
  base: string,
  onRewrite?: (absoluteUrl: string) => void
): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      // URI="..." attributes inside directives (#EXT-X-KEY, #EXT-X-MAP, ...)
      let rewritten = line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
        const abs = new URL(uri, manifestUrl).toString();
        onRewrite?.(abs);
        return `URI="${proxied(abs, base)}"`;
      });
      // Non-comment lines are segment or child-playlist URLs
      if (!rewritten.trim().startsWith('#') && rewritten.trim()) {
        const abs = new URL(rewritten.trim(), manifestUrl).toString();
        onRewrite?.(abs);
        rewritten = proxied(abs, base);
      }
      return rewritten;
    })
    .join('\n');
}

/**
 * Fetches an upstream URL, retrying transient failures (flaky 404/5xx bursts
 * and network errors) a few times with a short backoff. The upstream secure-
 * token servers occasionally 404 on a perfectly valid token, so a single
 * attempt would constantly break live playback.
 */
const RETRY_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

async function fetchUpstream(url: string, headers: Record<string, string>, attempts = 3): Promise<Response> {
  let lastError: unknown = new Error('upstream fetch failed');
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 400 * attempt));
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      if (res.ok || !RETRY_STATUSES.has(res.status) || attempt === attempts - 1) return res;
      await res.text().catch(() => {}); // drain the failed body, free the socket
      lastError = new Error(`upstream responded ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function pipeResponse(upstream: globalThis.Response, res: ExpressResponse): void {
  const headers: Record<string, string> = {};
  const passThrough = ['content-type', 'cache-control'];
  for (const name of passThrough) {
    const v = upstream.headers.get(name);
    if (v) headers[name] = v;
  }
  res.status(upstream.status);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (!upstream.body) { res.end(); return; }

  const reader = upstream.body.getReader();
  let sniffed = Buffer.alloc(0);
  let sniffDone = false;

  /** True once enough bytes have been buffered to rule out a PNG payload. */
  const sniffComplete = (): boolean => sniffDone || sniffed.length >= 8;

  const flushSniffed = (): void => {
    if (sniffed.length) { res.write(sniffed); sniffed = Buffer.alloc(0); }
  };

  const pump = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);

      if (!sniffComplete()) {
        // Accumulate the head of the body to detect pixel-packed PNG
        // segments (upstream anti-hotlinking) before anything is sent.
        const need = 8 - sniffed.length;
        sniffed = Buffer.concat([sniffed, chunk.subarray(0, Math.min(need, chunk.length))]);
        const rest = chunk.subarray(Math.min(need, chunk.length));
        if (!sniffComplete()) continue;
        if (isPng(sniffed)) {
          // PNG path: buffer the whole body, decode pixels -> MPEG-TS.
          const parts: Buffer[] = [sniffed, rest];
          for (;;) {
            const step = await reader.read();
            if (step.done) break;
            parts.push(Buffer.from(step.value));
          }
          const full = Buffer.concat(parts);
          let body: Buffer<ArrayBufferLike> = full;
          try {
            body = decodePngToTs(full);
            res.setHeader('Content-Type', 'video/mp2t');
          } catch (err) {
            console.error('[proxy] PNG segment decode failed:', err instanceof Error ? err.message : err);
            // Undecodable PNG (ad frame / decoy) — media players cannot use it.
            res.status(502).json({ error: 'Upstream segment could not be decoded to media' });
            return;
          }
          res.setHeader('Content-Length', String(body.length));
          res.end(body);
          return;
        }
        sniffDone = true;
        flushSniffed();
        if (rest.length) res.write(rest);
        continue;
      }
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  };
  pump().catch(() => res.destroy());
  res.on('close', () => reader.cancel().catch(() => {}));
}

// ---------------------------------------------------------------- resolvers
function resolveChannel(id: string): Channel | null {
  const channels = loadJson<Channel[]>(CHANNELS_FILE, [], 'channels');
  return channels.find((c) => c.id === id && c.enabled) || null;
}

function resolveEventSource(id: string, sourceIndex: number): { event: EventItem; url: string } | null {
  const events = loadJson<EventItem[]>(EVENTS_FILE, [], 'events');
  const event = events.find((e) => e.id === id && e.enabled);
  if (!event) return null;
  const idx = Math.max(1, Math.min(sourceIndex || 1, event.sources.length));
  const src = event.sources[idx - 1];
  return src ? { event, url: src.url } : null;
}

// ---------------------------------------------------------------- handlers
async function proxyItem(res: ExpressResponse, base: string, rawUrl: string, headers?: { referer?: string; userAgent?: string }): Promise<void> {
  // Two passes: pass 0 may reuse a cached resolution, pass 1 forces a fresh
  // one. Secure-token embeds (shoewiki / nodelay) hand out tickets that the
  // upstream occasionally rejects or lets lapse, so a stale cached URL is
  // retried with a brand-new ticket before giving up on the client.
  for (let pass = 0; pass < 2; pass++) {
    let url: string;
    let effectiveHeaders: { referer?: string; userAgent?: string };
    try {
      const resolved = await resolveStream(rawUrl, { fresh: pass === 1 });
      url = resolved.url;
      const wasEmbed = url !== rawUrl;
      // For embeds the resolver's headers belong to the FINAL upstream host
      // (e.g. Referer: shoewiki.click) and are required; item headers win for
      // plain direct streams the user may have imported with custom headers.
      effectiveHeaders = wasEmbed
        ? {
            referer: resolved.headers['Referer'] || headers?.referer,
            userAgent: resolved.headers['User-Agent'] || headers?.userAgent
          }
        : {
            referer: headers?.referer || resolved.headers['Referer'],
            userAgent: headers?.userAgent || resolved.headers['User-Agent']
          };
    } catch (err) {
      console.error('[proxy] resolve failed for', rawUrl, err);
      if (pass === 1) { res.status(502).json({ error: 'Failed to resolve stream' }); return; }
      continue;
    }
    rememberHeaders(url, effectiveHeaders);
    try {
      const upstream = await fetchUpstream(url, itemHeaders(effectiveHeaders));
      if (!upstream.ok) {
        if (pass === 0) continue; // re-resolve with a fresh ticket and retry
        res.status(502).json({ error: `Upstream responded ${upstream.status}` });
        return;
      }
      const finalUrl = upstream.url || url;
      if (finalUrl !== url) rememberHeaders(finalUrl, effectiveHeaders);
      const contentType = upstream.headers.get('content-type') || undefined;
      if (looksLikeManifest(finalUrl, contentType)) {
        const text = await upstream.text();
        // Register the item's headers for every child URL (segments, variant
        // playlists, keys) so /stream/p fetches them with the same identity.
        const onRewrite = (childUrl: string): void => { rememberHeaders(childUrl, effectiveHeaders); };
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.send(rewriteManifest(text, finalUrl, base, onRewrite));
        return;
      }
      if (contentType && /text\/html/i.test(contentType)) {
        // An embed page slipped through resolution — piping HTML to a media
        // player would only produce a confusing decode error.
        console.error('[proxy] upstream returned HTML instead of media for', finalUrl);
        if (pass === 0) continue;
        res.status(502).json({ error: 'Upstream returned an embed page instead of a playable stream' });
        return;
      }
      pipeResponse(upstream, res);
      return;
    } catch (err) {
      console.error('[proxy] fetch failed for', url, err);
      if (pass === 0) continue;
      res.status(502).json({ error: 'Failed to fetch upstream stream' });
      return;
    }
  }
}

router.get('/stream/247/:id', async (req: Request, res: ExpressResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ch = resolveChannel(req.params.id);
  if (!ch) { res.status(404).json({ error: 'Channel not found or disabled' }); return; }
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const base = `${proto}://${host}`;
  await proxyItem(res, base, ch.streamUrl, ch.headers);
});

router.get('/stream/event/:id/:sourceIndex', async (req: Request, res: ExpressResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const resolved = resolveEventSource(req.params.id, Number(req.params.sourceIndex) || 1);
  if (!resolved) { res.status(404).json({ error: 'Event source not found or disabled' }); return; }
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const base = `${proto}://${host}`;
  await proxyItem(res, base, resolved.url, resolved.event.headers);
});

router.get('/stream/p', async (req: Request, res: ExpressResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = String(req.query.u || '');
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'Missing or invalid u parameter' });
    return;
  }
  try {
    const upstream = await fetchUpstream(url, upstreamFetchHeaders(url));
    if (!upstream.ok) {
      res.status(502).json({ error: `Upstream responded ${upstream.status}` });
      return;
    }
    // Child manifests are rewritten too (variant playlists, etc.)
    if (looksLikeManifest(url, upstream.headers.get('content-type') || undefined)) {
      const text = await upstream.text();
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      const proto = req.headers['x-forwarded-proto'] || req.protocol;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.send(rewriteManifest(text, upstream.url || url, `${proto}://${host}`));
      return;
    }
    pipeResponse(upstream, res);
  } catch (err) {
    console.error('[proxy] passthrough failed for', url, err);
    res.status(502).json({ error: 'Failed to fetch upstream segment' });
  }
});

export default router;
