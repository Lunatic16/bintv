import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, passesStatusFilter, resolveEndMs } from '../eventStatus';
import { Channel, EventItem, Settings } from '../types';
import { generateChannelEntry, generateEventEntry, formatLocalTime, sortChannels, compareEvents, placeholderEntry } from '../playlists';

const settings = { preStartMinutes: 10, postEndGraceMinutes: 15 };

function mkEvent(overrides: Partial<EventItem> = {}): EventItem {
  return {
    id: 'ev-1',
    title: 'Arsenal vs Chelsea',
    category: 'Football',
    startTime: '2025-06-01T19:30:00Z',
    sources: [{ label: 'Source 1', url: 'https://example.com/s1.m3u8' }],
    enabled: true,
    ...overrides
  };
}

test('event before pre-start window is upcoming', () => {
  // start 19:30, preStart 10 -> live from 19:20
  const now = Date.parse('2025-06-01T19:19:59Z');
  assert.equal(computeStatus(mkEvent(), now, settings).status, 'upcoming');
});

test('event exactly at liveFrom boundary is live', () => {
  const now = Date.parse('2025-06-01T19:20:00Z');
  assert.equal(computeStatus(mkEvent(), now, settings).status, 'live');
});

test('event after start but before end is live', () => {
  const now = Date.parse('2025-06-01T20:00:00Z');
  assert.equal(computeStatus(mkEvent(), now, settings).status, 'live');
});

test('event within post-end grace is live', () => {
  // endTime 21:30 + 15 min grace -> live until 21:45
  const ev = mkEvent({ endTime: '2025-06-01T21:30:00Z' });
  const now = Date.parse('2025-06-01T21:44:59Z');
  assert.equal(computeStatus(ev, now, settings).status, 'live');
});

test('event at grace boundary is ended', () => {
  const ev = mkEvent({ endTime: '2025-06-01T21:30:00Z' });
  const now = Date.parse('2025-06-01T21:45:00Z');
  assert.equal(computeStatus(ev, now, settings).status, 'ended');
});

test('durationMinutes derives endTime when endTime absent', () => {
  const ev = mkEvent({ durationMinutes: 90 });
  assert.equal(resolveEndMs(ev), Date.parse('2025-06-01T21:00:00Z'));
});

test('default duration is 120 minutes', () => {
  const ev = mkEvent();
  assert.equal(resolveEndMs(ev), Date.parse('2025-06-01T21:30:00Z'));
});

test('endTime wins over durationMinutes', () => {
  const ev = mkEvent({ endTime: '2025-06-01T22:00:00Z', durationMinutes: 30 });
  assert.equal(resolveEndMs(ev), Date.parse('2025-06-01T22:00:00Z'));
});

test('status filter: default includes live and upcoming within lookahead', () => {
  const now = Date.parse('2025-06-01T12:00:00Z');
  const soon = computeStatus(mkEvent({ id: 'soon', startTime: '2025-06-01T17:00:00Z' }), now, settings); // within 6h
  const far = computeStatus(mkEvent({ id: 'x', startTime: '2025-06-03T10:00:00Z' }), now, settings);
  assert.equal(passesStatusFilter(soon, { lookaheadHours: 6, nowMs: now }), true);
  assert.equal(passesStatusFilter(far, { lookaheadHours: 6, nowMs: now }), false);
  assert.equal(passesStatusFilter(far, { lookaheadHours: 48, nowMs: now }), true);
});

test('status filter: live excludes upcoming', () => {
  const now = Date.parse('2025-06-01T19:00:00Z');
  const info = computeStatus(mkEvent(), now, settings);
  assert.equal(info.status, 'upcoming');
  assert.equal(passesStatusFilter(info, { status: 'live', lookaheadHours: 6, nowMs: now }), false);
});

test('status filter: all includes ended', () => {
  const now = Date.parse('2025-06-01T23:00:00Z');
  const info = computeStatus(mkEvent(), now, settings);
  assert.equal(info.status, 'ended');
  assert.equal(passesStatusFilter(info, { status: 'all', lookaheadHours: 6, nowMs: now }), true);
});

test('display name: LIVE marker for live, HH:mm for upcoming', () => {
  const live = computeStatus(mkEvent(), Date.parse('2025-06-01T20:00:00Z'), settings);
  const ev = mkEvent();
  assert.equal(generateEventEntry(ev, live, 'http://x', 'UTC').includes(',LIVE | Arsenal vs Chelsea'), true);

  const upcoming = computeStatus(mkEvent(), Date.parse('2025-06-01T12:00:00Z'), settings);
  assert.equal(generateEventEntry(ev, upcoming, 'http://x', 'UTC').includes(',19:30 | Arsenal vs Chelsea'), true);
});

test('local time formatting respects timezone', () => {
  const ms = Date.parse('2025-06-01T19:30:00Z');
  assert.equal(formatLocalTime(ms, 'America/Cayman'), '14:30'); // EST in June? no: CAYMAN is EST year-round (UTC-5)
});

test('channel entry attributes and ordering', () => {
  const channels: Channel[] = [
    { id: 'c2', number: 2, name: 'B Channel', streamUrl: 'http://b', group: 'News', enabled: true },
    { id: 'c1', number: 1, name: 'A Channel', streamUrl: 'http://a', group: 'Movies', logo: 'http://logo.png', enabled: true }
  ];
  const sorted = sortChannels(channels);
  assert.equal(sorted[0].name, 'A Channel');
  const entry = generateChannelEntry(sorted[0], 'http://a');
  assert.equal(entry.includes('tvg-chno="1"'), true);
  assert.equal(entry.includes('group-title="Movies"'), true);
  assert.equal(entry.includes('tvg-logo="http://logo.png"'), true);
  assert.ok(entry.endsWith(',A Channel\nhttp://a'));
});

test('sort comparator puts live before upcoming', () => {
  const live = { info: computeStatus(mkEvent(), Date.parse('2025-06-01T20:00:00Z'), settings) };
  const upcoming = { info: computeStatus(mkEvent({ id: 'x', startTime: '2025-06-02T19:30:00Z' }), Date.parse('2025-06-01T20:00:00Z'), settings) };
  assert.equal(compareEvents(live, upcoming) < 0, true);
  assert.equal(compareEvents(upcoming, live) > 0, true);
});

test('placeholder entry is a valid two-line EXTINF block', () => {
  const lines = placeholderEntry('http://host/').split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^#EXTINF:-1 .*,No live events right now$/);
  assert.equal(lines[1], 'http://host/');
});
