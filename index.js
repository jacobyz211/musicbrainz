const express = require('express');
const cors = require('cors');
const axios = require('axios');
const morgan = require('morgan');
const { nanoid } = require('nanoid');
const { createClient } = require('redis');

// ---------- CONFIG ----------

const app = express();
const PORT = process.env.PORT || 3000;

// Redis: use REDIS_URL on Render, fallback to local
// Example REDIS_URL: redis://default:password@hostname:6379
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = createClient({
  url: REDIS_URL
});

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

// HiFi instances – replace with real instance URLs for your setup
const HIFI_INSTANCES = [
  'https://api.listen.hifi.example',
  'https://another-hifi-instance.example'
];

// ---------- HELPERS: REDIS STORAGE ----------

// Token key
const tokenKey = (token) => `token:${token}`;
const historyKey = (token) => `history:${token}`;
const rateKey = (token) => `rate:${token}`;

// Ensure token hash exists
async function ensureToken(token) {
  const exists = await redis.exists(tokenKey(token));
  if (!exists) {
    await redis.hSet(tokenKey(token), {
      clientId: ''
    });
  }
}

// Get token data
async function getTokenData(token) {
  await ensureToken(token);
  const data = await redis.hGetAll(tokenKey(token));
  return {
    clientId: data.clientId || ''
  };
}

// Set client ID
async function setClientId(token, clientId) {
  await ensureToken(token);
  await redis.hSet(tokenKey(token), { clientId: clientId || '' });
}

// Log history item as JSON line in a Redis list
async function logHistory(token, entry) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry
  });
  await redis.rPush(historyKey(token), line);
  // Optional: trim history to last N entries
  await redis.lTrim(historyKey(token), -1000, -1);
}

// Per-token rate limiting: 1 search/sec
async function checkSearchRate(token) {
  const key = rateKey(token);
  const now = Date.now();
  const lastStr = await redis.get(key);
  const last = lastStr ? parseInt(lastStr, 10) : 0;
  if (now - last < 1000) {
    return false;
  }
  await redis.set(key, String(now));
  return true;
}

// ---------- HELPERS: MUSICBRAINZ ----------

async function mbGet(path, params = {}) {
  const url = `${MB_BASE}${path}`;
  const res = await axios.get(url, {
    params: {
      fmt: 'json',
      ...params
    },
    headers: {
      'User-Agent': 'Eclipse-MusicBrainz-Addon/1.0.0 (example@example.com)'
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

// ---------- HELPERS: AUDIO SEARCH ----------

// Build query string for audio lookup
function buildTrackQuery(meta) {
  const parts = [];
  if (meta.artist) parts.push(meta.artist);
  if (meta.title) parts.push(meta.title);
  return parts.join(' - ') || meta.title || '';
}

// HiFi search – returns first playable stream or null
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
          durationMs: playable.durationMs || null,
          source: 'audio'
        };
      }
    } catch (e) {
      // Try next instance
    }
  }
  return null;
}

// SoundCloud search with duration filter
async function searchSoundCloudTrack(clientId, query, { minDurationMs = 45000 }) {
  if (!clientId) return null;

  const url = 'https://api-v2.soundcloud.com/search/tracks';
  const params = {
    q: query,
    client_id: clientId,
    limit: 5
  };

  const res = await axios.get(url, { params, timeout: 5000 });
  const tracks = res.data && res.data.collection ? res.data.collection : [];

  const filtered = tracks.filter(t => {
    const d = t.duration || 0;
    if (d < minDurationMs) return false;
    if (Math.abs(d - 30000) < 2000) return false;
    const title = (t.title || '').toLowerCase();
    if (title.includes('preview')) return false;
    return t.streamable && t.media && t.media.transcodings && t.media.transcodings.length > 0;
  });

  if (!filtered.length) return null;

  const track = filtered[0];
  const prog = track.media.transcodings.find(tr => tr.format && tr.format.protocol === 'progressive') ||
               track.media.transcodings[0];

  const transcodingsRes = await axios.get(prog.url, {
    params: { client_id: clientId },
    timeout: 5000
  });

  const finalUrl = transcodingsRes.data && transcodingsRes.data.url ? transcodingsRes.data.url : null;
  if (!finalUrl) return null;

  return {
    url: finalUrl,
    format: 'mp3',
    quality: 'high',
    durationMs: track.duration || null,
    source: 'audio'
  };
}

// Parse internal IDs: "rec:xxxx", "alb:xxxx" etc.
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
  <title>Eclipse MusicBrainz Addon</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
    h1 { font-size: 24px; }
    input[type=text] { width: 100%; padding: 8px; margin: 4px 0 10px; box-sizing: border-box; }
    button { padding: 8px 12px; margin-right: 8px; cursor: pointer; }
    code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; }
    .section { margin-bottom: 24px; }
    .token-box { background: #fafafa; padding: 12px; border-radius: 6px; border: 1px solid #eee; }
    .small { font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <h1>Eclipse MusicBrainz Addon</h1>

  <div class="section">
    <p>This addon exposes a catalog and audio source for Eclipse Music, with per-user configuration, Redis-backed storage, and safe search rate limits.</p>
  </div>

  <div class="section">
    <h2>1. Generate your addon URL</h2>
    <button onclick="generateToken()">Generate addon URL</button>
    <div id="tokenInfo" class="token-box" style="display:none;">
      <p><strong>Your token:</strong> <span id="tokenValue"></span></p>
      <p><strong>Base URL:</strong> <code id="baseUrl"></code></p>
      <p><strong>Manifest URL:</strong> <code id="manifestUrl"></code></p>
      <p class="small">Paste the manifest URL into Eclipse: Settings → Connections → Add Connection → Addon.</p>
    </div>
  </div>

  <div class="section">
    <h2>2. Configure audio client ID</h2>
    <p>You can set or automatically generate an audio source client ID used for resolving streams.</p>
    <input type="text" id="clientIdInput" placeholder="Enter client ID (optional)" />
    <button onclick="saveClientId()">Save client ID</button>
    <button onclick="autoClientId()">Auto-generate client ID</button>
    <p id="clientIdStatus" class="small"></p>
  </div>

  <div class="section">
    <h2>3. CSV export</h2>
    <p>You can export a CSV file with recent searches and plays for the generated token.</p>
    <button onclick="exportCsv()">Export CSV</button>
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
        .catch(err => alert('Error generating token'));
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
          document.getElementById('clientIdStatus').textContent = 'Client ID saved for this token.';
        })
        .catch(() => {
          document.getElementById('clientIdStatus').textContent = 'Error saving client ID.';
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
          document.getElementById('clientIdStatus').textContent = 'Client ID generated and saved for this token.';
        })
        .catch(() => {
          document.getElementById('clientIdStatus').textContent = 'Error generating client ID.';
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

// ---------- API: TOKEN & CLIENT ID ----------

app.post('/api/new-token', async (req, res) => {
  const token = nanoid(12);
  await ensureToken(token);
  res.json({ token });
});

app.post('/api/:token/client-id', async (req, res) => {
  const token = req.params.token;
  const clientId = (req.body && req.body.clientId) || '';
  await setClientId(token, clientId);
  res.json({ ok: true });
});

// Auto-generate client ID – plug in any allowed mechanism you use to obtain one.
app.post('/api/:token/client-id/auto', async (req, res) => {
  const token = req.params.token;
  const generated = 'demo-' + nanoid(16);
  await setClientId(token, generated);
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
    id: 'com.example.musicbrainzaddon',
    name: 'MusicBrainz Addon',
    version: '1.0.0',
    description: 'Search and play music via a MusicBrainz-based catalog.',
    icon: `${req.protocol}://${req.get('host')}/static/icon.png`,
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist', 'file'],
    baseUrl
  });
});

// ---------- SEARCH ----------

app.get('/u/:token/search', async (req, res) => {
  const token = req.params.token;
  const q = (req.query.q || '').trim();

  if (!q) {
    return res.json({});
  }

  const allowed = await checkSearchRate(token);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many requests, please slow down.' });
  }

  await logHistory(token, { action: 'search', query: q });

  try {
    const [recordData, artistData, releaseGroupData] = await Promise.all([
      mbGet('/recording', {
        query: q,
        limit: 20,
        inc: 'isrcs+releases+artist-credits'
      }),
      mbGet('/artist', {
        query: q,
        limit: 10
      }),
      mbGet('/release-group', {
        query: q,
        limit: 10,
        inc: 'artist-credits'
      })
    ]);

    const tracks = [];
    if (recordData && Array.isArray(recordData.recordings)) {
      for (const rec of recordData.recordings) {
        const id = rec.id;
        const title = rec.title || '';
        const artist = joinArtistCredits(rec['artist-credit']);
        let album = '';
        let artworkURL = '';
        let isrc = '';

        if (Array.isArray(rec.isrcs) && rec.isrcs.length > 0) {
          isrc = rec.isrcs[0];
        }

        if (Array.isArray(rec.releases) && rec.releases.length > 0) {
          const rel = rec.releases[0];
          album = rel.title || '';
          if (rel.id) {
            artworkURL = getCoverArtForRelease(rel.id);
          }
        }

        const duration = rec.length ? Math.round(rec.length / 1000) : null;

        tracks.push({
          id: `rec:${id}`,
          title,
          artist,
          album,
          duration,
          artworkURL: artworkURL || undefined,
          isrc: isrc || undefined,
          format: 'flac'
        });
      }
    }

    const artists = [];
    if (artistData && Array.isArray(artistData.artists)) {
      for (const a of artistData.artists) {
        const name = a.name || '';
        const genres = Array.isArray(a.tags)
          ? a.tags.map(t => t.name).filter(Boolean)
          : [];
        artists.push({
          id: `art:${a.id}`,
          name,
          artworkURL: `${req.protocol}://${req.get('host')}/static/icon.png`,
          genres
        });
      }
    }

    const albums = [];
    if (releaseGroupData && Array.isArray(releaseGroupData['release-groups'])) {
      for (const rg of releaseGroupData['release-groups']) {
        const title = rg.title || '';
        const artist = joinArtistCredits(rg['artist-credit']);
        const firstReleaseDate = rg['first-release-date'] || '';
        const year = firstReleaseDate ? String(firstReleaseDate).slice(0, 4) : '';
        const artworkURL = rg.id ? getCoverArtForReleaseGroup(rg.id) : '';

        albums.push({
          id: `alb:${rg.id}`,
          title,
          artist,
          artworkURL: artworkURL || undefined,
          trackCount: null,
          year: year || undefined
        });
      }
    }

    // Simple virtual playlist based on search results
    const playlistId = `pl:search:${Buffer.from(q).toString('base64url').slice(0, 16)}`;
    const playlists = [
      {
        id: playlistId,
        title: `Search: ${q}`,
        description: 'Playlist generated from recent search results.',
        artworkURL: `${req.protocol}://${req.get('host')}/static/icon.png`,
        creator: 'MusicBrainz Addon',
        trackCount: tracks.length
      }
    ];

    res.json({
      tracks,
      albums,
      artists,
      playlists
    });
  } catch (e) {
    console.error('Search error', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ---------- STREAM ----------

app.get('/u/:token/stream/:id', async (req, res) => {
  const token = req.params.token;
  const rawId = req.params.id;
  const { prefix, rest } = parseInternalId(rawId);

  // In this implementation, we lookup metadata from MusicBrainz again
  // to build a good search query for the audio resolver.
  let meta = {
    title: '',
    artist: '',
    album: ''
  };

  try {
    if (prefix === 'rec') {
      const rec = await mbGet(`/recording/${rest}`, { inc: 'artist-credits+releases' });
      meta.title = rec.title || '';
      meta.artist = joinArtistCredits(rec['artist-credit']);
      if (Array.isArray(rec.releases) && rec.releases.length > 0) {
        meta.album = rec.releases[0].title || '';
      }
    }

    await logHistory(token, { action: 'stream', id: rawId, title: meta.title, artist: meta.artist });

    const query = buildTrackQuery(meta);

    // 1) Try HiFi instances
    let resolved = await searchHiFi(query);

    // 2) Fallback to SoundCloud using per-token client ID
    if (!resolved) {
      const tokenData = await getTokenData(token);
      resolved = await searchSoundCloudTrack(tokenData.clientId || '', query, {
        minDurationMs: 45000
      });
    }

    if (!resolved || !resolved.url) {
      return res.status(404).json({ error: 'No stream found' });
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

// ---------- ALBUM DETAILS ----------

app.get('/u/:token/album/:id', async (req, res) => {
  const rawId = req.params.id;
  const { prefix, rest } = parseInternalId(rawId);

  if (prefix !== 'alb') {
    return res.status(400).json({ error: 'Invalid album id' });
  }

  try {
    // Treat rest as release-group MBID; fetch releases and then pick first release with recordings.[web:21]
    const rg = await mbGet(`/release-group/${rest}`, {
      inc: 'artist-credits+releases'
    });

    const artist = joinArtistCredits(rg['artist-credit']);
    const title = rg.title || '';
    const firstReleaseDate = rg['first-release-date'] || '';
    const year = firstReleaseDate ? String(firstReleaseDate).slice(0, 4) : '';
    const artworkURL = getCoverArtForReleaseGroup(rest);

    let tracks = [];
    if (Array.isArray(rg.releases) && rg.releases.length > 0) {
      const releaseId = rg.releases[0].id;
      const rel = await mbGet(`/release/${releaseId}`, {
        inc: 'recordings'
      });
      if (rel.media && Array.isArray(rel.media)) {
        for (const medium of rel.media) {
          if (!Array.isArray(medium.tracks)) continue;
          for (const tr of medium.tracks) {
            const rec = tr.recording || {};
            const tTitle = rec.title || '';
            const tArtist = joinArtistCredits(rec['artist-credit']) || artist;
            const duration = rec.length ? Math.round(rec.length / 1000) : null;
            tracks.push({
              id: `rec:${rec.id}`,
              title: tTitle,
              artist: tArtist,
              duration,
              artworkURL
            });
          }
        }
      }
    }

    res.json({
      id: rawId,
      title,
      artist,
      artworkURL,
      year: year || undefined,
      description: '',
      trackCount: tracks.length,
      tracks
    });
  } catch (e) {
    console.error('Album error', e.message);
    res.status(500).json({ error: 'Album lookup failed' });
  }
});

// ---------- ARTIST DETAILS ----------

app.get('/u/:token/artist/:id', async (req, res) => {
  const rawId = req.params.id;
  const { prefix, rest } = parseInternalId(rawId);

  if (prefix !== 'art') {
    return res.status(400).json({ error: 'Invalid artist id' });
  }

  try {
    const artistData = await mbGet(`/artist/${rest}`, {
      inc: 'tags'
    });

    const name = artistData.name || '';
    const genres = Array.isArray(artistData.tags)
      ? artistData.tags.map(t => t.name).filter(Boolean)
      : [];

    // Top tracks: simple heuristic using recordings search filtered by artist MBID.[web:18]
    const recData = await mbGet('/recording', {
      query: `arid:${rest}`,
      limit: 10
    });

    const topTracks = [];
    if (recData && Array.isArray(recData.recordings)) {
      for (const rec of recData.recordings) {
        topTracks.push({
          id: `rec:${rec.id}`,
          title: rec.title || '',
          artist: name,
          duration: rec.length ? Math.round(rec.length / 1000) : null
        });
      }
    }

    const rgData = await mbGet('/release-group', {
      query: `arid:${rest}`,
      limit: 10
    });

    const albums = [];
    if (rgData && Array.isArray(rgData['release-groups'])) {
      for (const rg of rgData['release-groups']) {
        const title = rg.title || '';
        const firstReleaseDate = rg['first-release-date'] || '';
        const year = firstReleaseDate ? String(firstReleaseDate).slice(0, 4) : '';
        const artworkURL = rg.id ? getCoverArtForReleaseGroup(rg.id) : '';
        albums.push({
          id: `alb:${rg.id}`,
          title,
          artist: name,
          artworkURL: artworkURL || undefined,
          trackCount: null,
          year: year || undefined
        });
      }
    }

    res.json({
      id: rawId,
      name,
      artworkURL: `${req.protocol}://${req.get('host')}/static/icon.png`,
      bio: '',
      genres,
      topTracks,
      albums
    });
  } catch (e) {
    console.error('Artist error', e.message);
    res.status(500).json({ error: 'Artist lookup failed' });
  }
});

// ---------- PLAYLIST DETAILS (VIRTUAL) ----------

app.get('/u/:token/playlist/:id', async (req, res) => {
  const rawId = req.params.id;
  const { prefix, rest } = parseInternalId(rawId);

  if (prefix !== 'pl') {
    return res.status(400).json({ error: 'Invalid playlist id' });
  }

  // For this example, just return an empty playlist shell.
  // You can wire this to real stored searches if you want.
  res.json({
    id: rawId,
    title: 'Dynamic Playlist',
    description: 'Generated playlist.',
    artworkURL: `${req.protocol}://${req.get('host')}/static/icon.png`,
    creator: 'MusicBrainz Addon',
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
    } catch (_) {
      // ignore malformed
    }
  }

  const csv = rows.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="eclipse-musicbrainz-addon-${token}.csv"`
  );
  res.send(csv);
});

// ---------- START SERVER ----------

app.listen(PORT, () => {
  console.log(`Addon running on http://localhost:${PORT}`);
});
