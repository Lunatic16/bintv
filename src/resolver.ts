/**
 * Stream Resolver: resolves wrapper embed URLs (bintv-sources.pages.dev, shoewiki.click, nodelay)
 * to real, playable live HLS (.m3u8) streams.
 */
import { decodeBase64Url } from './eventSources/bintvApi';

export interface ResolvedStream {
  url: string;
  headers: Record<string, string>;
}

// In-memory cache for resolved stream URLs (TTL: 2 minutes)
const RESOLVE_CACHE = new Map<string, { resolved: ResolvedStream; expiresAt: number }>();
const CACHE_TTL_MS = 2 * 60 * 1000;

export async function resolveStream(
  rawUrl: string,
  opts?: { fresh?: boolean }
): Promise<ResolvedStream> {
  if (!opts?.fresh) {
    const cached = RESOLVE_CACHE.get(rawUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.resolved;
    }
  }

  const result = await doResolveStream(rawUrl);
  RESOLVE_CACHE.set(rawUrl, { resolved: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

async function doResolveStream(rawUrl: string): Promise<ResolvedStream> {
  if (!rawUrl) {
    return { url: rawUrl, headers: {} };
  }

  // Case 1: Direct .m3u8 or .mpd already
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(rawUrl)) {
    return {
      url: rawUrl,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    };
  }

  // Case 2: bintv-sources.pages.dev wrapper (?id=...)
  let targetUrl = rawUrl;
  try {
    const u = new URL(rawUrl);
    const id = u.searchParams.get('id');
    if (id) {
      const dec = decodeBase64Url(id);
      if (dec && /^https?:\/\//i.test(dec)) {
        targetUrl = dec;
      }
    }
  } catch {
    // Keep rawUrl
  }

  // Case 3: nodelay player: https://api.bintv.link/nodelay/player/<b64>
  if (targetUrl.includes('/nodelay/player/')) {
    const parts = targetUrl.split('/nodelay/player/');
    if (parts[1]) {
      const decInner = decodeBase64Url(parts[1]);
      if (decInner && /^https?:\/\//i.test(decInner)) {
        return {
          url: decInner,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Referer: 'https://api.bintv.link/'
          }
        };
      }
    }
  }

  // Case 4: shoewiki.click embed: resolve ticket to get real .m3u8
  if (/shoewiki\.click/i.test(targetUrl)) {
    const resolved = await resolveShoeWiki(targetUrl);
    if (resolved) {
      return resolved;
    }
  }

  // Fallback: return targetUrl with generic headers
  return {
    url: targetUrl,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://bintv-sources.pages.dev/'
    }
  };
}

/**
 * Resolves a shoewiki embed URL to its underlying live .m3u8 stream by unpacking the ticket.
 */
async function resolveShoeWiki(embedUrl: string): Promise<ResolvedStream | null> {
  try {
    const pageRes = await fetch(embedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://bintv-sources.pages.dev/'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000)
    });
    if (!pageRes.ok) return null;

    const html = await pageRes.text();
    const scripts = [...html.matchAll(/<script[\s\S]*?<\/script>/gi)];

    for (const s of scripts) {
      const code = s[0];
      const arrayMatch = code.match(/\[([0-9,]+)\]/);
      const varsMatch = code.match(/_([a-zA-Z0-9]+)=(\d+),_([a-zA-Z0-9]+)=(\d+)/);

      if (arrayMatch && varsMatch) {
        const arr = arrayMatch[1].split(',').map(Number);
        const xorKey = Number(varsMatch[2]);
        const subKey = Number(varsMatch[4]);
        let out = '';
        for (let i = 0; i < arr.length; i++) {
          out += String.fromCharCode(((arr[i] ^ xorKey) - subKey + 256) % 256);
        }

        const cfgMatch = out.match(/"ticketUrl":"([^"]+)"/);
        if (cfgMatch) {
          const ticketUrl = cfgMatch[1];
          const tRes = await fetch(ticketUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Referer: pageRes.url
            },
            signal: AbortSignal.timeout(10_000)
          });
          if (!tRes.ok) return null;

          const ab = await tRes.arrayBuffer();
          const tk = ticketUrl.substring(ticketUrl.lastIndexOf('/') + 1);
          const b = new Uint8Array(ab);
          if (b.length < 2) return null;

          const st = b[0];
          const outArr = new Uint8Array(b.length - 1);
          for (let i = 1; i < b.length; i++) {
            outArr[i - 1] = b[i] ^ tk.charCodeAt((i - 1) % tk.length) ^ ((st + i - 1) & 255);
          }
          const finalStreamUrl = new TextDecoder().decode(outArr);

          if (/^https?:\/\//i.test(finalStreamUrl)) {
            return {
              url: finalStreamUrl,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Referer: 'https://shoewiki.click/'
              }
            };
          }
        }
      }
    }
  } catch (err) {
    console.error('[resolver] shoewiki resolve error:', err);
  }
  return null;
}
