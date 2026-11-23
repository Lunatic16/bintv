/**
 * Minimal M3U text parser for bulk import (admin UI "paste an M3U").
 * Handles: #EXTM3U, #EXTINF attributes (tvg-id, tvg-name, tvg-logo, tvg-chno,
 * group-title), group-title from `#EXTGRP:`, comma display name, and the URL line.
 */

export interface ParsedM3uEntry {
  name: string;
  url: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  tvgChno?: number;
}

function parseAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

export function parseM3u(text: string): ParsedM3uEntry[] {
  const entries: ParsedM3uEntry[] = [];
  const lines = text.split(/\r?\n/);
  let pending: Partial<ParsedM3uEntry> | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toUpperCase().startsWith('#EXTM3U')) continue;
    if (line.toUpperCase().startsWith('#EXTINF')) {
      const commaIdx = line.indexOf(',');
      const attrPart = commaIdx >= 0 ? line.slice(0, commaIdx) : line;
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : 'Unnamed';
      const attrs = parseAttrs(attrPart);
      pending = {
        name,
        tvgId: attrs['tvg-id'] || undefined,
        logo: attrs['tvg-logo'] || undefined,
        group: attrs['group-title'] || undefined,
        tvgChno: attrs['tvg-chno'] && Number.isFinite(Number(attrs['tvg-chno'])) ? Number(attrs['tvg-chno']) : undefined
      };
      continue;
    }
    if (line.toUpperCase().startsWith('#EXTGRP:')) {
      if (pending) pending.group = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('#')) continue; // comments / other directives
    // URL line
    if (pending) {
      entries.push({
        name: pending.name || 'Unnamed',
        url: line,
        logo: pending.logo,
        group: pending.group,
        tvgId: pending.tvgId,
        tvgChno: pending.tvgChno
      });
      pending = null;
    } else {
      entries.push({ name: 'Unnamed', url: line });
    }
  }
  return entries;
}
