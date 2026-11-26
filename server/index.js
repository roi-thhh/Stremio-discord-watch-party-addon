import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAddons,
  installAddon,
  removeAddon,
  fetchCatalog,
  searchCatalogs,
  fetchMeta,
  fetchStreams
} from './addons.js';
import {
  checkStremioServer,
  prepareStreamPlayback,
  proxyStremioRequest,
  proxyExternalRequest,
  proxyImageRequest
} from './stremioProxy.js';
import { attachSyncServer } from './sync.js';
import { attachBridgeServer } from './bridgeHub.js';
import { createStremioAddonRouter } from './stremioAddon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Public config for frontend Discord SDK initialization
app.get('/api/config', (_req, res) => {
  res.json({
    clientId: process.env.DISCORD_CLIENT_ID || ''
  });
});

// Discord Activity OAuth2 token exchange
app.post('/api/token', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing OAuth code' });

    const response = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID || '',
        client_secret: process.env.DISCORD_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ access_token: data.access_token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Local / Bridged Stremio server health
app.get('/api/stremio/status', async (req, res) => {
  res.json(await checkStremioServer(String(req.query.room || '')));
});

// Installable Stremio Addon (/configure, /manifest.json, /:config/stream/..., /queue)
app.use(createStremioAddonRouter());

// Addon management
app.get('/api/addons', async (_req, res) => {
  try {
    res.json({ addons: await getAddons() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/addons', async (req, res) => {
  try {
    const { manifestUrl } = req.body;
    if (!manifestUrl) return res.status(400).json({ error: 'manifestUrl is required' });
    const addon = await installAddon(manifestUrl);
    res.json({ addon });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/addons/:id', async (req, res) => {
  try {
    const addons = await removeAddon(req.params.id);
    res.json({ addons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stremio Addon Protocol endpoints
app.get('/api/catalog', async (req, res) => {
  try {
    const { addonId, type, id, extra } = req.query;
    const data = await fetchCatalog({ addonId, type, id, extra });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ metas: [] });
    const data = await searchCatalogs({ query: q });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/meta', async (req, res) => {
  try {
    const { type, id } = req.query;
    const data = await fetchMeta({ type, id });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/streams', async (req, res) => {
  try {
    const { type, id } = req.query;
    const data = await fetchStreams({ type, id });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Prepare stream playback (torrent -> local Stremio server / HLS)
app.post('/api/play/prepare', async (req, res) => {
  try {
    const result = await prepareStreamPlayback(req.body);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Stream & HLS proxies (for Discord Activity /.proxy/ CSP compatibility)
app.use('/proxy/r/:roomKey', (req, res) => {
  proxyStremioRequest(req, res, req.params.roomKey).catch((err) => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });
});

app.use('/proxy/stremio', (req, res) => {
  proxyStremioRequest(req, res).catch((err) => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });
});

app.get('/proxy/external', (req, res) => {
  proxyExternalRequest(req, res).catch((err) => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });
});

app.get('/proxy/image', (req, res) => {
  proxyImageRequest(req, res).catch(() => {
    if (!res.headersSent) res.status(502).end();
  });
});

const server = http.createServer(app);
const syncWss = attachSyncServer();
const bridgeWss = attachBridgeServer();

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/ws') {
    syncWss.handleUpgrade(request, socket, head, (ws) => {
      syncWss.emit('connection', ws, request);
    });
  } else if (pathname === '/bridge-ws') {
    bridgeWss.handleUpgrade(request, socket, head, (ws) => {
      bridgeWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

if (isProd) {
  const distDir = path.resolve(__dirname, '../dist');
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });
  app.use(vite.middlewares);
}

server.listen(PORT, () => {
  console.log(`Stremio Discord Activity server running on http://localhost:${PORT}`);
});
