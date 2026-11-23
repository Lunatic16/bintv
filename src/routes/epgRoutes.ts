/** XMLTV EPG routes generated on request: /epg/247.xml and /epg/events.xml */
import { Request, Response, Router } from 'express';
import { DATA_DIR, loadSettings } from '../config';
import { loadJson } from '../storage';
import { Channel, EventItem } from '../types';
import { generateChannelsEpg, generateEventsEpg, generateCombinedEpg } from '../epg';
import { requirePlaylistToken } from '../auth';

const router = Router();
// Guard EPG routes when PLAYLIST_TOKEN is configured (mounted at "/", so scope by path).
router.use(/^\/epg\//, requirePlaylistToken(loadSettings));

const XML_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': 'no-cache, no-store'
};

router.get('/epg/247.xml', (_req: Request, res: Response) => {
  const channels = loadJson<Channel[]>(`${DATA_DIR}/channels.json`, [], 'channels');
  res.set(XML_HEADERS);
  res.send(generateChannelsEpg(channels));
});

router.get('/epg/events.xml', (_req: Request, res: Response) => {
  const settings = loadSettings();
  const events = loadJson<EventItem[]>(`${DATA_DIR}/events.json`, [], 'events');
  res.set(XML_HEADERS);
  res.send(generateEventsEpg(events, settings));
});

// Combined EPG (24/7 channels + events) — referenced by /playlist.m3u so a
// single url-tvg covers every channel in the combined playlist.
router.get('/epg.xml', (_req: Request, res: Response) => {
  const settings = loadSettings();
  const channels = loadJson<Channel[]>(`${DATA_DIR}/channels.json`, [], 'channels');
  const events = loadJson<EventItem[]>(`${DATA_DIR}/events.json`, [], 'events');
  res.set(XML_HEADERS);
  res.send(generateCombinedEpg(channels, events, settings));
});

export default router;
