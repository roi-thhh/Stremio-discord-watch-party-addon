import Hls from 'hls.js';
import { initDiscordSession } from './discord.js';

let session = null;
let ws = null;
let hlsInstance = null;
let suppressSyncEvents = false;
let currentPlaybackUrls = null;
let activeCatalog = null;
let currentMetasCount = 0;
let roomBridgeKey = localStorage.getItem('stremio_bridge_key') || '';

function proxyImg(url) {
  if (!url) return '';
  if (url.startsWith('/')) return url;
  return `/proxy/image?url=${encodeURIComponent(url)}`;
}

const $ = (id) => document.getElementById(id);

const videoEl = $('video-player');
const playerSection = $('player-section');
const catalogGrid = $('catalog-grid');
const serverBadge = $('server-badge');
const roomBadge = $('room-badge');
const roomKeyBtn = $('room-key-btn');
const syncStatus = $('sync-status');
const hlsToggle = $('hls-toggle');

function getActiveRoomKey() {
  return roomBridgeKey || session?.roomId || 'local-room';
}

async function checkServerStatus() {
  try {
    const room = encodeURIComponent(getActiveRoomKey());
    const res = await fetch(`/api/stremio/status?room=${room}`);
    const data = await res.json();
    if (data.online) {
      serverBadge.textContent = `Stremio: v${data.serverVersion}`;
      serverBadge.className = 'badge badge-ok';
    } else {
      serverBadge.textContent = 'Stremio: Offline';
      serverBadge.className = 'badge badge-warn';
    }
  } catch {
    serverBadge.textContent = 'Stremio: Offline';
    serverBadge.className = 'badge badge-warn';
  }
}

function connectSync(roomId, user) {
  if (ws) {
    try { ws.close(); } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', roomId, user }));
    if (roomBridgeKey) {
      ws.send(JSON.stringify({ type: 'attach_bridge', bridgeKey: roomBridgeKey }));
    }
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.participants !== undefined) {
      roomBadge.textContent = `Peers: ${msg.participants}`;
    }

    if (msg.type === 'state') {
      if (msg.state?.bridgeKey && !roomBridgeKey) {
        roomBridgeKey = msg.state.bridgeKey;
        roomKeyBtn.textContent = `Bridge: ${roomBridgeKey.slice(0, 10)}`;
        checkServerStatus();
      }
      if (msg.state?.playbackUrls) {
        loadVideoState(msg.state);
        if (msg.by) syncStatus.textContent = `Loaded by ${msg.by}`;
      } else if (msg.state?.queued) {
        openDetailModal(msg.state.queued);
      }
    } else if (msg.type === 'bridge_attached') {
      roomBridgeKey = msg.bridgeKey || '';
      roomKeyBtn.textContent = roomBridgeKey ? `Bridge: ${roomBridgeKey.slice(0, 10)}` : 'Link Bridge';
      checkServerStatus();
    } else if (msg.type === 'queued' && msg.media) {
      openDetailModal(msg.media);
    } else if (msg.type === 'playback') {
      applyRemotePlayback(msg);
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(() => {
      if (getActiveRoomKey() === roomId) connectSync(roomId, user);
    }, 2500);
  });
}

function sendPlaybackSync() {
  if (suppressSyncEvents || !ws || ws.readyState !== 1) return;
  ws.send(
    JSON.stringify({
      type: 'playback',
      isPlaying: !videoEl.paused,
      currentTime: videoEl.currentTime
    })
  );
}

videoEl.addEventListener('play', sendPlaybackSync);
videoEl.addEventListener('pause', sendPlaybackSync);
videoEl.addEventListener('seeked', sendPlaybackSync);

function applyRemotePlayback(msg) {
  suppressSyncEvents = true;
  const drift = Math.abs(videoEl.currentTime - msg.currentTime);
  if (drift > 1.5) {
    videoEl.currentTime = msg.currentTime;
  }
  if (msg.isPlaying && videoEl.paused) {
    videoEl.play().catch(() => {});
  } else if (!msg.isPlaying && !videoEl.paused) {
    videoEl.pause();
  }
  syncStatus.textContent = `${msg.isPlaying ? 'Playing' : 'Paused'} • synced by ${msg.by}`;
  setTimeout(() => {
    suppressSyncEvents = false;
  }, 350);
}

function attachMediaSource(url, isHls) {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  if (isHls && Hls.isSupported()) {
    hlsInstance = new Hls({ maxBufferLength: 30 });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(videoEl);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      videoEl.play().catch(() => {});
    });
  } else {
    videoEl.src = url;
    videoEl.play().catch(() => {});
  }
}

function loadVideoState(state) {
  currentPlaybackUrls = state.playbackUrls;
  const useHls = hlsToggle.checked;
  const targetUrl = useHls ? currentPlaybackUrls.hlsProxyUrl : currentPlaybackUrls.directProxyUrl;

  $('now-playing-title').textContent = state.media?.name || 'Playing Stream';
  $('now-playing-sub').textContent = state.stream?.title?.split('\n')[0] || '';
  playerSection.classList.remove('hidden');

  suppressSyncEvents = true;
  attachMediaSource(targetUrl, useHls);
  if (state.currentTime > 0) {
    videoEl.currentTime = state.currentTime;
  }
  setTimeout(() => {
    suppressSyncEvents = false;
  }, 600);
}

hlsToggle.addEventListener('change', () => {
  if (!currentPlaybackUrls) return;
  const useHls = hlsToggle.checked;
  const targetUrl = useHls ? currentPlaybackUrls.hlsProxyUrl : currentPlaybackUrls.directProxyUrl;
  const t = videoEl.currentTime;
  attachMediaSource(targetUrl, useHls);
  videoEl.currentTime = t;
});

$('close-player-btn').addEventListener('click', () => {
  videoEl.pause();
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  videoEl.removeAttribute('src');
  playerSection.classList.remove('viewport-fullscreen');
  $('fullscreen-btn').textContent = 'Fullscreen';
  playerSection.classList.add('hidden');
});

function toggleFullscreen() {
  const isFull = playerSection.classList.toggle('viewport-fullscreen');
  $('fullscreen-btn').textContent = isFull ? 'Exit Fullscreen' : 'Fullscreen';
  if (isFull && document.fullscreenEnabled && !document.fullscreenElement) {
    playerSection.requestFullscreen?.().catch(() => {});
  } else if (!isFull && document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
}

$('fullscreen-btn').addEventListener('click', toggleFullscreen);

document.addEventListener('keydown', (e) => {
  if (playerSection.classList.contains('hidden')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.key === 'Escape' && playerSection.classList.contains('viewport-fullscreen')) {
    toggleFullscreen();
  }
});

function renderCatalogItems(metas, append = false) {
  if (!append) {
    catalogGrid.innerHTML = '';
    currentMetasCount = 0;
  }
  if (!metas.length && !append) {
    catalogGrid.innerHTML = '<p class="muted">No results found.</p>';
    $('load-more-wrap').classList.add('hidden');
    return;
  }

  for (const item of metas) {
    const card = document.createElement('div');
    card.className = 'poster-card';
    card.innerHTML = `
      <img src="${proxyImg(item.poster)}" alt="${item.name}" loading="lazy" />
      <div class="poster-info">
        <div class="poster-title">${item.name}</div>
        <div class="poster-meta">${item.releaseInfo || item.type}</div>
      </div>
    `;
    card.addEventListener('click', () => openDetailModal(item));
    catalogGrid.appendChild(card);
  }
  currentMetasCount += metas.length;
}

async function loadCatalog(addonId, type, id, { append = false } = {}) {
  activeCatalog = { addonId, type, id };
  if (!append) {
    catalogGrid.innerHTML = '<p class="muted">Loading catalog...</p>';
    $('load-more-wrap').classList.add('hidden');
  }

  try {
    const params = new URLSearchParams({ type, id });
    if (addonId) params.set('addonId', addonId);
    if (append && currentMetasCount > 0) params.set('extra', `skip=${currentMetasCount}`);

    const res = await fetch(`/api/catalog?${params.toString()}`);
    const data = await res.json();
    const metas = data.metas || [];

    renderCatalogItems(metas, append);
    if (metas.length >= 20) {
      $('load-more-wrap').classList.remove('hidden');
    } else {
      $('load-more-wrap').classList.add('hidden');
    }
  } catch (err) {
    if (!append) {
      catalogGrid.innerHTML = `<p class="error-text">Failed to load catalog: ${err.message}</p>`;
    }
  }
}

async function runSearch(query) {
  catalogGrid.innerHTML = '<p class="muted">Searching across all Stremio catalogs...</p>';
  $('load-more-wrap').classList.add('hidden');
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    renderCatalogItems(data.metas || [], false);
  } catch (err) {
    catalogGrid.innerHTML = `<p class="error-text">Search failed: ${err.message}</p>`;
  }
}

async function buildCatalogTabs() {
  const tabsEl = $('catalog-tabs');
  try {
    const res = await fetch('/api/addons');
    const { addons } = await res.json();
    const tabs = [];

    for (const addon of addons) {
      if (!addon.resources.includes('catalog')) continue;
      for (const cat of addon.catalogs || []) {
        const hasRequiredExtra = (cat.extra || []).some((e) => e.isRequired);
        if (hasRequiredExtra) continue;
        const typeLabel = cat.type.charAt(0).toUpperCase() + cat.type.slice(1);
        tabs.push({
          addonId: addon.id,
          type: cat.type,
          id: cat.id,
          label: `${cat.name || cat.id} ${typeLabel}`
        });
      }
    }

    tabsEl.innerHTML = '';
    tabs.forEach((t, idx) => {
      const btn = document.createElement('button');
      btn.className = `tab${idx === 0 ? ' active' : ''}`;
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        tabsEl.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
        btn.classList.add('active');
        $('search-input').value = '';
        loadCatalog(t.addonId, t.type, t.id);
      });
      tabsEl.appendChild(btn);
    });

    if (tabs.length > 0 && !activeCatalog) {
      loadCatalog(tabs[0].addonId, tabs[0].type, tabs[0].id);
    }
  } catch (err) {
    console.error('Failed to load catalog tabs:', err);
  }
}

async function openDetailModal(item) {
  const modal = $('detail-modal');
  const body = $('detail-body');
  modal.classList.remove('hidden');
  body.innerHTML = '<p class="muted">Loading details & streams...</p>';

  try {
    const metaRes = await fetch(`/api/meta?type=${encodeURIComponent(item.type)}&id=${encodeURIComponent(item.id)}`);
    const metaData = await metaRes.json();
    const meta = metaData.meta || item;

    let selectedVideoId = meta.id;
    let episodeSelectorHtml = '';

    if (meta.type === 'series' && Array.isArray(meta.videos) && meta.videos.length) {
      selectedVideoId = meta.videos[0].id;
      episodeSelectorHtml = `
        <select id="episode-select" class="episode-select">
          ${meta.videos
            .map(
              (v) =>
                `<option value="${v.id}">S${v.season}E${v.episode} - ${v.title || v.name || ''}</option>`
            )
            .join('')}
        </select>
      `;
    }

    body.innerHTML = `
      <div class="detail-header">
        <img src="${proxyImg(meta.poster || item.poster)}" alt="${meta.name}" />
        <div>
          <h2 style="margin:0 0 6px">${meta.name}</h2>
          <div class="muted" style="margin-bottom:10px">${meta.releaseInfo || ''} • ${(meta.genres || []).join(', ')}</div>
          <p style="margin:0; font-size:0.92rem; line-height:1.45">${meta.description || ''}</p>
        </div>
      </div>
      ${episodeSelectorHtml}
      <h3 style="margin:10px 0 6px">Available Streams</h3>
      <div id="streams-container" class="streams-list"><p class="muted">Fetching streams from installed addons...</p></div>
    `;

    const epSelect = document.getElementById('episode-select');
    if (epSelect) {
      epSelect.addEventListener('change', () => {
        loadStreams(meta, meta.type, epSelect.value);
      });
    }

    await loadStreams(meta, meta.type, selectedVideoId);
  } catch (err) {
    body.innerHTML = `<p class="error-text">${err.message}</p>`;
  }
}

async function loadStreams(meta, type, videoId) {
  const container = document.getElementById('streams-container');
  container.innerHTML = '<p class="muted">Querying addons...</p>';

  const res = await fetch(`/api/streams?type=${encodeURIComponent(type)}&id=${encodeURIComponent(videoId)}`);
  const data = await res.json();
  const streams = data.streams || [];

  if (!streams.length) {
    container.innerHTML = '<p class="muted">No streams found. Install a stream addon like Torrentio in Addons.</p>';
    return;
  }

  container.innerHTML = '';
  for (const stream of streams) {
    const el = document.createElement('div');
    el.className = 'stream-item';
    el.innerHTML = `
      <div>
        <div style="font-weight:600; font-size:0.82rem; color:#b8a9ff">${stream._addonName || 'Addon'} • ${stream.name || ''}</div>
        <div class="stream-title">${stream.title || stream.description || stream.infoHash || stream.url}</div>
      </div>
      <button class="btn btn-primary">Play</button>
    `;
    el.addEventListener('click', () => startStream(meta, stream));
    container.appendChild(el);
  }
}

async function startStream(meta, stream) {
  $('detail-modal').classList.add('hidden');
  syncStatus.textContent = 'Preparing stream via Stremio server...';
  playerSection.classList.remove('hidden');

  const res = await fetch('/api/play/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      infoHash: stream.infoHash,
      fileIdx: stream.fileIdx ?? 0,
      sources: stream.sources || [],
      url: stream.url,
      roomKey: getActiveRoomKey()
    })
  });

  const playbackUrls = await res.json();
  if (!res.ok) {
    syncStatus.textContent = `Stream error: ${playbackUrls.error}`;
    return;
  }

  const statePayload = {
    media: { id: meta.id, name: meta.name, type: meta.type },
    stream: { title: stream.title || stream.name || '' },
    playbackUrls,
    currentTime: 0,
    isPlaying: true
  };

  loadVideoState(statePayload);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'select_media', ...statePayload }));
  }
}

async function refreshAddonsList() {
  const list = $('addons-list');
  const res = await fetch('/api/addons');
  const { addons } = await res.json();
  list.innerHTML = '';

  for (const addon of addons) {
    const row = document.createElement('div');
    row.className = 'addon-row';
    row.innerHTML = `
      <div>
        <strong>${addon.name}</strong> <span class="muted">v${addon.version}</span>
        <div class="muted" style="font-size:0.8rem">${addon.resources.join(', ')} • ${addon.manifestUrl}</div>
      </div>
      ${
        addon.id === 'com.linvo.cinemeta'
          ? '<span class="muted">Built-in</span>'
          : `<button class="btn btn-danger" data-remove="${addon.id}">Remove</button>`
      }
    `;
    const rmBtn = row.querySelector('[data-remove]');
    if (rmBtn) {
      rmBtn.addEventListener('click', async () => {
        await fetch(`/api/addons/${encodeURIComponent(addon.id)}`, { method: 'DELETE' });
        refreshAddonsList();
      });
    }
    list.appendChild(row);
  }
}

$('open-addons-btn').addEventListener('click', () => {
  $('addons-modal').classList.remove('hidden');
  refreshAddonsList();
});

$('install-addon-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('addon-error');
  errEl.classList.add('hidden');
  const manifestUrl = $('addon-url-input').value.trim();

  const res = await fetch('/api/addons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifestUrl })
  });
  const data = await res.json();
  if (!res.ok) {
    errEl.textContent = data.error || 'Failed to install addon';
    errEl.classList.remove('hidden');
    return;
  }
  $('addon-url-input').value = '';
  refreshAddonsList();
  buildCatalogTabs();
});

document.querySelectorAll('[data-close]').forEach((el) => {
  el.addEventListener('click', () => {
    $(el.dataset.close).classList.add('hidden');
  });
});

$('load-more-btn').addEventListener('click', () => {
  if (activeCatalog) {
    loadCatalog(activeCatalog.addonId, activeCatalog.type, activeCatalog.id, { append: true });
  }
});

let searchTimer = null;
$('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => {
    if (q) {
      runSearch(q);
    } else if (activeCatalog) {
      loadCatalog(activeCatalog.addonId, activeCatalog.type, activeCatalog.id);
    }
  }, 350);
});

roomKeyBtn.addEventListener('click', async () => {
  const next = prompt('Enter your Stremio Bridge Key (from /configure) to share your Stremio with this voice channel:', roomBridgeKey);
  if (next === null) return;
  roomBridgeKey = next.trim();
  if (roomBridgeKey) {
    localStorage.setItem('stremio_bridge_key', roomBridgeKey);
  } else {
    localStorage.removeItem('stremio_bridge_key');
  }
  roomKeyBtn.textContent = roomBridgeKey ? `Bridge: ${roomBridgeKey.slice(0, 10)}` : 'Link Bridge';
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'attach_bridge', bridgeKey: roomBridgeKey }));
  }
  await checkServerStatus();
});

async function bootstrap() {
  try {
    session = await initDiscordSession();
  } catch (err) {
    console.warn('Discord SDK init fallback:', err);
    session = { inDiscord: false, roomId: 'fallback-room', user: { id: 'guest', username: 'Guest' } };
  }
  roomKeyBtn.textContent = roomBridgeKey ? `Bridge: ${roomBridgeKey.slice(0, 10)}` : 'Link Bridge';
  await checkServerStatus();
  connectSync(session.roomId, session.user);
  await buildCatalogTabs();
}

bootstrap();
