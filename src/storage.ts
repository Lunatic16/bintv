/**
 * Tiny JSON-file persistence layer.
 * - Every write is atomic (tmp file + rename) so a crash never leaves a torn file.
 * - A missing file simply yields the fallback value.
 * - A corrupt file is backed up as `<name>.corrupt-<timestamp>` and recreated,
 *   so one bad edit can never take the server down.
 */
import * as fs from 'fs';
import * as path from 'path';

export function loadJson<T>(file: string, fallback: T, label: string): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      console.error(`[${label}] corrupt file backed up to ${backup}:`, err);
    } catch (e) {
      console.error(`[${label}] failed to back up corrupt file:`, e);
    }
    try {
      saveJson(file, fallback, label);
    } catch (e) {
      console.error(`[${label}] failed to recreate file:`, e);
    }
    return fallback;
  }
}

export function saveJson<T>(file: string, value: T, label: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** Generates a URL-safe slug from arbitrary text, e.g. "Arsenal vs Chelsea" -> "arsenal-vs-chelsea". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

/** Ensures `id` is unique within `existing`, appending -2, -3, ... if needed. */
export function uniqueSlug(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
