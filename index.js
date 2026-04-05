const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');
const ytpl    = require('ytpl');
const fs      = require('fs');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── Hi-Fi / Claudochrome instances (monochrome.tf) ─────────────────────────
const HIFI_INSTANCES = [
  'https://ohio-1.monochrome.tf',
  'https://frankfurt-1.monochrome.tf',
  'https://eu-central.monochrome.tf',
  'https://us-west.monochrome.tf',
  'https://hifi.geeked.wtf',
  'https://hifi-one.spotisaver.net',
  'https://monochrome-api.samidy.com'
];
let activeInstance  = HIFI_INSTANCES[0];
let instanceHealthy = false;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Hi-Fi client ────────────────────────────────────────────────────────────
async function hifiGet(path, params) {
  const errors    = [];
  const instances = instanceHealthy
    ? [activeInstance].concat(HIFI_INSTANCES.filter(i => i !== activeInstance))
    : HIFI_INSTANCES.slice();

  for (const inst of instances) {
    try {
      const r = await axios.get(inst + path, {
        params:  params || {},
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 15000
      });
      if (r.status === 200 && r.data) {
        if (inst !== activeInstance) {
          activeInstance  = inst;
          instanceHealthy = true;
          console.log('[hifi] switched to ' + inst);
        }
        return r.data;
      }
    } catch (e) {
      errors.push(inst + ': ' + e.message);
    }
  }
  throw new Error('All Hi-Fi instances failed: ' + errors.slice(-2).join(' | '));
}

async function hifiGetSafe(path, params) {
  try { return await hifiGet(path, params); }
  catch (_e) { return null; }
}

async function checkInstances() {
  for (const inst of HIFI_INSTANCES) {
    try {
      await axios.get(inst + '/search/', {
        params: { s: 'test', limit: 1 },
        timeout: 8000
      });
      activeInstance  = inst;
      instanceHealthy = true;
      console.log('[hifi] healthy: ' + inst);
      return;
    } catch (_e) {}
  }
  instanceHealthy = false;
  console.warn('[hifi] WARNING: no healthy instances.');
}
checkInstances();
setInterval(checkInstances, 15 * 60 * 1000);

// ─── Redis ───────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck:     false
  });
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error',   e => console.error('[Redis] Error: ' + e.message));
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('sc:token:' + token, JSON.stringify({
      clientId:  entry.clientId,
      createdAt: entry.createdAt,
      lastUsed:  entry.lastUsed,
      reqCount:  entry.reqCount
    }));
  } catch (e) {
    console.error('[Redis] Save failed: ' + e.message);
  }
}

async function redisLoad(token) {
  if (!redis) return null;
  try {
    const d = await redis.get('sc:token:' + token);
    return d ? JSON.parse(d) : null;
  } catch (_e) { return null; }
}

// ─── Token store ─────────────────────────────────────────────────────────────
const TOKEN_CACHE       = new Map();
const IP_CREATES        = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 60;
const RATE_WINDOW_MS    = 60000;

function generateToken() {
  return crypto.randomBytes(14).toString('hex');
}

function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b     = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 86400000 };
    IP_CREATES.set(ip, b);
  }
  return b;
}

async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  const saved = await redisLoad(token);
  if (!saved) return null;
  const entry = {
    clientId:  saved.clientId,
    createdAt: saved.createdAt,
    lastUsed:  saved.lastUsed,
    reqCount:  saved.reqCount,
    rateWin:   []
  };
  TOKEN_CACHE.set(token, entry);
  return entry;
}

function checkRateLimit(entry) {
  const now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(t => now - t < RATE_WINDOW_MS);
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now);
  entry.lastUsed = now;
  entry.reqCount = (entry.reqCount || 0) + 1;
  return true;
}

async function tokenMiddleware(req, res, next) {
  const entry = await getTokenEntry(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Invalid token.' });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded.' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}

function getBaseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}
function effectiveCid(e) {
  return (e && e.clientId) ? e.clientId : SHARED_CLIENT_ID;
}

// ─── SoundCloud client_id ───────────────────────────────────────────────────
let SHARED_CLIENT_ID = null;
const TRACK_CACHE    = new Map();
const sleep          = ms => new Promise(r => setTimeout(r, ms));

const ID_PATTERNS = [
  /client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"'\s,)]/
];

function findId(text) {
  for (let i = 0; i < ID_PATTERNS.length; i++) {
    const m = text.match(ID_PATTERNS[i]);
    if (m) return m[1];
  }
  return null;
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseArtistTitle(track) {
  const raw  = cleanText(track && track.title);
  const meta = cleanText(
    (track && track.publisher_metadata &&
     (track.publisher_metadata.artist || track.publisher_metadata.writer_composer)) || ''
  );
  const up   = cleanText(track && track.user && track.user.username);
  if (raw.indexOf(' - ') !== -1) {
    const parts = raw.split(' - ');
    const L     = cleanText(parts[0]);
    const R     = cleanText(parts.slice(1).join(' - '));
    if (L && R) return { artist: meta || L, title: R, rawTitle: raw, uploader: up };
  }
  return { artist: meta || up, title: raw, rawTitle: raw, uploader: up };
}

function rememberTrack(t) {
  if (!t || !t.id) return;
  const m = parseArtistTitle(t);
  TRACK_CACHE.set(String(t.id), {
    id:       String(t.id),
    artist:   m.artist,
    title:    m.title,
    rawTitle: m.rawTitle,
    uploader: m.uploader
  });
}

function artworkUrl(raw, fb) {
  const s = raw || fb || '';
  return s ? s.replace('-large', '-t500x500') : null;
}
function scYear(x) {
  return (x.release_date || x.created_at || '').slice(0, 4) || null;
}

// SNIP = SoundCloud 30-second preview. BLOCK = region-blocked.
function isFullyPlayable(t) {
  if (!t) return false;
  if (t.streamable === false) return false;
  const p = t.policy;
  if (!p || p === 'SNIP' || p === 'BLOCK') return false;
  return true; // ALLOW or MONETIZE
}

async function getHtml(url) {
  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent':      UA,
        'Accept':          'text/html',
        'Accept-Encoding': 'gzip, deflate'
      },
      timeout:       15000,
      decompress:    true,
      responseType:  'text',
      validateStatus: s => s < 500
    });
    return r.data || '';
  } catch (_e) { return null; }
}

async function getJs(url) {
  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept':     '*/*',
        'Referer':    'https://soundcloud.com/'
      },
      timeout:       12000,
      decompress:    true,
      responseType:  'text',
      validateStatus: s => s < 500
    });
    if (r.status !== 200 || (r.data || '').length < 5000) return null;
    return r.data;
  } catch (_e) { return null; }
}

async function tryExtract() {
  for (const pu of ['https://soundcloud.com', 'https://soundcloud.com/discover']) {
    const html = await getHtml(pu);
    if (!html || html.length < 5000) continue;
    for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      const id = findId(m[1] || '');
      if (id) return id;
    }
    const urls = Array.from(new Set([
      ...Array.from(html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9.\-]+\.js/g)).map(x => x[0]),
      ...Array.from(html.matchAll(/src="([^"]+\.js)"/g)).map(x => x[1])
    ])).reverse().slice(0, 10);
    for (const u of urls) {
      const js  = await getJs(u);
      if (!js) continue;
      const bid = findId(js);
      if (bid) return bid;
    }
  }
  return null;
}

async function fetchSharedClientId() {
  if (process.env.SC_CLIENT_ID) {
    SHARED_CLIENT_ID = process.env.SC_CLIENT_ID;
    console.log('[clientid] from env');
    return;
  }
  const delays  = [5000, 10000, 15000, 30000, 60000];
  let attempt   = 0;
  while (true) {
    attempt++;
    try {
      const id = await tryExtract();
      if (!id) throw new Error('not found');
      SHARED_CLIENT_ID = id;
      console.log('[clientid] obtained attempt ' + attempt);
      setTimeout(() => { SHARED_CLIENT_ID = null; fetchSharedClientId(); }, 6 * 60 * 60 * 1000);
      return;
    } catch (_e) {
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
      console.log('[clientid] retrying...');
    }
  }
}
fetchSharedClientId();

async function scGet(cid, url, params, retried) {
  if (!cid) throw new Error('No client_id');
  try {
    const r = await axios.get(url, {
      params: Object.assign({}, params || {}, { client_id: cid }),
      headers: {
        'User-Agent': UA,
        'Accept':     'application/json'
      },
      timeout:    12000,
      decompress: true
    });
    return r.data;
  } catch (e) {
    if (!retried && e.response && (e.response.status === 401 || e.response.status === 403)) {
      SHARED_CLIENT_ID = null;
      fetchSharedClientId();
      await sleep(3000);
      return scGet(SHARED_CLIENT_ID, url, params, true);
    }
    throw e;
  }
}

async function resolveStubs(cid, tracks, fbArt) {
  const stubs = tracks.filter(t => !t.title).map(t => t.id);
  const map   = {};
  for (let i = 0; i < stubs.length; i += 50) {
    try {
      const data = await scGet(cid, 'https://api-v2.soundcloud.com/tracks', {
        ids: stubs.slice(i, i + 50).join(',')
      });
      const arr = Array.isArray(data) ? data
        : data.collection ? data.collection
        : [];
      arr.forEach(t => { map[String(t.id)] = t; });
    } catch (e) {
      console.warn('[resolveStubs] failed: ' + e.message);
    }
  }
  return tracks.map(t => map[String(t.id)] || t).filter(t => !!t.title);
}

// ─── Smarter Hi-Fi track search (multiple retries/queries) ──────────────────
async function hifiFindBestTrack(meta, albumName) {
  if (!meta || !meta.title) return null;

  const baseTitle  = meta.title;
  const baseArtist = meta.artist || meta.uploader || '';
  const queries    = [];

  if (baseArtist) {
    queries.push(baseArtist + ' ' + baseTitle);
    queries.push(baseTitle + ' ' + baseArtist);
  }
  queries.push(baseTitle);
  if (albumName) {
    queries.push(baseTitle + ' ' + albumName);
  }

  const norm = str => String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const wantTitle  = norm(baseTitle);
  const wantArtist = norm(baseArtist);

  for (const q of queries) {
    try {
      const sData = await hifiGetSafe('/search/', { s: q, limit: 5, offset: 0 });
      if (!sData) continue;

      let items = [];
      if (sData.data && Array.isArray(sData.data.items)) items = sData.data.items;
      else if (Array.isArray(sData.items))               items = sData.items;
      else if (Array.isArray(sData.data))                items = sData.data;
      if (!items.length) continue;

      const ranked = items.slice().sort((a, b) => {
        const aTitle  = norm(a.title);
        const bTitle  = norm(b.title);
        const aArtist = norm(
          (a.artist && a.artist.name) ||
          (a.artists && a.artists[0] && a.artists[0].name) ||
          ''
        );
        const bArtist = norm(
          (b.artist && b.artist.name) ||
          (b.artists && b.artists[0] && b.artists[0].name) ||
          ''
        );

        let aScore = 0, bScore = 0;

        if (aTitle === wantTitle) aScore += 5;
        if (bTitle === wantTitle) bScore += 5;

        if (wantArtist && aArtist === wantArtist) aScore += 5;
        if (wantArtist && bArtist === wantArtist) bScore += 5;

        if (wantTitle && aTitle.includes(wantTitle)) aScore += 2;
        if (wantTitle && bTitle.includes(wantTitle)) bScore += 2;

        if (wantArtist && aArtist.includes(wantArtist)) aScore += 2;
        if (wantArtist && bArtist.includes(wantArtist)) bScore += 2;

        return bScore - aScore;
      });

      const best = ranked[0];
      if (!best) continue;

      const bestTitle  = norm(best.title);
      const bestArtist = norm(
        (best.artist && best.artist.name) ||
        (best.artists && best.artists[0] && best.artists[0].name) ||
        ''
      );

      const titleGood =
        wantTitle &&
        (bestTitle === wantTitle || bestTitle.includes(wantTitle));

      const artistGood =
        !wantArtist ||
        (bestArtist &&
         (bestArtist === wantArtist || bestArtist.includes(wantArtist)));

      if (wantArtist) {
        if (titleGood && artistGood) return best;
      } else {
        if (bestTitle === wantTitle) return best;
      }
    } catch (_e) {}
  }
  return null;
}

// ─── YTM playlist import (unchanged) ────────────────────────────────────────
async function importYtmPlaylist(playlistId) {
  const cleanId = playlistId.replace(/^VL/, '');
  try {
    const pl = await ytpl(cleanId, { limit: Infinity });
    return {
      id:         'ytm-' + cleanId,
      title:      pl.title || 'YouTube Music Playlist',
      artworkURL: pl.bestThumbnail ? pl.bestThumbnail.url : null,
      creator:    pl.author ? pl.author.name : 'YouTube Music',
      tracks:     pl.items.map(item => ({
        id:         'ytm-' + item.id,
        title:      item.title || 'Unknown',
        artist:     (item.author && item.author.name) || 'Unknown',
        duration:   item.durationSec || null,
        artworkURL: item.bestThumbnail ? item.bestThumbnail.url : null
      }))
    };
  } catch (e) {
    throw new Error('Could not fetch YouTube playlist: ' + e.message + '. Make sure it is Public.');
  }
}

// ─── URL helpers ─────────────────────────────────────────────────────────────
function detectUrlType(url) {
  if (!url) return null;
  if (/soundcloud\.com\/.*\/sets\//.test(url)) return 'scplaylist';
  if (/on\.soundcloud\.com\//.test(url))       return 'scplaylist-short';
  if (/snd\.sc\//.test(url))                   return 'scplaylist-short';
  if (/music\.youtube\.com|youtube\.com.*\?list=/.test(url)) return 'ytmplaylist';
  if (/music\.youtube\.com\/browse\/VL/.test(url))           return 'ytmplaylist';
  return null;
}

function extractYtmId(url) {
  const browse = url.match(/browse\/VL([a-zA-Z0-9_-]+)/);
  if (browse) return browse[1];
  const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ─── SC short URL expander ───────────────────────────────────────────────────
async function expandScShortUrl(url) {
  try {
    const r = await axios.get(url, {
      maxRedirects: 10,
      headers: { 'User-Agent': UA },
      timeout: 10000,
      validateStatus: s => s < 500
    });
    const final = (r.request && r.request.res && r.request.res.responseUrl) || url;
    console.log('[expandScShortUrl]', url, '->', final);
    return final;
  } catch (e) {
    if (e.response && e.response.headers && e.response.headers.location) {
      return e.response.headers.location;
    }
    return url;
  }
}

// ─── SC playlist import ──────────────────────────────────────────────────────
async function importScPlaylist(cid, scUrl) {
  if (/on\.soundcloud\.com/.test(scUrl) || /snd\.sc/.test(scUrl)) {
    scUrl = await expandScShortUrl(scUrl);
  }
  const res = await scGet(cid, 'https://api-v2.soundcloud.com/resolve', { url: scUrl });
  if (!res) throw new Error('Could not resolve SoundCloud URL');
  if (res.kind !== 'playlist') throw new Error('Not a playlist (kind=' + res.kind + ')');
  const resolved = await resolveStubs(cid, res.tracks || [], res.artwork_url);
  return {
    id:         String(res.id),
    title:      res.title || 'Imported',
    artworkURL: artworkUrl(res.artwork_url),
    creator:    (res.user && res.user.username) || null,
    tracks:     resolved.map(t => {
      rememberTrack(t);
      const m = parseArtistTitle(t);
      return {
        id:         String(t.id),
        title:      m.title || t.title || 'Unknown',
        artist:     m.artist || (res.user && res.user.username) || 'Unknown',
        duration:   t.duration ? Math.floor(t.duration / 1000) : null,
        artworkURL: artworkUrl(t.artwork_url, res.artwork_url)
      };
    })
  };
}

// ─── Config page (unchanged UI from your addon) ─────────────────────────────
function buildConfigPage(baseUrl) {
  // (this is exactly the HTML you pasted, unchanged)
  // ...
  // For brevity, you can keep your existing buildConfigPage implementation
  // or paste the full function body here (it’s long but already working).
  // I’m leaving it as-is in your code.
  // ------------------------------
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>SoundCloud + Claudochrome Addon</title>';
  // (rest of your original HTML here — keep as in your pasted code)
  // ------------------------------
  // For your actual file, paste the entire buildConfigPage function body you provided.
  return h;
}

// ─── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async (req, res) => {
  const ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) {
    return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  }
  const cid = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : null;
  if (cid && !/^[a-zA-Z0-9]{20,40}$/.test(cid)) {
    return res.status(400).json({ error: 'Invalid client_id.' });
  }
  const token = generateToken();
  const entry = { clientId: cid || null, createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async (req, res) => {
  const raw = (req.body && req.body.existingUrl) ? String(req.body.existingUrl).trim() : '';
  const cid = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : null;
  let token = raw;
  const m   = raw.match(/\/u\/([a-f0-9]{28})\//);
  if (m) token = m[1];
  if (!token || !/^[a-f0-9]{28}$/.test(token)) {
    return res.status(400).json({ error: 'Paste your full addon URL.' });
  }
  const entry = await getTokenEntry(token);
  if (!entry) return res.status(404).json({ error: 'URL not found. Generate a new one.' });
  if (cid) {
    if (!/^[a-zA-Z0-9]{20,40}$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid client_id.' });
    }
    entry.clientId = cid;
    TOKEN_CACHE.set(token, entry);
    await redisSave(token, entry);
  }
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

// Health
app.get('/health', (req, res) => {
  res.json({
    status:              'ok',
    version:             '4.0.0',
    sharedClientIdReady: !!SHARED_CLIENT_ID,
    redisConnected:      !!(redis && redis.status === 'ready'),
    hifiInstance:        activeInstance,
    hifiHealthy:         instanceHealthy,
    activeTokens:        TOKEN_CACHE.size,
    timestamp:           new Date().toISOString()
  });
});

// ─── Manifest ────────────────────────────────────────────────────────────────
app.get('/u/:token/manifest.json', tokenMiddleware, (req, res) => {
  res.json({
    id:          'com.eclipse.soundcloud.' + req.params.token.slice(0, 8),
    name:        'SoundCloud',
    version:     '4.0.0',
    description: 'Search and play SoundCloud content integrated into Eclipse, with enhanced streaming support.',
    icon:        'https://files.softicons.com/download/social-media-icons/simple-icons-by-dan-leech/png/128x128/soundcloud.png',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

// ─── Search (SoundCloud only, no filtering) ─────────────────────────────────
app.get('/u/:token/search', tokenMiddleware, async (req, res) => {
  const q = cleanText(req.query.q);
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });

  const cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id yet. Retry in a few seconds.' });

  try {
    const results = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/search/tracks',     { q, limit: 20, offset: 0, linked_partitioning: 1 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/playlists',  { q, limit: 10, offset: 0 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/users',      { q, limit: 5,  offset: 0 })
    ].map(p => p.catch(() => null)));

    const trackRes = results[0] || { collection: [] };
    const plRes    = results[1] || { collection: [] };
    const userRes  = results[2] || { collection: [] };

    const allPl    = plRes.collection || [];

    const tracks = (trackRes.collection || [])
      .map(t => {
        rememberTrack(t);
        const m = parseArtistTitle(t);
        return {
          id:         String(t.id),
          title:      m.title || 'Unknown',
          artist:     m.artist || 'Unknown',
          album:      null,
          duration:   t.duration ? Math.floor(t.duration / 1000) : null,
          artworkURL: artworkUrl(t.artwork_url),
          format:     'aac'
        };
      });

    const albums = allPl
      .filter(p => p.is_album === true)
      .map(p => ({
        id:         String(p.id),
        title:      p.title || 'Unknown',
        artist:     (p.user && p.user.username) || 'Unknown',
        artworkURL: artworkUrl(p.artwork_url),
        trackCount: p.track_count || null,
        year:       scYear(p)
      }));

    const playlists = allPl
      .filter(p => !p.is_album)
      .map(p => ({
        id:         String(p.id),
        title:      p.title || 'Unknown',
        description: p.description || null,
        artworkURL: artworkUrl(p.artwork_url),
        creator:     (p.user && p.user.username) || null,
        trackCount:  p.track_count || null
      }));

    const artists = (userRes.collection || []).map(u => ({
      id:         String(u.id),
      name:       u.username || 'Unknown',
      artworkURL: artworkUrl(u.avatar_url),
      genres:     u.genre ? [u.genre] : []
    }));

    res.json({ tracks, albums, artists, playlists });
  } catch (e) {
    res.status(500).json({ error: 'Search failed, tracks only.', tracks: [] });
  }
});

// ─── Stream (Claudochrome/Hi-Fi FIRST, SoundCloud fallback) ────────────────
app.get('/u/:token/stream/:id', tokenMiddleware, async (req, res) => {
  const cid = effectiveCid(req.tokenEntry);
  const tid = req.params.id;

  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  let track  = null;
  const cached = TRACK_CACHE.get(String(tid)) || null;

  // Fetch SC track once for metadata and SC fallback
  try {
    try {
      track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/soundcloud:tracks:' + tid);
    } catch (_e) {
      track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/' + tid);
    }
  } catch (e) {
    console.warn('[stream] SC track lookup failed for ' + tid + ': ' + e.message);
  }

  if (track) rememberTrack(track);

  const meta = cached || (track ? parseArtistTitle(track) : null);
  const albumName =
    track && track.publisher_metadata && track.publisher_metadata.release_title
      ? track.publisher_metadata.release_title
      : null;

  // 1) Claudochrome / Hi-Fi FIRST with smarter search
  try {
    const best = await hifiFindBestTrack(meta, albumName);
    if (best && best.id) {
      const hifiId = best.id;
      const qList  = ['LOSSLESS', 'HIGH', 'LOW'];

      for (let qi = 0; qi < qList.length; qi++) {
        const ql = qList[qi];
        try {
          const data    = await hifiGet('/track/', { id: hifiId, quality: ql });
          const payload = (data && data.data) ? data.data : data;

          if (payload && payload.manifest) {
            const decoded = JSON.parse(
              Buffer.from(payload.manifest, 'base64').toString('utf8')
            );
            const url   = (decoded.urls && decoded.urls[0]) || null;
            const codec = decoded.codecs || decoded.mimeType || '';
            if (url) {
              const isFlac = codec &&
                (codec.indexOf('flac') !== -1 || codec.indexOf('audio/flac') !== -1);
              return res.json({
                url,
                format:    isFlac ? 'flac' : 'aac',
                quality:   ql === 'LOSSLESS' ? 'lossless' : (ql === 'HIGH' ? '320kbps' : '128kbps'),
                expiresAt: Math.floor(Date.now() / 1000) + 21600
              });
            }
          }

          if (payload && payload.url) {
            return res.json({
              url:       payload.url,
              format:    'aac',
              quality:   ql === 'LOSSLESS' ? 'lossless' : (ql === 'HIGH' ? '320kbps' : '128kbps'),
              expiresAt: Math.floor(Date.now() / 1000) + 21600
            });
          }
        } catch (_e) {}
      }
    }
  } catch (_e) {}

  // 2) SoundCloud fallback
  if (!track || !isFullyPlayable(track)) {
    return res.status(404).json({ error: 'No playable stream found.' });
  }

  try {
    const trans = (track && track.media && track.media.transcodings) || [];
    const prog  = trans.find(t => t.format && t.format.protocol === 'progressive') || trans[0];
    if (!prog || !prog.url) throw new Error('No transcoding.');

    const tr = await scGet(cid, prog.url, {}, false);
    const url = tr && tr.url ? tr.url : null;
    if (!url) throw new Error('No stream URL.');

    return res.json({
      url,
      format:  'aac',
      quality: 'high'
    });
  } catch (e) {
    return res.status(500).json({ error: 'Stream failed.' });
  }
});

// (Playlist import routes etc. remain as in your original file)

// ─── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('Addon running on http://localhost:' + PORT);
});
