import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueMediaForRoom } from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseConfig(configParam) {
  if (!configParam) return { room: 'default' };
  try {
    const decoded = decodeURIComponent(configParam);
    if (decoded.startsWith('{')) return JSON.parse(decoded);
    const params = new URLSearchParams(decoded);
    return { room: params.get('room') || decoded };
  } catch {
    return { room: configParam };
  }
}

function buildManifest(config, origin = '') {
  return {
    id: 'community.stremio.discord.activity',
    version: '1.0.0',
    name: 'Discord Watch Party',
    description:
      'Host a synced Discord Activity watch party directly from your Stremio app.',
    ...(origin ? { logo: `${origin}/icon.jpg` } : {}),
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    },
    config: [
      {
        key: 'room',
        type: 'text',
        title: 'Discord Room Key',
        default: config?.room || 'my-room'
      }
    ]
  };
}

export function createStremioAddonRouter() {
  const router = express.Router();

  router.get('/configure', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    const hostNoProto = req.get('host');

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Stremio Discord Activity — Addon Setup</title>
  <style>
    body { margin:0; font-family: system-ui, sans-serif; background:#0c0b13; color:#f3f2f8; display:flex; justify-content:center; padding:40px 16px; }
    .card { max-width:620px; width:100%; background:#161423; border:1px solid #2e2a45; border-radius:14px; padding:28px; }
    h1 { margin-top:0; font-size:1.5rem; }
    p { color:#9b96b5; line-height:1.5; }
    label { display:block; font-weight:600; margin:16px 0 6px; }
    input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #2e2a45; background:#1f1c30; color:#fff; box-sizing:border-box; }
    .row { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
    .btn { padding:10px 18px; border-radius:8px; border:none; font-weight:600; cursor:pointer; text-decoration:none; display:inline-block; }
    .btn-primary { background:#7b5bf5; color:#fff; }
    .btn-secondary { background:#1f1c30; color:#f3f2f8; border:1px solid #2e2a45; }
    pre { background:#0c0b13; border:1px solid #2e2a45; padding:12px; border-radius:8px; overflow-x:auto; font-size:0.85rem; }
    code { color:#b8a9ff; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Discord Watch Party — Stremio Addon</h1>
    <p>Install this addon in Stremio to get a <strong>"Host Watch Party in Discord"</strong> button on every movie and episode.</p>

    <label for="room-input">1. Your Room Key (use the same key inside the Discord Activity)</label>
    <div class="row" style="margin-top:6px">
      <input id="room-input" type="text" style="flex:1" />
      <button id="gen-btn" class="btn btn-secondary" type="button">Randomize</button>
    </div>

    <div class="row">
      <a id="install-link" class="btn btn-primary" href="#">Install in Stremio</a>
      <button id="copy-manifest-btn" class="btn btn-secondary" type="button">Copy Manifest URL</button>
    </div>

    <label>2. Connect your local Stremio server (for raw torrents)</label>
    <p style="margin:4px 0 8px; font-size:0.9rem">Run this single command in Command Prompt / Terminal while Stremio is open (requires Node.js 22+):</p>
    <pre><code id="bridge-cmd"></code></pre>
  </div>

  <script>
    const roomInput = document.getElementById('room-input');
    const installLink = document.getElementById('install-link');
    const bridgeCmd = document.getElementById('bridge-cmd');

    function randomKey() {
      return 'room-' + Math.random().toString(36).slice(2, 8);
    }

    function updateUrls() {
      const room = (roomInput.value || 'room-1').trim();
      const cfg = encodeURIComponent('room=' + room);
      const manifestHttps = '${origin}/' + cfg + '/manifest.json';
      const manifestStremio = 'stremio://${hostNoProto}/' + cfg + '/manifest.json';
      installLink.href = manifestStremio;
      installLink.dataset.https = manifestHttps;
      bridgeCmd.textContent = 'curl -sL ${origin}/download/bridge.mjs -o bridge.mjs && node bridge.mjs --room=' + room + ' --server=${origin}';
    }

    roomInput.value = randomKey();
    updateUrls();
    roomInput.addEventListener('input', updateUrls);
    document.getElementById('gen-btn').addEventListener('click', () => {
      roomInput.value = randomKey();
      updateUrls();
    });
    document.getElementById('copy-manifest-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(installLink.dataset.https);
    });
  </script>
</body>
</html>`);
  });

  router.get('/download/bridge.mjs', (_req, res) => {
    res.download(path.resolve(__dirname, '../bridge/index.js'), 'bridge.mjs');
  });

  router.get('/download/bridge.js', (_req, res) => {
    res.download(path.resolve(__dirname, '../bridge/index.js'), 'bridge.mjs');
  });

  router.get('/manifest.json', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json(buildManifest({ room: 'default' }, origin));
  });

  router.get('/:config/manifest.json', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    const config = parseConfig(req.params.config);
    res.json(buildManifest(config, origin));
  });

  router.get('/:config/stream/:type/:id.json', (req, res) => {
    const config = parseConfig(req.params.config);
    const { type, id } = req.params;
    const origin = `${req.protocol}://${req.get('host')}`;
    const queueUrl = `${origin}/queue?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}&room=${encodeURIComponent(config.room)}`;

    res.json({
      streams: [
        {
          name: 'Discord Activity',
          title: `Host Watch Party in Discord\nRoom: ${config.room}`,
          externalUrl: queueUrl
        }
      ]
    });
  });

  router.get('/queue', (req, res) => {
    const { type, id, room = 'default' } = req.query;
    if (!type || !id) {
      return res.status(400).send('Missing type or id');
    }

    queueMediaForRoom(String(room), { type: String(type), id: String(id) });

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Queued for Discord Watch Party</title>
  <style>
    body { margin:0; font-family: system-ui, sans-serif; background:#0c0b13; color:#f3f2f8; display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .box { background:#161423; border:1px solid #2e2a45; border-radius:14px; padding:28px; max-width:460px; text-align:center; }
    code { color:#b8a9ff; }
    .btn { display:inline-block; margin-top:16px; padding:10px 18px; background:#7b5bf5; color:#fff; border-radius:8px; text-decoration:none; font-weight:600; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Queued for Watch Party!</h2>
    <p>Title <code>${String(id)}</code> has been sent to room <code>${String(room)}</code>.</p>
    <p>Open your <strong>Stremio Activity</strong> in Discord and make sure your Room Key is set to <code>${String(room)}</code>.</p>
    <a class="btn" href="discord://">Open Discord</a>
  </div>
</body>
</html>`);
  });

  return router;
}
