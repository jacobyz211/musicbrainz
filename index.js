import express  from 'express';
import cors     from 'cors';
import bcfetch  from 'bandcamp-fetch';
import PQueue   from 'p-queue';
import Redis    from 'ioredis';
import axios    from 'axios';
import { randomBytes } from 'crypto';

// ─── Base setup ───────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Hi-Fi / Claudochrome instances (monochrome.tf) ──────────────────────────
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

async function hifiGet(basePath, params) {
  const errors    = [];
  const instances = instanceHealthy
    ? [activeInstance].concat(HIFI_INSTANCES.filter(i => i !== activeInstance))
    : HIFI_INSTANCES.slice();

  for (const inst of instances) {
    try {
      const r = await axios.get(inst + basePath, {
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
  catch { return null; }
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
    } catch {}
  }
  instanceHealthy = false;
  console.warn('[hifi] WARNING: no healthy Hi-Fi instances.');
}
checkInstances();
setInterval(checkInstances, 15 * 60 * 1000);

// ─── Redis ────────────────────────────────────────────────────────────────────
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false })
  : null;

if (redis) {
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error',   e  => console.error('[Redis] Error:', e.message));
}

async function rGet(key) {
  if (!redis) return null;
  try { const v = await redis.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function rSet(key, value) {
  if (!redis) return;
  try { await redis.set(key, JSON.stringify(value)); } catch (e) { console.error('[Redis] rSet:', e.message); }
}
async function rAppend(key, item) {
  if (!redis) return;
  try { await redis.rpush(key, JSON.stringify(item)); } catch (e) { console.error('[Redis] rAppend:', e.message); }
}
async function rList(key) {
  if (!redis) return [];
  try {
    const items = await redis.lrange(key, 0, -1);
    return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
async function rDel(key) {
  if (!redis) return;
  try { await redis.del(key); } catch {}
}

// ─── In-memory stores ─────────────────────────────────────────────────────────
// meta: { createdAt, searches, streams, lastUsed, soundcloudClientId?, migratedAt? }
const tokens       = new Map();
const trackHistory = new Map();

// shared SoundCloud client_id (auto-scraped, like your SC addon)
let SHARED_CLIENT_ID = process.env.SC_CLIENT_ID || null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateToken() { return randomBytes(16).toString('hex'); }

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

async function tokenMiddleware(req, res, next) {
  const { token } = req.params;
  if (!tokens.has(token)) {
    const saved = await rGet(`bc:token:${token}`);
    if (!saved) return res.status(403).json({ error: 'Invalid token — generate a URL at the addon homepage.' });
    tokens.set(token, { searches: 0, streams: 0, ...saved });
    console.log(`[token] restored ${token.slice(0, 8)}... from Redis`);
  }
  next();
}

async function logTrack(token, track) {
  if (!trackHistory.has(token)) trackHistory.set(token, []);
  const h = trackHistory.get(token);
  if (!h.some(x => x.id === track.id)) {
    const entry = {
      id: track.id, title: track.title || '', artist: track.artist || '',
      album: track.album || '', isrc: track.isrc || '', format: track.format || 'mp3',
      timestamp: new Date().toISOString()
    };
    h.push(entry);
    await rAppend(`bc:history:${token}`, entry);
  }
}

// ─── MusicBrainz ──────────────────────────────────────────────────────────────
const mbQueue   = new PQueue({ intervalCap: 1, interval: 1100 });
const MB_UA     = 'BandcampEclipseAddon/1.0.0 (you@example.com)';
const isrcCache = new Map();

async function mbGet(path) {
  const r = await fetch(`https://musicbrainz.org/ws/2${path}`, {
    headers: { 'User-Agent': MB_UA, 'Accept': 'application/json' }
  });
  if (!r.ok) return null;
  return r.json();
}

async function lookupISRC(title, artist) {
  const key = `${title.toLowerCase()}::${artist.toLowerCase()}`;
  if (isrcCache.has(key)) return isrcCache.get(key);
  const searchData = await mbQueue.add(() => {
    const q = `recording:"${title.replace(/"/g,'')}" AND artist:"${artist.replace(/"/g,'')}"`;
    return mbGet(`/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=1`);
  });
  const mbid = searchData?.recordings?.[0]?.id;
  if (!mbid) { isrcCache.set(key, null); return null; }
  const lookupData = await mbQueue.add(() => mbGet(`/recording/${mbid}?inc=isrcs&fmt=json`));
  const isrc = lookupData?.isrcs?.[0] ?? null;
  isrcCache.set(key, isrc);
  return isrc;
}

async function mbSearchRecordings(query, limit = 20) {
  const q = query.trim();
  if (!q) return [];
  const path = `/recording?query=${encodeURIComponent(q)}&fmt=json&limit=${limit}`;
  const data = await mbQueue.add(() => mbGet(path));
  return data?.recordings || [];
}

// ─── Bandcamp mappers + ID wrappers ──────────────────────────────────────────
const encodeId = url => Buffer.from(url ?? '').toString('base64url');
const decodeId = id => { try { return Buffer.from(id, 'base64url').toString('utf8'); } catch { return ''; } };

const encodeMbId = mbid => `mb:${mbid}`;
const encodeScId = scId => `sc:${scId}`;
const encodeBcId = url  => `bc:${encodeId(url)}`;

const mapTrack = (t, fallbackArtist) => ({
  id:         encodeBcId(t.url),
  title:      t.name,
  artist:     t.artist?.name || t.publisher?.name || t.publisher_metadata?.artist || fallbackArtist || 'Unknown',
  album:      t.album?.name,
  duration:   t.duration ? Math.floor(t.duration) : undefined,
  artworkURL: t.imageUrl,
  streamURL:  t.streamUrl || undefined,
  format:     'mp3'
});

const mapAlbum = a => ({
  id:         encodeId(a.url),
  title:      a.name,
  artist:     a.artist?.name || 'Unknown',
  artworkURL: a.imageUrl,
  trackCount: a.numTracks || undefined,
  year:       a.releaseDate ? String(new Date(a.releaseDate).getFullYear()) : undefined
});

const mapArtist = a => ({
  id:         encodeId(a.url),
  name:       a.name || 'Unknown',
  artworkURL: a.imageUrl || null
});

const mapMbRecordingToTrack = rec => {
  const title  = rec.title || '';
  const artist = (rec['artist-credit']?.map(ac => ac.name).join(', ')) || 'Unknown';
  const isrc   = (rec.isrcs && rec.isrcs[0]) || null;
  const durMs  = rec.length || null;
  return {
    id:         encodeMbId(rec.id),
    title,
    artist,
    album:      rec['release-group']?.title || null,
    duration:   durMs ? Math.round(durMs / 1000) : undefined,
    artworkURL: null,
    streamURL:  null,
    format:     'flac',
    isrc
  };
};

async function enrichTracks(tracks, timeoutMs = 4500) {
  const deadline = Date.now() + timeoutMs;
  return Promise.all(tracks.map(async track => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return track;
    const isrc = await Promise.race([
      lookupISRC(track.title, track.artist),
      new Promise(r => setTimeout(() => r(null), remaining))
    ]);
    return isrc ? { ...track, isrc } : track;
  }));
}

// ─── SoundCloud client_id and helpers (ported from your SC addon) ────────────
const ID_PATTERNS = [
  /client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /client_id=([a-zA-Z0-9]{32})[&"'\s,)]/
];

const TRACK_CACHE = new Map();
const sleep      = ms => new Promise(r => setTimeout(r, ms));

function findId(text) {
  for (const re of ID_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}
function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

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
  } catch { return null; }
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
  } catch { return null; }
}

async function tryExtractClientId() {
  for (const pu of ['https://soundcloud.com', 'https://soundcloud.com/discover']) {
    const html = await getHtml(pu);
    if (!html || html.length < 5000) continue;

    // inline scripts
    for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      const id = findId(m[1] || '');
      if (id) return id;
    }

    // JS assets
    const urls = Array.from(new Set([
      ...Array.from(html.matchAll(/https?:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9.\-]+\.js/g)).map(x => x[0]),
      ...Array.from(html.matchAll(/src="([^"]+\.js)"/g)).map(x => x[1])
    ])).reverse().slice(0, 10);

    for (const u of urls) {
      const js = await getJs(u);
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
  const delays = [5000, 10000, 15000, 30000, 60000];
  let attempt  = 0;
  // simple background loop
  while (!SHARED_CLIENT_ID) {
    attempt++;
    try {
      const id = await tryExtractClientId();
      if (!id) throw new Error('not found');
      SHARED_CLIENT_ID = id;
      console.log('[clientid] obtained attempt ' + attempt);
      setTimeout(() => { SHARED_CLIENT_ID = null; fetchSharedClientId(); }, 6 * 60 * 60 * 1000);
      return;
    } catch {
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

async function getOrFetchGlobalSoundCloudClientId() {
  if (SHARED_CLIENT_ID) return SHARED_CLIENT_ID;
  await fetchSharedClientId();
  return SHARED_CLIENT_ID;
}

async function resolveSoundCloudStream(scId, clientId) {
  if (!clientId) return null;
  try {
    // using progressive stream; you can adjust to HLS if you want
    const data = await scGet(
      clientId,
      `https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${scId}`,
      {}
    );
    const transcodings = data?.media?.transcodings || [];
    const prog = transcodings.find(t => (t.format?.protocol === 'progressive'));
    const target = prog || transcodings[0];
    if (!target) return null;

    const transData = await scGet(clientId, target.url, {});
    const url = transData?.url;
    if (!url) return null;
    return { url, format: 'mp3', quality: 'standard' };
  } catch (e) {
    console.warn('[sc stream]', e.message);
    return null;
  }
}

// ─── Hi-Fi smart search based on SC meta (ported) ────────────────────────────
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
    } catch {}
  }
  return null;
}

// ─── Web UI ───────────────────────────────────────────────────────────────────
function buildPage(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bandcamp + MusicBrainz + HiFi/SC</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d0d0f;--sf:#131316;--sf2:#1a1a1e;--bd:#262629;
  --green:#1dc37a;--blue:#4a9eff;--orange:#f50;--red:#c0392b;
  --text:#e8e8f0;--muted:#6a6a78;--r:13px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;
  display:flex;flex-direction:column;align-items:center;padding:52px 16px 88px;line-height:1.6}
.page{width:100%;max-width:600px;display:flex;flex-direction:column;gap:22px}
header{text-align:center}
.logo{width:58px;height:58px;border-radius:16px;background:linear-gradient(135deg,#1da0c3,#1dc37a);
  display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:28px}
h1{font-size:23px;font-weight:800;letter-spacing:-.4px}
.sub{font-size:13px;color:var(--muted);margin-top:3px}
.badges{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin-top:12px}
.badge{font-size:11px;font-weight:600;padding:3px 9px;border-radius:100px;letter-spacing:.4px;text-transform:uppercase}
.bg{background:rgba(29,195,122,.12);color:var(--green);border:1px solid rgba(29,195,122,.25)}
.bb{background:rgba(74,158,255,.12);color:var(--blue);border:1px solid rgba(74,158,255,.25)}
.bo{background:rgba(255,85,0,.12);color:var(--orange);border:1px solid rgba(255,85,0,.25)}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:24px}
.ct{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;
  letter-spacing:.9px;display:flex;align-items:center;gap:8px;margin-bottom:16px}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.steps{display:flex;flex-direction:column;gap:13px}
.step{display:flex;gap:12px;align-items:flex-start}
.sn{width:24px;height:24px;border-radius:50%;border:1px solid var(--green);color:var(--green);
  font-size:11px;font-weight:700;flex-shrink:0;margin-top:2px;
  display:flex;align-items:center;justify-content:center}
.sb strong{display:block;font-size:14px;margin-bottom:2px}
.sb span{font-size:13px;color:var(--muted)}
input[type=text]{width:100%;background:var(--sf2);border:1px solid var(--bd);border-radius:9px;
  padding:11px 13px;color:var(--text);font-size:13px;font-family:"SF Mono","Fira Code",monospace;
  outline:none;transition:border-color .2s}
input[type=text]::placeholder{color:var(--muted);font-family:var(--font)}
input[type=text]:focus{border-color:var(--green)}
.note{font-size:12px;color:var(--muted);margin:5px 0 14px;line-height:1.6}
.irow{display:flex;gap:8px}
.irow input{flex:1}
.btn{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:700;
  padding:11px 18px;border-radius:9px;border:none;cursor:pointer;
  transition:opacity .15s,transform .1s;white-space:nowrap}
.btn:hover{opacity:.85}.btn:active{transform:scale(.97)}.btn:disabled{opacity:.35;cursor:not-allowed}
.btn-g{background:var(--green);color:#000}.btn-b{background:var(--blue);color:#000}
.btn-gh{background:transparent;color:var(--text);border:1px solid var(--bd)}
.btn-gh:hover{background:var(--sf2);opacity:1}
.btn-sm{font-size:13px;padding:8px 13px;border-radius:8px}
.btn-full{width:100%;justify-content:center}
.urlbox{display:none;align-items:center;gap:8px;background:var(--sf2);border:1px solid var(--bd);
  border-radius:9px;padding:7px 7px 7px 13px;margin-top:13px}
.urlbox.show{display:flex}
.urlbox code{flex:1;font-size:12px;font-family:"SF Mono","Fira Code",monospace;
  color:var(--green);word-break:break-all;line-height:1.5}
.cpybtn.ok{background:var(--green)!important;color:#000!important}
.pill{display:none;margin-top:11px;background:var(--sf2);border:1px solid var(--bd);
  border-radius:8px;padding:8px 12px;font-size:12px;color:var(--muted);
  font-family:"SF Mono","Fira Code",monospace;word-break:break-all;line-height:1.6}
.pill.show{display:block}
.pill strong{color:var(--text)}
.alert{display:none;padding:11px 13px;border-radius:9px;font-size:13px;margin-top:11px;align-items:flex-start;gap:8px}
.alert.show{display:flex}
.a-ok{background:rgba(29,195,122,.1);border:1px solid rgba(29,195,122,.25);color:var(--green)}
.a-err{background:rgba(192,57,43,.1);border:1px solid rgba(192,57,43,.25);color:var(--red)}
.ai{flex-shrink:0;margin-top:1px}
.sgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.sbox{background:var(--sf2);border:1px solid var(--bd);border-radius:10px;padding:15px}
.sv{font-size:26px;font-weight:800;line-height:1}
.sl{font-size:11px;color:var(--muted);margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
.sc .sv{color:var(--green)}.sb2 .sv{color:var(--blue)}
hr{border:none;border-top:1px solid var(--bd)}
footer{text-align:center;font-size:12px;color:var(--muted);margin-top:6px;line-height:1.8}
footer a{color:var(--muted);text-decoration:underline}
.rchip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;
  padding:3px 9px;border-radius:100px;margin-bottom:14px;
  background:rgba(29,195,122,.12);color:var(--green);border:1px solid rgba(29,195,122,.25)}
.rchip.off{background:rgba(192,57,43,.1);color:var(--red);border-color:rgba(192,57,43,.25)}
.rdot{width:6px;height:6px;border-radius:50%;background:currentColor}
</style>
</head>
<body>
<div class="page">
<header>
  <div class="logo">&#127925;</div>
  <h1>Bandcamp x MusicBrainz + HiFi/SC</h1>
  <p class="sub">Eclipse Music Addon — ${baseUrl}</p>
  <div class="badges">
    <span class="badge bb">MusicBrainz</span>
    <span class="badge bb">Bandcamp</span>
    <span class="badge bo">HiFi → SoundCloud → BC</span>
    <span class="badge bg">ISRC Enrichment</span>
  </div>
</header>

<div class="card">
  <div class="ct"><span class="dot" style="background:var(--green)"></span>How It Works</div>
  <div class="steps">
    <div class="step"><div class="sn">1</div><div class="sb">
      <strong>Optional: SoundCloud client_id</strong>
      <span>Enter your SoundCloud client_id to use your own API quota. Leave blank and the addon will scrape a shared client_id automatically.</span>
    </div></div>
    <div class="step"><div class="sn">2</div><div class="sb">
      <strong>Generate your personal URL</strong>
      <span>Each person gets their own URL so your MusicBrainz rate limit (1 req/sec) and SoundCloud usage stay separate.</span>
    </div></div>
    <div class="step"><div class="sn">3</div><div class="sb">
      <strong>Search in Eclipse</strong>
      <span>Search combines MusicBrainz and Bandcamp. Streams prefer HiFi instances first, then SoundCloud, then Bandcamp as fallback.</span>
    </div></div>
  </div>
</div>

<div class="card">
  <div class="ct"><span class="dot" style="background:var(--green)"></span>Generate Your URL</div>
  <div id="redisChip" class="rchip off"><span class="rdot"></span>Checking Redis...</div>
  <div class="note">SoundCloud Client ID (optional):</div>
  <div class="irow" style="margin-bottom:8px">
    <input type="text" id="scClientId" placeholder="Leave blank to use shared auto client_id"/>
  </div>
  <button class="btn btn-g btn-full" id="genBtn" onclick="generate()">⚡ Generate My Personal URL</button>
  <div class="urlbox" id="genBox">
    <code id="genUrl"></code>
    <button class="btn btn-gh btn-sm cpybtn" id="genCpy" onclick="cp('genUrl','genCpy')">Copy</button>
  </div>
  <div class="pill" id="genPill">Token: <strong id="genTok"></strong><br>Saved to Redis — survives server restarts automatically.</div>
  <div class="alert" id="genAlert"><span class="ai"></span><span id="genMsg"></span></div>
</div>

<div class="card" id="statsCard" style="display:none">
  <div class="ct"><span class="dot" style="background:var(--blue)"></span>Your Stats</div>
  <div class="sgrid">
    <div class="sbox sc"><div class="sv" id="stS">0</div><div class="sl">Searches</div></div>
    <div class="sbox sb2"><div class="sv" id="stSt">0</div><div class="sl">Streams</div></div>
    <div class="sbox"><div class="sv" id="stT">0</div><div class="sl">Tracks Found</div></div>
    <div class="sbox sc"><div class="sv" id="stI">0</div><div class="sl">ISRC Enriched</div></div>
  </div>
  <p id="statMeta" style="font-size:12px;color:var(--muted);margin-top:11px"></p>
</div>

<div class="card">
  <div class="ct"><span class="dot" style="background:var(--blue)"></span>Update an Existing URL</div>
  <p class="note">Paste your old addon URL to migrate to a fresh token. Track history and SoundCloud client_id (if set) are preserved.</p>
  <div class="irow">
    <input type="text" id="oldUrl" placeholder="https://your-app.onrender.com/u/abc123.../manifest.json"/>
    <button class="btn btn-b btn-sm" onclick="update()">Update</button>
  </div>
  <div class="urlbox" id="updBox">
    <code id="updUrl"></code>
    <button class="btn btn-gh btn-sm cpybtn" id="updCpy" onclick="cp('updUrl','updCpy')">Copy</button>
  </div>
  <div class="alert" id="updAlert"><span class="ai"></span><span id="updMsg"></span></div>
</div>

<hr/>

<div class="card">
  <div class="ct"><span class="dot" style="background:var(--orange)"></span>Export Track History</div>
  <p class="note">Downloads every track discovered through your addon as a CSV including ISRC codes. Pulled from Redis so it works even after a restart.</p>
  <div class="irow">
    <input type="text" id="expInput" placeholder="Paste your token or full addon URL"/>
    <button class="btn btn-gh btn-sm" onclick="exportCSV()">↓ Download CSV</button>
  </div>
  <div class="alert" id="expAlert"><span class="ai"></span><span id="expMsg"></span></div>
  <p style="font-size:12px;color:var(--muted);margin-top:10px">Your token is the 32-char hex string after <code style="background:var(--sf2);padding:1px 5px;border-radius:4px">/u/</code> in your URL.</p>
</div>

<footer>
  Bandcamp + MusicBrainz + HiFi/SC Addon · <a href="${baseUrl}" target="_blank">${baseUrl}</a>
</footer>
</div>

<script>
function sa(a,m,t,msg){
  var el=document.getElementById(a),mn=document.getElementById(m);
  el.className='alert show a-'+(t==='ok'?'ok':'err');
  el.querySelector('.ai').textContent=t==='ok'?'checkmark':'x';
  mn.textContent=msg;
}
function ha(id){document.getElementById(id).className='alert'}
function cp(src,btn){
  navigator.clipboard.writeText(document.getElementById(src).textContent).then(function(){
    var b=document.getElementById(btn);b.textContent='Copied!';b.classList.add('ok');
    setTimeout(function(){b.textContent='Copy';b.classList.remove('ok')},1800);
  });
}
function exTok(s){
  s=(s||'').trim();
  var m=s.match(/\\/u\\/([a-f0-9]{32})(\\/|$)/);
  if(m)return m[1];
  return /^[a-f0-9]{32}$/.test(s)?s:null;
}
function loadStats(token){
  fetch('/api/stats/'+token).then(function(r){return r.json()}).then(function(d){
    if(d.error)return;
    document.getElementById('statsCard').style.display='';
    document.getElementById('stS').textContent=d.searches||0;
    document.getElementById('stSt').textContent=d.streams||0;
    document.getElementById('stT').textContent=d.tracks||0;
    document.getElementById('stI').textContent=d.enriched||0;
    var c=d.createdAt?new Date(d.createdAt).toLocaleDateString():'unknown';
    var l=d.lastUsed?new Date(d.lastUsed).toLocaleString():'never';
    document.getElementById('statMeta').textContent='Created '+c+' - Last used '+l;
  }).catch(function(){});
}
fetch('/api/health').then(function(r){return r.json()}).then(function(d){
  var chip=document.getElementById('redisChip');
  if(d.redis){
    chip.className='rchip';
    chip.innerHTML='<span class="rdot"></span>Redis Connected - tokens survive restarts';
  } else {
    chip.className='rchip off';
    chip.innerHTML='<span class="rdot"></span>No Redis - tokens are in-memory only';
  }
}).catch(function(){});
function generate(){
  ha('genAlert');
  var btn=document.getElementById('genBtn');
  btn.disabled=true;btn.textContent='Generating...';
  var scId=document.getElementById('scClientId').value.trim();
  fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({soundcloudClientId:scId||null})})
  .then(function(r){return r.json()}).then(function(d){
    if(d.error){sa('genAlert','genMsg','err',d.error);return}
    document.getElementById('genUrl').textContent=d.url;
    document.getElementById('genBox').classList.add('show');
    document.getElementById('genTok').textContent=d.token;
    document.getElementById('genPill').classList.add('show');
    document.getElementById('expInput').value=d.token;
    sa('genAlert','genMsg','ok','Your personal URL is ready - paste it into Eclipse to install.');
    loadStats(d.token);
  }).catch(function(e){sa('genAlert','genMsg','err',e.message)})
  .finally(function(){btn.disabled=false;btn.textContent='⚡ Generate My Personal URL'});
}
function update(){
  ha('updAlert');
  var oldUrl=document.getElementById('oldUrl').value.trim();
  if(!oldUrl){sa('updAlert','updMsg','err','Paste your existing addon URL first.');return}
  fetch('/api/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oldUrl:oldUrl})})
  .then(function(r){return r.json()}).then(function(d){
    if(d.error){sa('updAlert','updMsg','err',d.error);return}
    document.getElementById('updUrl').textContent=d.url;
    document.getElementById('updBox').classList.add('show');
    document.getElementById('expInput').value=d.token;
    sa('updAlert','updMsg','ok','Fresh token generated. History migrated. Update Eclipse with the new URL.');
    loadStats(d.token);
  }).catch(function(e){sa('updAlert','updMsg','err',e.message)});
}
function exportCSV(){
  ha('expAlert');
  var tok=exTok(document.getElementById('expInput').value);
  if(!tok){sa('expAlert','expMsg','err','Could not find a valid token - paste your token or full URL.');return}
  var a=document.createElement('a');
  a.href='/api/export/'+tok;
  a.download='bandcamp-eclipse-'+tok.slice(0,8)+'.csv';
  document.body.appendChild(a);a.click();a.remove();
  sa('expAlert','expMsg','ok','Download started.');
}
</script>
</body>
</html>`;
}

// ─── API routes ───────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  let redisOk = false;
  if (redis) {
    try {
      const pong = await redis.ping();
      redisOk = pong === 'PONG';
    } catch {
      redisOk = false;
    }
  }
  res.json({
    status: 'ok',
    redis: redisOk,
    tokens: tokens.size,
    isrcCacheSize: isrcCache.size,
    hifiInstance: activeInstance,
    hifiHealthy: instanceHealthy,
    sharedClientIdReady: !!SHARED_CLIENT_ID
  });
});

app.post('/api/generate', async (req, res) => {
  const token = generateToken();
  let soundcloudClientId = req.body?.soundcloudClientId || null;
  if (soundcloudClientId && !/^[a-zA-Z0-9]{20,40}$/.test(soundcloudClientId)) {
    return res.status(400).json({ error: 'Invalid SoundCloud client_id.' });
  }
  if (!soundcloudClientId) {
    soundcloudClientId = await getOrFetchGlobalSoundCloudClientId();
  }
  const meta = {
    createdAt: new Date().toISOString(),
    searches: 0,
    streams: 0,
    lastUsed: null,
    soundcloudClientId: soundcloudClientId || null
  };
  tokens.set(token, meta);
  await rSet(`bc:token:${token}`, meta);
  res.json({ token, url: `${getBaseUrl(req)}/u/${token}/manifest.json` });
});

app.post('/api/update', async (req, res) => {
  const { oldUrl } = req.body || {};
  const match = (oldUrl || '').match(/\/u\/([a-f0-9]{32})(\/|$)/);
  if (!match) return res.status(400).json({ error: 'Could not find a valid token in that URL.' });
  const oldToken = match[1];
  if (!tokens.has(oldToken)) {
    const saved = await rGet(`bc:token:${oldToken}`);
    if (!saved) return res.status(404).json({ error: 'Token not found - it may have expired. Generate a new one.' });
    tokens.set(oldToken, saved);
  }
  const newToken = generateToken();
  const prevMeta = tokens.get(oldToken) || {};
  const newMeta  = { ...prevMeta, migratedAt: new Date().toISOString() };
  tokens.set(newToken, newMeta);
  tokens.delete(oldToken);
  await rSet(`bc:token:${newToken}`, newMeta);
  await rDel(`bc:token:${oldToken}`);
  const oldHistory = await rList(`bc:history:${oldToken}`);
  for (const item of oldHistory) await rAppend(`bc:history:${newToken}`, item);
  if (oldHistory.length) await rDel(`bc:history:${oldToken}`);
  if (trackHistory.has(oldToken)) {
    trackHistory.set(newToken, trackHistory.get(oldToken));
    trackHistory.delete(oldToken);
  }
  res.json({ token: newToken, url: `${getBaseUrl(req)}/u/${newToken}/manifest.json` });
});

app.get('/api/stats/:token', async (req, res) => {
  const { token } = req.params;
  const meta = tokens.get(token) || await rGet(`bc:token:${token}`);
  if (!meta) return res.status(404).json({ error: 'Token not found.' });
  const memHistory = trackHistory.get(token);
  const history = memHistory?.length ? memHistory : await rList(`bc:history:${token}`);
  res.json({
    searches: meta.searches || 0, streams: meta.streams || 0,
    tracks: history.length, enriched: history.filter(t => t.isrc).length,
    createdAt: meta.createdAt, lastUsed: meta.lastUsed
  });
});

app.get('/api/export/:token', async (req, res) => {
  const { token } = req.params;
  const meta = tokens.get(token) || await rGet(`bc:token:${token}`);
  if (!meta) return res.status(404).json({ error: 'Token not found.' });
  const memHistory = trackHistory.get(token);
  const history = memHistory?.length ? memHistory : await rList(`bc:history:${token}`);
  const esc = s => { const x = String(s||''); return (x.includes(',')||x.includes('"')) ? `"${x.replace(/"/g,'""')}"` : x; };
  const csv = [
    'Title,Artist,Album,ISRC,Format,Timestamp',
    ...history.map(t => [esc(t.title),esc(t.artist),esc(t.album),t.isrc||'',t.format||'mp3',t.timestamp].join(','))
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="bandcamp-hifi-${token.slice(0,8)}.csv"`);
  res.send(csv);
});

// ─── Web UI ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(getBaseUrl(req)));
});

// ─── Manifest ────────────────────────────────────────────────────────────────
app.get('/u/:token/manifest.json', tokenMiddleware, (req, res) => {
  res.json({
    id:          `com.yourname.bandcamp-mb-hifi.${req.params.token.slice(0, 8)}`,
    name:        'Bandcamp + MB + HiFi/SC',
    version:     '1.0.0',
    description: 'MusicBrainz + Bandcamp with HiFi → SoundCloud → Bandcamp streaming and ISRC enrichment',
    icon:        'https://s4.bcbits.com/img/bc_favicon.ico',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist']
  });
});

// helper: fetch cover art for first release of a recording (Cover Art Archive)
async function mbGetCoverArtForRecording(rec) {
  const releases = rec.releases || rec['release-list'] || [];
  if (!releases.length) return null;
  const rel = releases[0];
  if (!rel.id) return null;
  try {
    const r = await fetch(`https://coverartarchive.org/release/${rel.id}/front-250`, {
      redirect: 'follow'
    });
    if (!r.ok) return null;
    return r.url; // actual image URL after redirects
  } catch {
    return null;
  }
}

// ─── Search: MusicBrainz ONLY, strict ────────────────────────────────────────
app.get('/u/:token/search', tokenMiddleware, async (req, res) => {
  const { token } = req.params;
  const qRaw = (req.query.q || '').trim();
  if (!qRaw) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });

  const meta = tokens.get(token);
  meta.searches = (meta.searches || 0) + 1;
  meta.lastUsed = new Date().toISOString();
  if (meta.searches % 5 === 0) await rSet(`bc:token:${token}`, meta);

  try {
    // Parse "Artist - Title" if present; fall back to full query as title
    const parts  = qRaw.split(' - ');
    const title  = parts[parts.length - 1].trim();
    const artist = parts.length > 1 ? parts[0].trim() : '';

    const mbQuery = artist
      ? `recording:"${title}" AND artist:"${artist}"`
      : `recording:"${title}"`;

    // Ask for up to 20, then filter down to those with ISRCs to reduce noise
    const recs = await mbSearchRecordings(mbQuery, 20);
    const filtered = (recs || []).filter(r => Array.isArray(r.isrcs) && r.isrcs.length);

    // Limit to first 10 to keep things snappy
    const top = filtered.slice(0, 10);

    const tracks = [];
    for (const rec of top) {
      const t = mapMbRecordingToTrack(rec);
      t.artworkURL = await mbGetCoverArtForRecording(rec); // may be null if no art
      tracks.push(t);
      await logTrack(token, t);
    }

    // MB-only: no Bandcamp albums/artists/playlists in search results
    res.json({ tracks, albums: [], artists: [], playlists: [] });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// ─── Stream: HiFi → SoundCloud → Bandcamp ────────────────────────────────────
app.get('/u/:token/stream/:id', tokenMiddleware, async (req, res) => {
  const { token } = req.params;
  const meta = tokens.get(token);
  meta.streams  = (meta.streams || 0) + 1;
  meta.lastUsed = new Date().toISOString();
  if (meta.streams % 5 === 0) await rSet(`bc:token:${token}`, meta);

  const rawId = req.params.id || '';

  try {
    // 1) MusicBrainz-based HiFi streams (using SC-style meta if you bind SC ids)
    if (rawId.startsWith('mb:')) {
      // You could look up SC meta via ISRC here and then call hifiFindBestTrack.
      // For now we treat MB as catalog only; fall through to Bandcamp if you map it.
      return res.status(404).json({ error: 'HiFi stream not wired for MB-only IDs yet.' });
    }

    // 2) SoundCloud stream (id is sc:<soundcloudTrackId>)
    if (rawId.startsWith('sc:')) {
      const scId = rawId.slice(3);
      const clientId = meta.soundcloudClientId || (await getOrFetchGlobalSoundCloudClientId());
      if (!clientId) {
        return res.status(503).json({ error: 'No SoundCloud client_id available yet. Try again in a few seconds.' });
      }

      // optional: for HiFi we want SC meta to feed hifiFindBestTrack
      let scTrack = null;
      try {
        scTrack = await scGet(clientId, `https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${scId}`, {});
      } catch (e) {
        console.warn('[stream] sc lookup failed', e.message);
      }
      if (scTrack) rememberTrack(scTrack);
      const metaParsed = scTrack ? parseArtistTitle(scTrack) : TRACK_CACHE.get(scId) || null;
      const albumName =
        scTrack && scTrack.publisher_metadata && scTrack.publisher_metadata.release_title
          ? scTrack.publisher_metadata.release_title
          : null;

      // 2a) HiFi first
      try {
        const best = await hifiFindBestTrack(metaParsed, albumName);
        if (best && best.id) {
          const hifiId = best.id;
          const qualities = ['LOSSLESS', 'HIGH', 'LOW'];
          for (const ql of qualities) {
            try {
              const data    = await hifiGet('/track/', { id: hifiId, quality: ql });
              const payload = (data && data.data) ? data.data : data;
              if (payload && payload.manifest) {
                const decoded = JSON.parse(Buffer.from(payload.manifest, 'base64').toString('utf8'));
                const url   = (decoded.urls && decoded.urls[0]) || null;
                const codec = decoded.codecs || decoded.mimeType || '';
                if (url) {
                  const isFlac = codec &&
                    (codec.indexOf('flac') !== -1 || codec.indexOf('audio/flac') !== -1);
                  return res.json({
                    url,
                    format:  isFlac ? 'flac' : 'aac',
                    quality: ql === 'LOSSLESS' ? 'lossless' : (ql === 'HIGH' ? '320kbps' : '128kbps')
                  });
                }
              }
            } catch (e) {
              console.warn('[hifi]', e.message);
            }
          }
        }
      } catch (e) {
        console.warn('[hifi find]', e.message);
      }

      // 2b) SoundCloud fallback
      const sc = await resolveSoundCloudStream(scId, clientId);
      if (sc && sc.url) {
        return res.json({
          url: sc.url,
          format: sc.format || 'mp3',
          quality: sc.quality || 'standard'
        });
      }
      return res.status(404).json({ error: 'SoundCloud stream not available.' });
    }

    // 3) Bandcamp fallback (id is bc:<base64url> or raw base64url)
    let encoded = rawId;
    if (rawId.startsWith('bc:')) {
      encoded = rawId.slice(3);
    }
    const trackUrl = decodeId(encoded);
    if (!trackUrl) return res.status(400).json({ error: 'Invalid track ID.' });

    const info = await bcfetch.track.getInfo({ trackUrl });
    let streamUrl = info?.streamUrl;
    if (!streamUrl) {
      return res.status(404).json({ error: 'Track is not streamable (album-only or purchase required).' });
    }
    const test = await bcfetch.stream.test(streamUrl);
    if (!test.ok) {
      streamUrl = await bcfetch.stream.refresh(streamUrl);
    }
    if (!streamUrl) {
      return res.status(503).json({ error: 'Stream URL expired and could not be refreshed.' });
    }
    return res.json({ url: streamUrl, format: 'mp3', quality: '128kbps' });
  } catch (err) {
    console.error('[stream]', err.message);
    res.status(500).json({ error: 'Stream resolution failed.' });
  }
});

// ─── Album ────────────────────────────────────────────────────────────────────
app.get('/u/:token/album/:id', tokenMiddleware, async (req, res) => {
  const albumUrl = decodeId(req.params.id);
  if (!albumUrl) return res.status(400).json({ error: 'Invalid album ID.' });
  try {
    const album     = await bcfetch.album.getInfo({ albumUrl });
    const rawTracks = (album.tracks || []).map(t => mapTrack(t, album.artist?.name));
    const tracks    = await enrichTracks(rawTracks);
    res.json({
      id: req.params.id, title: album.name, artist: album.artist?.name || 'Unknown',
      artworkURL: album.imageUrl, description: album.description, trackCount: tracks.length,
      year: album.releaseDate ? String(new Date(album.releaseDate).getFullYear()) : undefined,
      tracks
    });
  } catch (err) {
    console.error('[album]', err.message);
    res.status(500).json({ error: 'Album fetch failed.' });
  }
});

// ─── Artist ───────────────────────────────────────────────────────────────────
app.get('/u/:token/artist/:id', tokenMiddleware, async (req, res) => {
  const bandUrl = decodeId(req.params.id);
  if (!bandUrl) return res.status(400).json({ error: 'Invalid artist ID.' });
  try {
    const [info, discography] = await Promise.all([
      bcfetch.band.getInfo({ bandUrl }),
      bcfetch.band.getDiscography({ bandUrl })
    ]);
    const albums = (discography || []).filter(d => d.type === 'album' && d.url).map(mapAlbum);
    let topTracks = [];
    const latest = (discography || []).find(d => d.type === 'album' && d.url);
    if (latest?.url) {
      try {
        const albumInfo = await bcfetch.album.getInfo({ albumUrl: latest.url });
        const rawTracks = (albumInfo.tracks || []).slice(0, 10).map(t => mapTrack(t, info.name));
        topTracks = await enrichTracks(rawTracks, 3000);
      } catch {}
    }
    res.json({
      id: req.params.id, name: info.name, artworkURL: info.imageUrl,
      bio: info.description, topTracks, albums
    });
  } catch (err) {
    console.error('[artist]', err.message);
    res.status(500).json({ error: 'Artist fetch failed.' });
  }
});

// ─── Playlist (Bandcamp Daily) ───────────────────────────────────────────────
app.get('/u/:token/playlist/:id', tokenMiddleware, async (req, res) => {
  const showUrl = decodeId(req.params.id);
  if (!showUrl) return res.status(400).json({ error: 'Invalid playlist ID.' });
  try {
    const show      = await bcfetch.show.getShow({ showUrl });
    const rawTracks = (show.tracks || []).map(t => mapTrack(t));
    const tracks    = await enrichTracks(rawTracks);
    res.json({
      id: req.params.id, title: show.title, description: show.description,
      artworkURL: show.imageUrl, creator: 'Bandcamp Daily', tracks
    });
  } catch (err) {
    console.error('[playlist]', err.message);
    res.status(500).json({ error: 'Playlist fetch failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Bandcamp + MusicBrainz + HiFi/SC addon -> port ${PORT}`);
  console.log(`Redis: ${redis ? 'enabled' : 'disabled (set REDIS_URL to enable)'}`);
});
