const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');
const ytpl    = require('ytpl');
const {
  searchMusics,
  searchAlbums,
  searchPlaylists,
  searchArtists,
  getArtist,
  listMusicsFromAlbum
} = require('node-youtube-music'); // still imported, but search is now optional[web:62]

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Hi-Fi / Claudochrome instances ─────────────────────────────────────────
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
      reqCount:  entry.reqCount,
      ytApiKey:  entry.ytApiKey || null     // store YouTube API key too
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
    rateWin:   [],
    ytApiKey:  saved.ytApiKey || null   // per-token YouTube API key
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

// ─── SoundCloud client_id auto discovery ─────────────────────────────────────
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

// Hide previews / SNIP in both search and stream, allow only fully playable
function isFullyPlayable(t) {
  if (!t) return false;
  if (t.streamable === false) return false;
  const p = t.policy;
  if (!p || p === 'SNIP' || p === 'BLOCK') return false;
  return true;
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

function effectiveCid(e) {
  return (e && e.clientId) ? e.clientId : SHARED_CLIENT_ID;
}

// ─── Smarter Hi-Fi track search ─────────────────────────────────────────────
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
        if (bTitle === wantTitle) aScore += 5;
        if (wantArtist && aArtist === wantArtist) aScore += 5;
        if (wantArtist && bArtist === wantArtist) aScore += 5;
        if (wantTitle && aTitle.includes(wantTitle)) aScore += 2;
        if (wantTitle && bTitle.includes(wantTitle)) aScore += 2;
        if (wantArtist && aArtist.includes(wantArtist)) aScore += 2;
        if (wantArtist && bArtist.includes(wantArtist)) aScore += 2;
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

// ─── YouTube Data API helpers (search only, no streaming) ───────────────────
const SOURCE_TIMEOUT_MS = 10000;

async function fetchYT(url, params) {
  const r = await axios.get(url, {
    params,
    timeout: SOURCE_TIMEOUT_MS,
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  return r.data;
}

function parseISODuration(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const secs = (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
  return secs > 0 ? secs : null;
}

function pickArt(snippet) {
  return (snippet && (snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url)) || null;
}

function mapYoutubeToTrack(videoId, snippet, contentDetails) {
  return {
    id: 'ytvid_' + videoId,
    title: cleanText(snippet.title || 'YouTube Video'),
    artist: cleanText(snippet.channelTitle || 'YouTube'),
    album: 'YouTube',
    duration: parseISODuration(contentDetails?.duration),
    artworkURL: pickArt(snippet),
    format: 'm4a',
    sourceURL: 'https://www.youtube.com/watch?v=' + videoId
  };
}

function scoreYoutubeVideo(query, title, channel, desc) {
  const q = cleanText(query).toLowerCase();
  const t = cleanText(title).toLowerCase();
  const c = cleanText(channel).toLowerCase();
  const d = cleanText(desc).toLowerCase();
  if (!q || !t) return 0;
  let score = 0;
  if (t === q) score += 150;
  else if (t.startsWith(q)) score += 60;
  else if (t.includes(q)) score += 35;
  if (c.includes(q)) score += 15;
  if (/official audio|official video|audio|lyrics?|visualizer|topic/.test(t)) score += 20;
  if (/full album|mix|compilation|reaction|review|interview|podcast|trailer/.test(t + ' ' + d)) score -= 40;
  return score;
}

async function youtubeSearch(apiKey, q) {
  if (!apiKey) return { tracks: [], albums: [], artists: [], playlists: [] };

  const searchData = await fetchYT('https://www.googleapis.com/youtube/v3/search', {
    part: 'snippet', q, type: 'video', maxResults: 20, safeSearch: 'none', key: apiKey
  });

  const items = Array.isArray(searchData.items) ? searchData.items : [];
  const ids = items.map(x => x.id?.videoId).filter(Boolean).join(',');

  let detailMap = new Map();
  if (ids) {
    try {
      const detailData = await fetchYT('https://www.googleapis.com/youtube/v3/videos', {
        part: 'contentDetails,snippet', id: ids, key: apiKey
      });
      (detailData.items || []).forEach(d => detailMap.set(String(d.id), d));
    } catch(e) {}
  }

  const ranked = items.map(item => {
    const vid = String(item.id?.videoId || '');
    const detail = detailMap.get(vid);
    const s = item.snippet || {};
    return {
      vid,
      snippet: detail?.snippet || s,
      detail,
      score: scoreYoutubeVideo(q, s.title||'', s.channelTitle||'', s.description||'')
    };
  }).filter(x => x.score >= 20).sort((a, b) => b.score - a.score).slice(0, 12);

  const tracks = ranked.map(x => mapYoutubeToTrack(x.vid, x.snippet, x.detail?.contentDetails));

  const albums = ranked.slice(0, 8).map(x => ({
    id: 'ytalbum_' + x.vid,
    title: cleanText(x.snippet.title || 'YouTube Video'),
    artist: cleanText(x.snippet.channelTitle || 'YouTube'),
    artworkURL: pickArt(x.snippet),
    trackCount: 1,
    year: String(x.snippet.publishedAt || '').slice(0, 4) || null
  }));

  const seenArtists = new Set(), artists = [];
  const seenPlaylists = new Set(), playlists = [];
  for (const x of ranked) {
    const cid = String(x.snippet.channelId || '');
    const cname = cleanText(x.snippet.channelTitle || 'YouTube');
    if (cid && !seenArtists.has(cid)) {
      seenArtists.add(cid);
      artists.push({ id: 'ytartist_' + cid, name: cname, artworkURL: pickArt(x.snippet), genres: [] });
    }
    if (cid && !seenPlaylists.has(cid)) {
      seenPlaylists.add(cid);
      playlists.push({ id: 'ytplaylist_' + cid, title: cname + ' Picks', creator: cname, artworkURL: pickArt(x.snippet), trackCount: null });
    }
  }

  return { tracks, albums, artists: artists.slice(0, 6), playlists: playlists.slice(0, 6) };
}

async function getYoutubeVideo(apiKey, videoId) {
  try {
    const data = await fetchYT('https://www.googleapis.com/youtube/v3/videos', {
      part: 'contentDetails,snippet', id: videoId, key: apiKey
    });
    const item = Array.isArray(data.items) ? data.items[0] : null;
    return item || null;
  } catch(e) { return null; }
}

async function getYoutubeChannelVideos(apiKey, channelId) {
  try {
    const data = await fetchYT('https://www.googleapis.com/youtube/v3/search', {
      part: 'snippet', channelId, type: 'video', maxResults: 12, order: 'relevance', key: apiKey
    });
    return Array.isArray(data.items) ? data.items : [];
  } catch(e) { return []; }
}

// ─── Simple config page (add ytApiKey input) ────────────────────────────────
function buildConfigPage(baseUrl) {
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>All-in-One Eclipse Addon</title>';
  h += '<style>body{background:#050814;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;';
  h += 'min-height:100vh;margin:0;display:flex;justify-content:center;align-items:flex-start;padding:40px 16px}';
  h += '.card{background:#020617;border-radius:18px;border:1px solid #1f2937;max-width:520px;width:100%;padding:24px 22px;';
  h += 'box-shadow:0 24px 80px rgba(15,23,42,0.9)}h1{font-size:22px;margin:0 0 4px}';
  h += 'p{margin:4px 0 10px;color:#9ca3af}.lbl{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-top:14px;margin-bottom:6px}';
  h += 'input{width:100%;padding:10px 11px;border-radius:9px;border:1px solid #1f2937;background:#020617;color:#e5e7eb;font-size:13px;margin-bottom:8px}';
  h += 'input:focus{outline:none;border-color:#38bdf8;box-shadow:0 0 0 1px rgba(56,189,248,0.4)}code{background:#020617;border-radius:6px;padding:3px 6px;font-size:12px;border:1px solid #1f2937}';
  h += 'button{cursor:pointer;border-radius:9px;border:1px solid rgba(148,163,184,0.4);padding:9px 12px;font-size:13px;';
  h += 'background:linear-gradient(to bottom right,#1f2937,#020617);color:#e5e7eb;margin-top:6px}';
  h += 'button.primary{border-color:transparent;background:linear-gradient(to bottom right,#38bdf8,#0ea5e9);color:#0b1120;font-weight:600}';
  h += '.small{font-size:12px;color:#6b7280}.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}';
  h += '.box{display:none;background:#020617;border-radius:10px;border:1px solid #111827;padding:12px;margin-top:12px;font-size:12px}';
  h += '.label-sm{font-size:11px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:.08em}</style></head><body>';
  h += '<div class="card">';
  h += '<h1>All-in-One Music Addon</h1>';
  h += '<p>Search using SoundCloud + YouTube Music + optional YouTube Data API. Each URL below is unique per user.</p>';
  h += '<div class="lbl">SoundCloud client_id <span style="text-transform:none;font-weight:400;color:#4b5563">(optional)</span></div>';
  h += '<input id="clientId" placeholder="Leave blank to use the shared auto-refreshed ID">';
  h += '<div class="lbl">YouTube API key <span style="text-transform:none;font-weight:400;color:#4b5563">(optional, for YouTube search)</span></div>';
  h += '<input id="ytApiKey" placeholder="Paste your YouTube Data API v3 key">';
  h += '<p class="small">You can paste your own SoundCloud client_id and YouTube API key, or rely only on SoundCloud.</p>';
  h += '<button class="primary" id="genBtn" onclick="generate()">Generate my addon URL</button>';
  h += '<div class="box" id="genBox"><div class="label-sm">Manifest URL (paste into Eclipse)</div><code id="genUrl"></code></div>';
  h += '<div class="lbl">Existing addon URL</div>';
  h += '<input id="existingUrl" placeholder="Paste a previously generated addon URL">';
  h += '<button id="refBtn" onclick="refreshUrl()">Refresh existing URL</button>';
  h += '<div class="box" id="refBox"><div class="label-sm">Refreshed manifest URL</div><code id="refUrl"></code></div>';
  h += '<div class="lbl">CSV export</div>';
  h += '<div class="row"><button onclick="exportCsv()">Export history CSV</button></div>';
  h += '<p class="small" style="margin-top:10px">Keep your URL safe – it is tied to your token and settings.</p>';
  h += '</div>';
  h += '<script>';
  h += 'let currentToken="";';
  h += 'function generate(){const btn=document.getElementById("genBtn");const cid=document.getElementById("clientId").value.trim()||null;const yt=document.getElementById("ytApiKey").value.trim()||null;';
  h += 'btn.disabled=true;btn.textContent="Generating...";';
  h += 'fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:cid,ytApiKey:yt})})';
  h += '.then(r=>r.json()).then(d=>{if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate my addon URL";return;}';
  h += 'currentToken=d.token;document.getElementById("genUrl").textContent=d.manifestUrl;';
  h += 'document.getElementById("genBox").style.display="block";btn.disabled=false;btn.textContent="Regenerate URL";})';
  h += '.catch(e=>{alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate my addon URL";});}';
  h += 'function refreshUrl(){const btn=document.getElementById("refBtn");const eu=document.getElementById("existingUrl").value.trim();const cid=document.getElementById("clientId").value.trim()||null;const yt=document.getElementById("ytApiKey").value.trim()||null;';
  h += 'if(!eu){alert("Paste an existing addon URL first.");return;}btn.disabled=true;btn.textContent="Refreshing...";';
  h += 'fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu,clientId:cid,ytApiKey:yt})})';
  h += '.then(r=>r.json()).then(d=>{if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Refresh existing URL";return;}';
  h += 'currentToken=d.token;document.getElementById("refUrl").textContent=d.manifestUrl;';
  h += 'document.getElementById("refBox").style.display="block";btn.disabled=false;btn.textContent="Refresh existing URL";})';
  h += '.catch(e=>{alert("Error: "+e.message);btn.disabled=false;btn.textContent="Refresh existing URL";});}';
  h += 'function exportCsv(){if(!currentToken){alert("Generate or refresh a URL first.");return;}window.location.href="/u/"+currentToken+"/export.csv";}';
  h += '</script></body></html>';
  return h;
}

// ─── Routes: config page / generate / refresh / health ──────────────────────
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
  const cid      = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : null;
  const ytApiKey = (req.body && req.body.ytApiKey) ? String(req.body.ytApiKey).trim() : null;

  if (cid && !/^[a-zA-Z0-9]{20,40}$/.test(cid)) {
    return res.status(400).json({ error: 'Invalid client_id.' });
  }
  if (ytApiKey && !/^[A-Za-z0-9_\-]{25,60}$/.test(ytApiKey)) {
    return res.status(400).json({ error: 'Invalid YouTube API key format.' });
  }

  const token = generateToken();
  const entry = { clientId: cid || null, ytApiKey: ytApiKey || null, createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async (req, res) => {
  const raw = (req.body && req.body.existingUrl) ? String(req.body.existingUrl).trim() : '';
  const cid = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : null;
  const ytApiKey = (req.body && req.body.ytApiKey) ? String(req.body.ytApiKey).trim() : null;

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
  }
  if (ytApiKey) {
    if (!/^[A-Za-z0-9_\-]{25,60}$/.test(ytApiKey)) {
      return res.status(400).json({ error: 'Invalid YouTube API key format.' });
    }
    entry.ytApiKey = ytApiKey;
  }
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);

  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

app.get('/health', (req, res) => {
  res.json({
    status:              'ok',
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
    id:          'com.eclipse.allinone.' + req.params.token.slice(0, 8),
    name:        'All-in-One',
    version:     '1.0.0',
    description: 'Search using SoundCloud + YouTube (Music/Data API).',
    icon:        'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRmBwAaJXf-E_3leRupHphGAs7ZH51og_IkfAgvW7vfgA&s=10',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist', 'file']
  });
});

// ─── Search: SC + YTM + YouTube Data API ────────────────────────────────────
app.get('/u/:token/search', tokenMiddleware, async (req, res) => {
  const q = cleanText(req.query.q);
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });

  const cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id yet. Retry in a few seconds.' });

  try {
    // SoundCloud: tracks + playlists + users
    const results = await Promise.all([
      scGet(cid, 'https://api-v2.soundcloud.com/search/tracks',    { q, limit: 40, offset: 0, linked_partitioning: 1 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/playlists', { q, limit: 15, offset: 0 }),
      scGet(cid, 'https://api-v2.soundcloud.com/search/users',     { q, limit: 10, offset: 0 })
    ].map(p => p.catch(() => null)));

    const trackRes = results[0] || { collection: [] };
    const plRes    = results[1] || { collection: [] };
    const userRes  = results[2] || { collection: [] };

    const allPl = plRes.collection || [];

    const scTracks = (trackRes.collection || [])
      .filter(t => t && isFullyPlayable(t))
      .map(t => {
        rememberTrack(t);
        const m = parseArtistTitle(t);
        return {
          id:         'sc:' + String(t.id),
          title:      m.title || 'Unknown',
          artist:     m.artist || 'Unknown',
          album:      null,
          duration:   t.duration ? Math.floor(t.duration / 1000) : null,
          artworkURL: artworkUrl(t.artwork_url),
          format:     'aac'
        };
      });

    const scAlbums = allPl
      .filter(p => p.is_album === true)
      .map(p => ({
        id:         'scalb:' + String(p.id),
        title:      p.title || 'Unknown',
        artist:     (p.user && p.user.username) || 'Unknown',
        artworkURL: artworkUrl(p.artwork_url),
        trackCount: p.track_count || null,
        year:       scYear(p)
      }));

    const scPlaylists = allPl
      .filter(p => !p.is_album)
      .map(p => ({
        id:         'scpl:' + String(p.id),
        title:      p.title || 'Unknown',
        description: p.description || null,
        artworkURL: artworkUrl(p.artwork_url),
        creator:     (p.user && p.user.username) || null,
        trackCount:  p.track_count || null
      }));

    const scArtists = (userRes.collection || []).map(u => ({
      id:         'scart:' + String(u.id),
      name:       u.username || 'Unknown',
      artworkURL: artworkUrl(u.avatar_url),
      genres:     u.genre ? [u.genre] : []
    }));

    // YouTube Music (node-youtube-music) – may 404 from Render; keep but log
    let ytmTracks = [];
    let ytmArtists = [];
    let ytmAlbums = [];
    let ytmPlaylists = [];

    try {
      const ytmRes = await searchMusics(q);
      ytmTracks = (ytmRes || []).map(m => ({
        id:       'yt:' + m.youtubeId,
        title:    m.title,
        artist:   (m.artists && m.artists.length ? m.artists[0].name : '') || '',
        album:    m.album && m.album.name ? m.album.name : '',
        duration: m.duration && m.duration.totalSeconds ? m.duration.totalSeconds : null,
        artworkURL: m.thumbnailUrl || undefined,
        format: 'aac'
      }));
    } catch (e) {
      console.warn('[ytm] searchMusics failed:', e.message);
    }

    try {
      const resArtists = await searchArtists(q);
      ytmArtists = (resArtists || []).map(a => ({
        id:         'ytart:' + a.artistId,
        name:       a.name,
        artworkURL: a.thumbnails && a.thumbnails.length ? a.thumbnails[0].url : null,
        genres:     []
      }));
    } catch (e) {
      console.warn('[ytm] searchArtists failed:', e.message);
    }

    try {
      const resAlbums = await searchAlbums(q);
      ytmAlbums = (resAlbums || []).map(a => ({
        id:         'ytalb:' + a.albumId,
        title:      a.name,
        artist:     a.artist && a.artist.name ? a.artist.name : '',
        artworkURL: a.thumbnails && a.thumbnails.length ? a.thumbnails[0].url : null,
        trackCount: null,
        year:       a.year || undefined
      }));
    } catch (e) {
      console.warn('[ytm] searchAlbums failed:', e.message);
    }

    try {
      const resPlaylists = await searchPlaylists(q);
      ytmPlaylists = (resPlaylists || []).map(p => ({
        id:         'ytpl:' + p.playlistId,
        title:      p.title,
        description: '',
        artworkURL: p.thumbnails && p.thumbnails.length ? p.thumbnails[0].url : null,
        creator:    '',
        trackCount: null
      }));
    } catch (e) {
      console.warn('[ytm] searchPlaylists failed:', e.message);
    }

    // YouTube Data API search (official, uses ytApiKey)
    let ytTracks = [], ytAlbums = [], ytArtists = [], ytPlaylists = [];
    if (req.tokenEntry.ytApiKey) {
      try {
        const ytData = await youtubeSearch(req.tokenEntry.ytApiKey, q);
        ytTracks    = ytData.tracks    || [];
        ytAlbums    = ytData.albums    || [];
        ytArtists   = ytData.artists   || [];
        ytPlaylists = ytData.playlists || [];
      } catch (e) {
        console.warn('[ytapi] search failed:', e.message);
      }
    }

    return res.json({
      tracks:    scTracks.concat(ytmTracks).concat(ytTracks),
      albums:    scAlbums.concat(ytmAlbums).concat(ytAlbums),
      artists:   scArtists.concat(ytmArtists).concat(ytArtists),
      playlists: scPlaylists.concat(ytmPlaylists).concat(ytPlaylists)
    });
  } catch (e) {
    console.error('[search] error', e.message);
    return res.status(500).json({ error: 'Search failed.' });
  }
});

// ─── Artist details (SC + YTM + YouTube API) ────────────────────────────────
app.get('/u/:token/artist/:id', tokenMiddleware, async (req, res) => {
  let rawId = req.params.id || '';

  let prefix = null;
  let artistId = null;

  if (rawId.startsWith('ytart:')) {
    prefix   = 'ytart';
    artistId = rawId.slice('ytart:'.length);
  } else if (rawId.startsWith('scart:')) {
    prefix   = 'scart';
    artistId = rawId.slice('scart:'.length);
  } else if (rawId.startsWith('ytartist_')) {
    prefix   = 'ytartist';
    artistId = rawId.slice('ytartist_'.length);
  } else if (/^[a-zA-Z0-9_-]{6,}$/.test(rawId)) {
    prefix   = 'ytart';
    artistId = rawId;
    rawId    = 'ytart:' + artistId;
  } else if (/^\d+$/.test(rawId)) {
    prefix   = 'scart';
    artistId = rawId;
    rawId    = 'scart:' + artistId;
  }

  const cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  try {
    // YTM artist
    if (prefix === 'ytart') {
      const artist = await getArtist(artistId);[web:62]
      const name = artist.name || 'Artist';
      const artworkURL =
        artist.thumbnails && artist.thumbnails.length
          ? artist.thumbnails[0].url
          : null;

      const topTracks = (artist.songs || []).map(m => ({
        id:       'yt:' + m.youtubeId,
        title:    m.title,
        artist:   name,
        duration: m.duration && m.duration.totalSeconds
          ? m.duration.totalSeconds
          : null
      }));

      let albums = (artist.albums || []).map(a => ({
        id:         'ytalb:' + a.albumId,
        title:      a.name,
        artist:     name,
        artworkURL: a.thumbnailUrl || artworkURL,
        trackCount: null,
        year:       a.year || undefined
      }));

      if (!albums.length && artistId) {
        try {
          const { listAlbumsFromArtist } = require('node-youtube-music');[web:74]
          const albList = await listAlbumsFromArtist(artistId);
          albums = (albList || []).map(a => ({
            id:         'ytalb:' + a.albumId,
            title:      a.name,
            artist:     name,
            artworkURL: a.thumbnails && a.thumbnails.length ? a.thumbnails[0].url : artworkURL,
            trackCount: null,
            year:       a.year || undefined
          }));
        } catch (e2) {
          console.warn('[artist] YTM listAlbumsFromArtist failed:', e2.message);
        }
      }

      return res.json({
        id: rawId,
        name,
        artworkURL,
        bio: '',
        genres: [],
        topTracks,
        albums
      });
    }

    // YouTube Data API artist (channel)
    if (prefix === 'ytartist' && req.tokenEntry.ytApiKey) {
      const channelId = artistId;
      const items = await getYoutubeChannelVideos(req.tokenEntry.ytApiKey, channelId);
      if (!items.length) return res.status(404).json({ error: 'No videos found for this channel.' });
      const topTracks = items.slice(0, 8).map(item =>
        mapYoutubeToTrack(String(item.id?.videoId || ''), item.snippet || {}, null)
      );
      const albums = items.slice(0, 8).map(item => ({
        id: 'ytalbum_' + String(item.id?.videoId || ''),
        title: cleanText(item.snippet?.title || ''),
        artist: cleanText(item.snippet?.channelTitle || ''),
        artworkURL: pickArt(item.snippet),
        trackCount: 1,
        year: null
      }));
      return res.json({
        id: rawId,
        name: cleanText(items[0].snippet?.channelTitle || 'YouTube'),
        artworkURL: pickArt(items[0].snippet),
        bio: null,
        genres: [],
        topTracks,
        albums
      });
    }

    // SC artist (unchanged)
    if (prefix === 'scart') {
      let artist;
      try {
        artist = await scGet(
          cid,
          `https://api-v2.soundcloud.com/users/${artistId}`
        );
      } catch (e) {
        console.warn('[artist] SC user 403/err, will fall back to local search:', e.message);
      }

      let topTracks = [];

      if (artist) {
        try {
          const tracksRes = await scGet(
            cid,
            `https://api-v2.soundcloud.com/users/${artistId}/tracks`,
            { limit: 25, linked_partitioning: 1 }
          );

          topTracks = (tracksRes.collection || [])
            .filter(t => t && isFullyPlayable(t))
            .map(t => {
              rememberTrack(t);
              const m = parseArtistTitle(t);
              return {
                id:       'sc:' + String(t.id),
                title:    m.title || 'Unknown',
                artist:   m.artist || artist.username || 'Unknown',
                duration: t.duration ? Math.floor(t.duration / 1000) : null
              };
            });
        } catch (e2) {
          console.warn('[artist] SC tracks 403/err, will fall back to local search:', e2.message);
        }
      }

      if ((!artist || topTracks.length === 0) && rawId) {
        try {
          const baseUrl = getBaseUrl(req);
          const name = artist?.username || rawId;
          const r = await axios.get(
            `${baseUrl}/u/${req.params.token}/search`,
            { params: { q: name }, timeout: 6000 }
          );

          const body = r.data || {};
          const fromTracks = (body.tracks || []).filter(
            t => t && t.id && String(t.id).startsWith('sc:')
          );

          topTracks = fromTracks.slice(0, 25).map(t => ({
            id:       t.id,
            title:    t.title,
            artist:   t.artist || (artist && artist.username) || 'Unknown',
            duration: t.duration || null
          }));
        } catch (e3) {
          console.warn('[artist] local /search fallback failed:', e3.message);
        }
      }

      let albums = [];
      try {
        const baseUrl = getBaseUrl(req);
        const name = artist?.username || rawId;
        const r = await axios.get(
          `${baseUrl}/u/${req.params.token}/search`,
          { params: { q: name }, timeout: 6000 }
        );
        const body = r.data || {};

        const fromAlbums = (body.albums || []).filter(
          a => a && a.id && String(a.id).startsWith('scalb:')
        );

        albums = fromAlbums.slice(0, 50).map(a => ({
          id:         a.id,
          title:      a.title,
          artist:     a.artist || (artist && artist.username) || 'Unknown',
          artworkURL: a.artworkURL || null,
          trackCount: a.trackCount || null,
          year:       a.year || undefined
        }));
      } catch (e4) {
        console.warn('[artist] SC albums from /search failed:', e4.message);
      }

      return res.json({
        id: rawId,
        name: (artist && artist.username) || 'Unknown',
        artworkURL: artist ? artworkUrl(artist.avatar_url) : null,
        bio: artist ? (artist.description || '') : '',
        genres: artist && artist.genre ? [artist.genre] : [],
        topTracks,
        albums
      });
    }

    return res.status(400).json({ error: 'Unsupported or malformed artist id' });
  } catch (e) {
    console.error('[artist] error', e.message);
    res.status(500).json({ error: 'Artist lookup failed.' });
  }
});

// ─── Album details (SC + YTM + YouTube API) ─────────────────────────────────
app.get('/u/:token/album/:id', tokenMiddleware, async (req, res) => {
  const rawId = req.params.id || '';
  const [prefix, albumId] = rawId.split(':', 2);

  const cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  try {
    if (prefix === 'ytalb') {
      const tracksData = await listMusicsFromAlbum(albumId);[web:62]
      const tracks = (tracksData || []).map(m => ({
        id:       'yt:' + m.youtubeId,
        title:    m.title,
        artist:   (m.artists && m.artists.length ? m.artists[0].name : '') || '',
        duration: m.duration && m.duration.totalSeconds ? m.duration.totalSeconds : null
      }));

      return res.json({
        id: rawId,
        title: tracksData && tracksData.length ? tracksData[0].album?.name || 'Album' : 'Album',
        artist: tracksData && tracksData.length
          ? (tracksData[0].artists && tracksData[0].artists.length ? tracksData[0].artists[0].name : '')
          : '',
        artworkURL: tracksData && tracksData.length ? tracksData[0].thumbnailUrl || null : null,
        year: undefined,
        description: '',
        trackCount: tracks.length,
        tracks
      });
    }

    if (rawId.startsWith('ytalbum_') && req.tokenEntry.ytApiKey) {
      const videoId = rawId.replace('ytalbum_', '');
      const detail = await getYoutubeVideo(req.tokenEntry.ytApiKey, videoId);
      if (!detail) return res.status(404).json({ error: 'Album not found.' });
      const track = mapYoutubeToTrack(videoId, detail.snippet || {}, detail.contentDetails);
      return res.json({
        id: rawId,
        title: track.title,
        artist: track.artist,
        artworkURL: track.artworkURL,
        year: String(detail.snippet?.publishedAt || '').slice(0, 4) || null,
        description: cleanText(detail.snippet?.description || '').slice(0, 700),
        trackCount: 1,
        tracks: [track]
      });
    }

    if (prefix === 'scalb') {
      const pl = await scGet(cid, `https://api-v2.soundcloud.com/playlists/${albumId}`);
      const tracks = (pl.tracks || [])
        .filter(t => t && isFullyPlayable(t))
        .map(t => {
          rememberTrack(t);
          const m = parseArtistTitle(t);
          return {
            id:       'sc:' + String(t.id),
            title:    m.title || 'Unknown',
            artist:   m.artist || (pl.user && pl.user.username) || 'Unknown',
            duration: t.duration ? Math.floor(t.duration / 1000) : null
          };
        });

      return res.json({
        id: rawId,
        title: pl.title || 'Album',
        artist: (pl.user && pl.user.username) || 'Unknown',
        artworkURL: artworkUrl(pl.artwork_url),
        year: scYear(pl),
        description: pl.description || '',
        trackCount: tracks.length,
        tracks
      });
    }

    return res.status(400).json({ error: 'Unsupported album id' });
  } catch (e) {
    console.error('[album] error', e.message);
    res.status(500).json({ error: 'Album lookup failed.' });
  }
});

// ─── Playlist details (SC + YouTube API) ────────────────────────────────────
app.get('/u/:token/playlist/:id', tokenMiddleware, async (req, res) => {
  const rawId = req.params.id || '';
  const [prefix, playlistId] = rawId.split(':', 2);

  const cid = effectiveCid(req.tokenEntry);
  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  try {
    if (prefix === 'scpl') {
      const pl = await scGet(cid, `https://api-v2.soundcloud.com/playlists/${playlistId}`);
      const tracks = (pl.tracks || [])
        .filter(t => t && isFullyPlayable(t))
        .map(t => {
          rememberTrack(t);
          const m = parseArtistTitle(t);
          return {
            id:       'sc:' + String(t.id),
            title:    m.title || 'Unknown',
            artist:   m.artist || (pl.user && pl.user.username) || 'Unknown',
            duration: t.duration ? Math.floor(t.duration / 1000) : null
          };
        });

      return res.json({
        id: rawId,
        title: pl.title || 'Playlist',
        description: pl.description || '',
        artworkURL: artworkUrl(pl.artwork_url),
        creator: (pl.user && pl.user.username) || null,
        tracks
      });
    }

    if (rawId.startsWith('ytplaylist_') && req.tokenEntry.ytApiKey) {
      const channelId = rawId.replace('ytplaylist_', '');
      const items = await getYoutubeChannelVideos(req.tokenEntry.ytApiKey, channelId);
      if (!items.length) return res.status(404).json({ error: 'No videos found.' });
      const tracks = items.slice(0, 12).map(item =>
        mapYoutubeToTrack(String(item.id?.videoId || ''), item.snippet || {}, null)
      );
      return res.json({
        id: rawId,
        title: cleanText(items[0].snippet?.channelTitle || 'YouTube') + ' Picks',
        description: 'Top results from this YouTube channel.',
        artworkURL: pickArt(items[0].snippet),
        creator: cleanText(items[0].snippet?.channelTitle || 'YouTube'),
        tracks
      });
    }

    return res.status(400).json({ error: 'Unsupported playlist id' });
  } catch (e) {
    console.error('[playlist] error', e.message);
    res.status(500).json({ error: 'Playlist lookup failed.' });
  }
});

// ─── Stream: HiFi first, SoundCloud fallback (unchanged, no YT streaming) ──
app.get('/u/:token/stream/:id', tokenMiddleware, async (req, res) => {
  const cid   = effectiveCid(req.tokenEntry);
  const rawId = req.params.id || '';
  const [prefix, rest] = rawId.split(':', 2);

  if (!cid) return res.status(503).json({ error: 'No client_id available.' });

  let meta = { title: '', artist: '', uploader: '' };
  let track = null;

  if (prefix === 'sc') {
    const tid = rest;
    try {
      try {
        track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/soundcloud:tracks:' + tid);
      } catch (_e) {
        track = await scGet(cid, 'https://api-v2.soundcloud.com/tracks/' + tid);
      }
      if (track) {
        rememberTrack(track);
        meta = parseArtistTitle(track);
      }
    } catch (e) {
      console.warn('[stream] SC lookup failed', e.message);
    }
  }

  const albumName =
    track && track.publisher_metadata && track.publisher_metadata.release_title
      ? track.publisher_metadata.release_title
      : null;

  // 1) HiFi first
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

  // 2) SoundCloud fallback for SC tracks
  if (prefix === 'sc') {
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
  }

  // For YouTube IDs we do not stream (search only)
  return res.status(404).json({ error: 'No stream found.' });
});

// ─── CSV export ──────────────────────────────────────────────────────────────
app.get('/u/:token/export.csv', async (req, res) => {
  const token = req.params.token;
  if (!redis) {
    return res.status(500).send('Redis not configured.');
  }
  const key = 'history:' + token;
  const lines = await redis.lrange(key, 0, -1);

  const rows = [
    ['timestamp', 'action', 'query', 'id', 'title', 'artist'].join(',')
  ];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const row = [
        obj.timestamp || '',
        obj.action || '',
        obj.query || '',
        obj.id || '',
        (obj.title || '').replace(/"/g, '""'),
        (obj.artist || '').replace(/"/g, '""')
      ];
      rows.push(row.join(','));
    } catch (_) {}
  }

  const csv = rows.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="eclipse-allinone-addon-${token}.csv"`
  );
  res.send(csv);
});

// ─── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('All-in-One Music Addon on http://localhost:' + PORT);
});
