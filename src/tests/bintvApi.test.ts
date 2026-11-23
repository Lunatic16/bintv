import test from 'node:test';
import * as assert from 'node:assert';
import {
  guessCategory,
  guessChannelGroup,
  parseFeedDate,
  decodeBase64Url,
  extractUnderlyingStream
} from '../eventSources/bintvApi';
import { syncFeedData } from '../eventSources';
import { Channel, EventItem } from '../types';

test('guessCategory identifies sports correctly from titles or posters', () => {
  assert.strictEqual(guessCategory('UFC 309: Jones vs Miocic'), 'MMA / Boxing');
  assert.strictEqual(guessCategory('India vs Australia 1st Test'), 'Cricket');
  assert.strictEqual(guessCategory('Formula 1 Abu Dhabi Grand Prix'), 'Motorsport');
  assert.strictEqual(guessCategory('Kansas City Chiefs at Buffalo Bills'), 'American Football');
  assert.strictEqual(guessCategory('Boston Celtics vs Los Angeles Lakers'), 'Basketball');
  assert.strictEqual(guessCategory('Arsenal vs Chelsea'), 'Soccer');
  assert.strictEqual(guessCategory('Random Event', 'https://example.com/img/nfl-12345.png'), 'American Football');
  assert.strictEqual(guessCategory('Random Event', 'https://example.com/img/nba-98765.png'), 'NBA');
  assert.strictEqual(guessCategory('Random Event', 'https://example.com/img/nhl-44444.png'), 'Hockey');
});

test('guessChannelGroup categorizes channels into clean IPTV groups', () => {
  assert.strictEqual(guessChannelGroup('Sky Sports Main Event'), 'Sports');
  assert.strictEqual(guessChannelGroup('ESPN HD'), 'Sports');
  assert.strictEqual(guessChannelGroup('Fox Sports 1'), 'Sports');
  assert.strictEqual(guessChannelGroup('BBC News'), 'News');
  assert.strictEqual(guessChannelGroup('CNN International'), 'News');
  assert.strictEqual(guessChannelGroup('Cartoon Network'), 'Kids');
  assert.strictEqual(guessChannelGroup('Disney Channel'), 'Kids');
  assert.strictEqual(guessChannelGroup('HBO Signature'), 'Movies');
  assert.strictEqual(guessChannelGroup('Showtime East'), 'Movies');
  assert.strictEqual(guessChannelGroup('Animal Planet'), 'Documentary');
  assert.strictEqual(guessChannelGroup('Discovery Channel'), 'Documentary');
  assert.strictEqual(guessChannelGroup('MTV Live'), 'Music');
  assert.strictEqual(guessChannelGroup('ABC'), 'Entertainment');
});

test('parseFeedDate parses various formats and handles null dates', () => {
  const formatted = parseFeedDate('2026-11-22 18:00 UTC', true);
  assert.strictEqual(formatted, '2026-11-22T18:00:00.000Z');

  const iso = parseFeedDate('2026-11-25T14:30:00Z', false);
  assert.strictEqual(iso, '2026-11-25T14:30:00.000Z');

  const nullLive = parseFeedDate(null, true);
  const now = Date.now();
  const parsedMs = new Date(nullLive).getTime();
  // Should be anchored approximately 15 minutes in the past
  assert.ok(Math.abs(now - 15 * 60 * 1000 - parsedMs) < 5000);
});

test('decodeBase64Url handles standard and url-safe base64', () => {
  assert.strictEqual(decodeBase64Url('aHR0cHM6Ly9leGFtcGxlLmNvbQ'), 'https://example.com');
  assert.strictEqual(decodeBase64Url('aHR0cHM6Ly9zaG9ld2lraS5jbGljay9iaW50di84bnVtM2FmaC04MjA0'), 'https://shoewiki.click/bintv/8num3afh-8204');
});

test('extractUnderlyingStream resolves direct stream URLs from wrapper embeds', () => {
  const nodelayUrl = 'https://bintv-sources.pages.dev/?id=aHR0cHM6Ly9hcGkuYmludHYubGluay9ub2RlbGF5L3BsYXllci9hSFIwY0hNNkx5OXNhWFpsTURVdWVXVm1jSGR0WXk1aGNIQXZiR2wyWlM4d01qUTFOamsyTmw5MGMyTXViVE4xT0E';
  const extracted = extractUnderlyingStream(nodelayUrl);
  assert.strictEqual(extracted, 'https://live05.yefpwmc.app/live/02456966_tsc.m3u8');

  const directM3u8 = 'https://example.com/live/stream.m3u8';
  assert.strictEqual(extractUnderlyingStream(directM3u8), directM3u8);
});

test('syncFeedData preserves manual channels and manual events', async () => {
  const manualChannel: Channel = {
    id: 'my-custom-ch',
    number: 1,
    name: 'My Custom Channel',
    streamUrl: 'https://example.com/test.m3u8',
    group: 'Custom',
    enabled: true
  };

  const manualEvent: EventItem = {
    id: 'my-custom-ev',
    title: 'My Custom Event',
    category: 'Custom',
    startTime: new Date().toISOString(),
    sources: [{ label: 'Source 1', url: 'https://example.com/ev.m3u8' }],
    enabled: true
  };

  const result = await syncFeedData('https://api.bintv.link/api/public/bintvjson', [manualChannel], [manualEvent]);

  assert.strictEqual(result.error, undefined);
  assert.ok(result.importedChannels > 100);
  assert.ok(result.importedEvents > 10);

  // Check manual channel is still present
  const foundCh = result.channels.find((c) => c.id === 'my-custom-ch');
  assert.ok(foundCh);
  assert.strictEqual(foundCh.number, 1);

  // Check manual event is still present
  const foundEv = result.events.find((e) => e.id === 'my-custom-ev');
  assert.ok(foundEv);
});
