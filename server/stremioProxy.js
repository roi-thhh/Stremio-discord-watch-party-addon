import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { bridgeFetch, getBridgeInfo, hasBridge } from './bridgeHub.js';

const STREMIO_SERVER_URL = (process.env.STREMIO_SERVER_URL || 'http://127.0.0.1:11470').replace(/\/+$/, '');

export async function checkStremioServer(roomKey = '') {
  if (roomKey && hasBridge(roomKey)) {
    return getBridgeInfo(roomKey);
  }
  try {
    const res = await fetch(`${STREMIO_SERVER_URL}/settings`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return { online: false, url: STREMIO_SERVER_URL };
    const data = await res.json();
    return {
      online: true,
      url: STREMIO_SERVER_URL,
      serverVersion: data?.values?.serverVersion || 'unknown'
    };
  } catch (err) {
    return { online: false, url: STREMIO_SERVER_URL, error: err.message };
  }
}

export async function prepareStreamPlayback({ infoHash, fileIdx = 0, sources = [], url, roomKey = '' }) {
  const useBridge = Boolean(roomKey && hasBridge(roomKey));
  const proxyPrefix = useBridge ? `/proxy/r/${encodeURIComponent(roomKey)}` : '/proxy/stremio';

  if (infoHash) {
    const hash = infoHash.toLowerCase();
    const createBody = sources?.length
      ? { peerSearch: { sources, minPeersForStable: 5 } }
      : {};

    if (useBridge) {
      const bridgeRes = await bridgeFetch(roomKey, {
        method: 'POST',
        path: `/${hash}/create`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody)
      });
      if (bridgeRes.status >= 400) {
        throw new Error(`Bridge Stremio engine create failed (${bridgeRes.status})`);
      }
      bridgeRes.bodyStream.resume();
    } else {
      const createRes = await fetch(`${STREMIO_SERVER_URL}/${hash}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody)
      });
      if (!createRes.ok) {
        throw new Error(`Stremio engine create failed (${createRes.status})`);
      }
    }

    const directMediaUrl = `${STREMIO_SERVER_URL}/${hash}/${fileIdx}`;
    const streamId = crypto.createHash('md5').update(`${hash}:${fileIdx}`).digest('hex').slice(0, 16);
    const hlsPath = `/hlsv2/${streamId}/master.m3u8?mediaURL=${encodeURIComponent(directMediaUrl)}`;

    return {
      mode: 'torrent',
      directProxyUrl: `${proxyPrefix}/${hash}/${fileIdx}`,
      hlsProxyUrl: `${proxyPrefix}${hlsPath}`
    };
  }

  if (url) {
    const streamId = crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
    const hlsPath = `/hlsv2/${streamId}/master.m3u8?mediaURL=${encodeURIComponent(url)}`;
    return {
      mode: 'http',
      directProxyUrl: `/proxy/external?url=${encodeURIComponent(url)}`,
      hlsProxyUrl: `${proxyPrefix}${hlsPath}`
    };
  }

  throw new Error('Stream has neither infoHash nor url');
}

function rewritePlaylist(text, proxyPrefix = '/proxy/stremio') {
  const escapedOrigin = STREMIO_SERVER_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(escapedOrigin, 'g'), proxyPrefix)
    .replace(/^(\/(?:hlsv2|subtitles|thumb)[^\r\n]*)/gm, `${proxyPrefix}$1`);
}

async function pipeFetchResponse(upstream, req, res, { rewriteM3u8 = false } = {}) {
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  res.status(upstream.status);

  const passthroughHeaders = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control'
  ];
  for (const h of passthroughHeaders) {
    const val = upstream.headers.get(h);
    if (val) res.setHeader(h, val);
  }

  if (
    rewriteM3u8 &&
    (contentType.includes('mpegurl') || req.originalUrl.includes('.m3u8'))
  ) {
    const text = await upstream.text();
    const rewritten = rewritePlaylist(text);
    res.removeHeader('content-length');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(rewritten);
  }

  if (!upstream.body) {
    return res.end();
  }

  const nodeStream = Readable.fromWeb(upstream.body);
  req.on('close', () => {
    nodeStream.destroy();
  });
  nodeStream.on('error', () => {
    if (!res.headersSent) res.status(502);
    res.end();
  });
  nodeStream.pipe(res);
}

export async function proxyStremioRequest(req, res, roomKey = '') {
  const useBridge = Boolean(roomKey && hasBridge(roomKey));
  const prefix = useBridge ? `/proxy/r/${encodeURIComponent(roomKey)}` : '/proxy/stremio';
  const targetPath = req.originalUrl.replace(new RegExp(`^/proxy/(?:r/${encodeURIComponent(roomKey)}|stremio)`), '');

  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;

  if (useBridge) {
    const bridgeRes = await bridgeFetch(roomKey, {
      method: req.method,
      path: targetPath,
      headers
    });

    const contentType = bridgeRes.headers['content-type'] || 'application/octet-stream';
    res.status(bridgeRes.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      if (bridgeRes.headers[h]) res.setHeader(h, bridgeRes.headers[h]);
    }

    if (contentType.includes('mpegurl') || req.originalUrl.includes('.m3u8')) {
      const chunks = [];
      for await (const chunk of bridgeRes.bodyStream) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      res.removeHeader('content-length');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritePlaylist(text, prefix));
    }

    req.on('close', () => bridgeRes.bodyStream.destroy());
    bridgeRes.bodyStream.on('error', () => {
      if (!res.headersSent) res.status(502);
      res.end();
    });
    return bridgeRes.bodyStream.pipe(res);
  }

  const targetUrl = `${STREMIO_SERVER_URL}${targetPath}`;
  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers
  });

  return pipeFetchResponse(upstream, req, res, { rewriteM3u8: true });
}

export async function proxyExternalRequest(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    return res.status(400).json({ error: 'Invalid external URL' });
  }

  const headers = { 'User-Agent': 'StremioDiscordActivity/1.0' };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = await fetch(targetUrl, { headers });
  return pipeFetchResponse(upstream, req, res, { rewriteM3u8: false });
}

export async function proxyImageRequest(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    return res.status(400).end();
  }

  const upstream = await fetch(targetUrl, {
    headers: { 'User-Agent': 'StremioDiscordActivity/1.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!upstream.ok) {
    return res.status(upstream.status).end();
  }

  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  const buf = Buffer.from(await upstream.arrayBuffer());
  return res.send(buf);
}
