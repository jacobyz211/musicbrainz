const express = require('express');
const cors = require('cors');
const axios = require('axios');
const morgan = require('morgan');
const { nanoid } = require('nanoid');
const { createClient } = require('redis');
const {
  searchMusics,
  searchAlbums,
  searchPlaylists,
  searchArtists
} = require('node-youtube-music');

// ---------- CONFIG ----------

const app = express();
const PORT = process.env.PORT || 3000;

// Redis: use REDIS_URL on Render, fallback to local
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = createClient({ url: REDIS_URL });

redis.on('error', (err) => {
  console.error('Redis error', err);
});

(async () => {
  try {
    await redis.connect();
    console.log('Connected to Redis');
  } catch (e) {
    console.error('Failed to connect to Redis', e);
  }
})();

// ---------- MIDDLEWARE ----------

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ---------- CONSTANTS ----------

const MB_BASE = 'https://musicbrainz.org/ws/2';
const CA_BASE = 'https://coverartarchive.org';

// HiFi instances – replace with your actual URLs
const HIFI_INSTANCES = [
  'https://api.listen.hifi.example',
  'https://another-hifi-instance.example'
];

// ---------- REDIS HELPERS ----------

const tokenKey = (token) => `token:${token}`;
const historyKey = (token) => `history:${token}`;
const rateKey = (token) => `rate:${token}`;

async function ensureToken(token) {
  const exists = await redis.exists(tokenKey(token));
  if (!exists) {
    await redis.hSet(tokenKey(token), {
      scClientId: ''
    });
  }
}

async function getTokenData(token) {
  await ensureToken(token);
  const data = await redis.hGetAll(tokenKey(token));
  return {
    scClientId: data.scClientId || ''
  };
}

async function setSoundCloudClientId(token, clientId) {
  await ensureToken(token);
  await redis.hSet(tokenKey(token), { scClientId: clientId || '' });
}

async function logHistory(token, entry) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry
  });
  await redis.rPush(historyKey(token), line);
  await redis.lTrim(historyKey(token), -1000, -1);
}

async function checkSearchRate(token) {
  const key = rateKey(token);
  const now = Date.now();
  const lastStr = await redis.get(key);
  const last = lastStr ? parseInt(lastStr, 10) : 0;
  if (now - last < 1000) return false;
  await redis.set(key, String(now));
  return true;
}

// ---------- MUSICBRAINZ HELPERS ----------

async function mbGet(path, params = {}) {
  const url = `${MB_BASE}${path}`;
  const res = await axios.get(url, {
    params: { fmt: 'json', ...params },
    headers: {
      'User-Agent': 'Eclipse-AllInOne-Addon/1.0.0 (example@example.com)'
    },
    timeout: 5000
  });
  return res.data;
}

function getCoverArtForRelease(releaseId) {
  return `${CA_BASE}/release/${releaseId}/front`;
}

function getCoverArtForReleaseGroup(releaseGroupId) {
  return `${CA_BASE}/release-group/${releaseGroupId}/front`;
}

function joinArtistCredits(credit) {
  if (!credit || !Array.isArray(credit)) return '';
  return credit.map(c => c.name || '').filter(Boolean).join(', ');
}

// Enrich ISRC via MusicBrainz when missing
async function enrichISRCWithMusicBrainz(title, artist) {
  if (!title) return null;
  try {
    const queryParts = [];
    if (artist) queryParts.push(`artist:${artist}`);
    queryParts.push(`recording:${title}`);
    const query = queryParts.join(' ');
    const data = await mbGet('/recording', {
      query,
      limit: 1,
      inc: 'isrcs'
    });
    if (!data || !Array.isArray(data.recordings) || !data.recordings.length) return null;
    const rec = data.recordings[0];
    if (Array.isArray(rec.isrcs) && rec.isrcs.length > 0) {
      return rec.isrcs[0];
    }
  } catch (e) {
    // ignore errors
  }
  return null;
}

// ---------- AUDIO SEARCH HELPERS ----------

function buildTrackQuery(meta) {
  const parts = [];
  if (meta.artist) parts.push(meta.artist);
  if (meta.title) parts.push(meta.title);
  return parts.join(' - ') || meta.title || '';
}

async function searchHiFi(query) {
  for (const base of HIFI_INSTANCES) {
    try {
      const url = `${base}/api/search`;
      const res = await axios.get(url, {
        params: { q: query, limit: 5 },
        timeout: 5000
      });
      const items = res.data && res.data.tracks ? res.data.tracks : [];
      const playable = items.find(it => it.streamUrl);
      if (playable) {
        return {
          url: playable.streamUrl,
          format: playable.format || 'flac',
          quality: playable.quality || 'lossless',
          durationMs: playable.durationMs || null
        };
      }
    } catch (e) {
      // try next instance
    }
  }
  return null;
}

// SoundCloud search – tracks only, playable, min duration, filters out previews.[web:54][web:70]
async function searchSoundCloudTracks(scClientId, query, { limit = 20, minDurationMs = 45000 }) {
  if (!scClientId) return [];
  const url = 'https://api-v2.soundcloud.com/search/tracks';
  const params = {
    q: query,
    client_id: scClientId,
    limit,
    access: 'playable',
    'duration[from]': minDurationMs
  };
  const res = await axios.get(url, { params, timeout: 5000 });
  const tracks = res.data && res.data.collection ? res.data.collection : [];

  return tracks.filter(t => {
    const d = t.duration || 0;
    if (d < minDurationMs) return false;
    if (Math.abs(d - 30000) < 2000) return false;
    const title = (t.title || '').toLowerCase();
    if (title.includes('preview')) return false;
    return t.streamable &&
      t.media &&
      Array.isArray(t.media.transcodings) &&
      t.media.transcodings.length > 0;
  });
}

async function resolveSoundCloudStream(scClientId, track) {
  if (!scClientId || !track || !track.media) return null;
  const transcodings = track.media.transcodings || [];
  if (!transcodings.length) return null;
  const prog = transcodings.find(tr => tr.format && tr.format.protocol === 'progressive') ||
               transcodings[0];

  const res = await axios.get(prog.url, {
    params: { client_id: scClientId },
    timeout: 5000
  });

  const url = res.data && res.data.url ? res.data.url : null;
  if (!url) return null;

  return {
    url,
    format: 'mp3',
    quality: 'high',
    durationMs: track.duration || null
  };
}

// ---------- ID PARSING ----------

function parseInternalId(id) {
  const [prefix, rest] = id.split(':', 2);
  return { prefix, rest };
}

// ---------- FRONTEND HTML ----------

app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Eclipse All-in-One Addon</title>
  <style>
    :root {
      --bg: #0f172a;
      --bg-alt: #111827;
      --card: #020617;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.1);
      --text: #e5e7eb;
      --muted: #9ca3af;
      --border: #1f2937;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: radial-gradient(circle at top, #111827 0, #020617 60%);
      color: var(--text);
    }
    header {
      padding: 24px 20px 16px;
      background: linear-gradient(to bottom, #020617 0, transparent 100%);
      border-bottom: 1px solid #1e293b;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 0 20px 40px;
    }
    h1 {
      font-size: 26px;
      margin: 0 0 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h1 span.logo-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 16px rgba(56, 189, 248, 0.7);
    }
    h2 {
      font-size: 18px;
      margin: 0 0 8px;
    }
    p {
      margin: 4px 0 8px;
      color: var(--muted);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: #e0f2fe;
      font-size: 11px;
      border: 1px solid rgba(56, 189, 248, 0.4);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .card {
      background: radial-gradient(circle at top left, #020617 0, #020617 40%, #020617 100%);
      border-radius: 14px;
      padding: 14px 14px 16px;
      border: 1px solid var(--border);
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.7);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .muted-sm {
      font-size: 12px;
      color: var(--muted);
    }
    input[type=text] {
      width: 100%;
      padding: 8px 10px;
      margin: 4px 0 10px;
      border-radius: 8px;
      border: 1px solid #1f2937;
      background: #020617;
      color: var(--text);
      font-size: 13px;
    }
    input[type=text]:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.5);
    }
    button {
      padding: 7px 11px;
      border-radius: 9px;
      border: 1px solid rgba(148, 163, 184, 0.4);
      background: linear-gradient(to bottom right, #1f2937, #020617);
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button.primary {
      border-color: transparent;
      background: linear-gradient(to bottom right, #38bdf8, #0ea5e9);
      color: #0b1120;
      font-weight: 500;
    }
    button:active {
      transform: translateY(1px);
    }
    code {
      background: #020617;
      padding: 3px 6px;
      border-radius: 6px;
      border: 1px solid #1f2937;
      font-size: 12px;
      color: #e5e7eb;
      display: inline-block;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 6px;
    }
    footer {
      text-align: center;
      padding-top: 16px;
      font-size: 11px;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <h1><span class="logo-dot"></span>Eclipse All-in-One Addon</h1>
      <p class="muted-sm">Search using SoundCloud + YouTube Music, stream via your configured audio sources, and keep everything isolated per token.</p>
      <div class="pill">Per-user tokens · Audio API key · CSV history</div>
    </div>
  </header>

  <div class="container">
    <div class="grid">
      <div class="card">
        <div class="card-header">
          <h2>1. Create your addon URL</h2>
        </div>
        <p class="muted-sm">Generate a private token. Eclipse will use this URL for all search and playback requests.</p>
        <button class="primary" onclick="generateToken()">Generate addon URL</button>
        <div id="tokenInfo" style="display:none; margin-top:10px;">
          <p class="muted-sm">Token</p>
          <code id="tokenValue"></code>
          <p class="muted-sm" style="margin-top:8px;">Base URL</p>
          <code id="baseUrl"></code>
          <p class="muted-sm" style="margin-top:8px;">Manifest URL (paste this into Eclipse)</p>
          <code id="manifestUrl"></code>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>2. Audio API key</h2>
        </div>
        <p class="muted-sm">
          This is your SoundCloud API key used for search and fallback streaming. You can paste your own or let the addon generate one.
        </p>
        <input type="text" id="clientIdInput" placeholder="Enter SoundCloud API key (optional)" />
        <div class="row">
          <button onclick="saveClientId()">Save key</button>
          <button onclick="autoClientId()">Auto-generate key</button>
        </div>
        <p id="clientIdStatus" class="muted-sm" style="margin-top:8px;"></p>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>3. Export history</h2>
        </div>
        <p class="muted-sm">Download a CSV of recent searches and streams for your token.</p>
        <button onclick="exportCsv()">Export CSV</button>
      </div>
    </div>

    <footer>
      Built for Eclipse Music addons · Uses SoundCloud, YouTube Music search, and a MusicBrainz-based catalog for enrichment.
    </footer>
  </div>

  <script>
    let currentToken = '';

    function generateToken() {
      fetch('/api/new-token', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          currentToken = data.token;
          document.getElementById('tokenValue').textContent = currentToken;
          const base = window.location.origin + '/u/' + currentToken + '/';
          const manifest = base + 'manifest.json';
          document.getElementById('baseUrl').textContent = base;
          document.getElementById('manifestUrl').textContent = manifest;
          document.getElementById('tokenInfo').style.display = 'block';
          document.getElementById('clientIdStatus').textContent = '';
        })
        .catch(() => alert('Error generating token'));
    }

    function requireToken() {
      if (!currentToken) {
        alert('Generate your addon URL first.');
        return false;
      }
      return true;
    }

    function saveClientId() {
      if (!requireToken()) return;
      const cid = document.getElementById('clientIdInput').value.trim();
      fetch('/api/' + encodeURIComponent(currentToken) + '/client-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: cid || null })
      })
        .then(r => r.json())
        .then(() => {
          document.getElementById('clientIdStatus').textContent = 'Audio API key saved for this token.';
        })
        .catch(() => {
          document.getElementById('clientIdStatus').textContent = 'Error saving API key.';
        });
    }

    function autoClientId() {
      if (!requireToken()) return;
      fetch('/api/' + encodeURIComponent(currentToken) + '/client-id/auto', {
        method: 'POST'
      })
        .then(r => r.json())
        .then(data => {
          document.getElementById('clientIdInput').value = data.clientId || '';
          document.getElementById('clientIdStatus').textContent = 'Audio API key generated and saved for this token.';
        })
        .catch(() => {
          document.getElementById('clientIdStatus').textContent = 'Error generating API key.';
        });
    }

    function exportCsv() {
      if (!requireToken()) return;
      window.location.href = '/u/' + encodeURIComponent(currentToken) + '/export.csv';
    }
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ---------- TOKEN & API KEY API ----------

app.post('/api/new-token', async (req, res) => {
  const token = nanoid(12);
  await ensureToken(token);
  res.json({ token });
});

app.post('/api/:token/client-id', async (req, res) => {
  const token = req.params.token;
  const clientId = (req.body && req.body.clientId) || '';
  await setSoundCloudClientId(token, clientId);
  res.json({ ok: true });
});

// Auto-generate API key – for demo, just generate a random value.
app.post('/api/:token/client-id/auto', async (req, res) => {
  const token = req.params.token;
  const generated = 'auto-' + nanoid(16);
  await setSoundCloudClientId(token, generated);
  res.json({ ok: true, clientId: generated });
});

// ---------- STATIC ICON ----------

app.get('/static/icon.png', (req, res) => {
  const img = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    'base64'
  );
  res.setHeader('Content-Type', 'image/png');
  res.send(img);
});

// ---------- MANIFEST ----------

app.get('/u/:token/manifest.json', async (req, res) => {
  const token = req.params.token;
  await ensureToken(token);

  const baseUrl = `${req.protocol}://${req.get('host')}/u/${encodeURIComponent(token)}/`;

  res.json({
    id: 'com.example.allinoneaddon',
    name: 'All-in-One Music Addon',
    version: '1.0.0',
    description: 'Search using SoundCloud + YouTube Music and play via your configured audio sources.',
    icon: `${req.protocol}://${req.get('host')}/static/icon.png`,
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist', 'file'],
    baseUrl
  });
});

// ---------- SEARCH (SoundCloud + YTM) ----------

app.get('/u/:token/search', async (req, res) => {
  const token = req.params.token;
  const q = (req.query.q || '').trim();
  if (!q) return res.json({});

  const allowed = await checkSearchRate(token);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many requests, please slow down.' });
  }

  await logHistory(token, { action: 'search', query: q });

  try {
    const tokenData = await getTokenData(token);

    // 1) SoundCloud tracks
    const scTracks = await searchSoundCloudTracks(tokenData.scClientId, q, {
      limit: 20,
      minDurationMs: 45000
    });

    const tracks = [];
    for (const t of scTracks) {
      const title = t.title || '';
      const artist = t.user && t.user.username ? t.user.username : '';
      const artworkURL = t.artwork_url || (t.user && t.user.avatar_url) || '';
      const duration = t.duration ? Math.round(t.duration / 1000) : null;

      tracks.push({
        id: `sc:${t.id}`,
        title,
        artist,
        album: '',
        duration,
        artworkURL: artworkURL || undefined,
        format: 'mp3'
      });
    }

    // 2) YouTube Music search for tracks
    let ytmTracks = [];
    try {
      const ytmResults = await searchMusics(q);
      ytmTracks = (ytmResults || []).map(m => {
        return {
          id: `yt:${m.youtubeId}`,
          title: m.title,
          artist: (m.artists && m.artists.length ? m.artists[0].name : '') || '',
          album: m.album && m.album.name ? m.album.name : '',
          duration: m.duration && m.duration.totalSeconds ? m.duration.totalSeconds : null,
          artworkURL: m.thumbnailUrl || undefined,
          isrc: undefined,
          format: 'mp3'
        };
      });
    } catch (e) {
      // ignore YTM failures
    }

    // 3) Artists and albums from YTM search (simple)
    let artists = [];
    let albums = [];
    let playlists = [];

    try {
      const ytmArtists = await searchArtists(q);
      artists = (ytmArtists || []).map(a => ({
        id: `ytart:${a.artistId}`,
        name: a.name,
        artworkURL: a.thumbnails && a.thumbnails.length ? a.thumbnails[0].url : `${req.protocol}://${req.get('host')}/static/icon.png`,
        genres: []
      }));
    } catch (e) {}

    try {
      const ytmAlbums = await searchAlbums(q);
      albums = (ytmAlbums || []).map(a => ({
        id: `ytalb:${a.albumId}`,
        title: a.name,
        artist: a.artist && a.artist.name ? a.artist.name : '',
        artworkURL: a.thumbnails && a.thumbnails.length ? a.thumbnails[0].url : `${req.protocol}://${req.get('host')}/static/icon.png`,
        trackCount: null,
        year: a.year || undefined
      }));
    } catch (e) {}

    try {
      const ytmPlaylists = await searchPlaylists(q);
      playlists = (ytmPlaylists || []).map(p => ({
        id: `ytpl:${p.playlistId}`,
        title: p.title,
        description: '',
        artworkURL: p.thumbnails && p.thumbnails.length ? p.thumbnails[0].url : `${req.protocol}://${req.get('host')}/static/icon.png`,
        creator: '',
        trackCount: null
      }));
    } catch (e) {}

    res.json({
      tracks: tracks.concat(ytmTracks),
      albums,
      artists,
      playlists
    });
  } catch (e) {
    console.error('Search error', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ---------- STREAM (HiFi first, then SoundCloud) ----------

app.get('/u/:token/stream/:id', async (req, res) => {
  const token = req.params.token;
  const rawId = req.params.id;
  const { prefix, rest } = parseInternalId(rawId);

  let meta = { title: '', artist: '' };

  try {
    if (prefix === 'sc') {
      // From SoundCloud ID
      meta = { title: '', artist: '' };
    } else if (prefix === 'yt') {
      // From YouTube Music ID
      meta = { title: '', artist: '' };
    }

    await logHistory(token, { action: 'stream', id: rawId, title: meta.title, artist: meta.artist });

    const tokenData = await getTokenData(token);
    const scClientId = tokenData.scClientId || '';

    // Build query for HiFi
    const query = buildTrackQuery(meta);

    // 1) HiFi instances
    let resolved = null;
    if (query) {
      resolved = await searchHiFi(query);
    }

    // 2) SoundCloud fallback if needed
    if (!resolved && prefix === 'sc') {
      try {
        const url = `https://api-v2.soundcloud.com/tracks/${encodeURIComponent(rest)}`;
        const trackRes = await axios.get(url, {
          params: { client_id: scClientId },
          timeout: 5000
        });
        const scTrack = trackRes.data;
        const scResolved = await resolveSoundCloudStream(scClientId, scTrack);
        if (scResolved) {
          resolved = scResolved;
          meta.title = scTrack.title || meta.title;
          meta.artist = scTrack.user && scTrack.user.username ? scTrack.user.username : meta.artist;
        }
      } catch (e) {
        // ignore
      }
    }

    // Try to enrich ISRC if still missing and we have title/artist
    if (!resolved) {
      return res.status(404).json({ error: 'No stream found' });
    } else {
      if (!meta.isrc && meta.title) {
        const isrc = await enrichISRCWithMusicBrainz(meta.title, meta.artist);
        if (isrc) meta.isrc = isrc;
      }
    }

    res.json({
      url: resolved.url,
      format: resolved.format || 'mp3',
      quality: resolved.quality || 'high'
    });
  } catch (e) {
    console.error('Stream error', e.message);
    res.status(500).json({ error: 'Stream failed' });
  }
});

// ---------- ALBUM / ARTIST / PLAYLIST (STUBS, CATALOG) ----------

app.get('/u/:token/album/:id', async (req, res) => {
  const rawId = req.params.id;
  const { prefix } = parseInternalId(rawId);
  if (!prefix) return res.status(400).json({ error: 'Invalid album id' });

  // For now, return a minimal stub – you can wire this to YTM album lookup if you want.
  res.json({
    id: rawId,
    title: 'Album',
    artist: '',
    artworkURL: `${req.protocol}://${req.get('host')}/static/icon.png`,
    year: undefined,
    description: '',
    trackCount: 0,
    tracks: []
  });
});

app.get('/u/:token/artist/:id', async (req, res) => {
  const rawId = req.params.id;
  const { prefix } = parseInternalId(rawId);
  if (!prefix) return res.status(400).json({ error: 'Invalid artist id' });

  res.json({
    id: rawId,
    name: 'Artist',
    artworkURL: `${req.protocol}://${req.get('host')}/static/icon.png`,
    bio: '',
    genres: [],
    topTracks: [],
    albums: []
  });
});

app.get('/u/:token/playlist/:id', async (req, res) => {
  const rawId = req.params.id;
  const { prefix } = parseInternalId(rawId);
  if (!prefix) return res.status(400).json({ error: 'Invalid playlist id' });

  res.json({
    id: rawId,
    title: 'Playlist',
    description: 'Generated playlist.',
    artworkURL: `${req.protocol}://${req.get('host')}/static/icon.png`,
    creator: 'All-in-One Addon',
    tracks: []
  });
});

// ---------- CSV EXPORT ----------

app.get('/u/:token/export.csv', async (req, res) => {
  const token = req.params.token;
  const key = historyKey(token);
  const lines = await redis.lRange(key, 0, -1);

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

// ---------- START SERVER ----------

app.listen(PORT, () => {
  console.log(`Addon running on http://localhost:${PORT}`);
});
