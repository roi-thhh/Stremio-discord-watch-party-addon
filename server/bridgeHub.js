import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';

// roomKey -> { ws, stremioVersion, pending: Map<reqId, { resolve, reject, stream }> }
const bridges = new Map();

export function hasBridge(roomKey) {
  const entry = bridges.get(roomKey);
  return Boolean(entry && entry.ws.readyState === 1);
}

export function getBridgeInfo(roomKey) {
  const entry = bridges.get(roomKey);
  if (!entry || entry.ws.readyState !== 1) return null;
  return { online: true, roomKey, serverVersion: entry.stremioVersion || 'bridge' };
}

export function attachBridgeServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    let registeredRoom = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'register' && msg.roomKey) {
        registeredRoom = String(msg.roomKey).trim();
        const prev = bridges.get(registeredRoom);
        if (prev && prev.ws !== ws) {
          prev.ws.close();
        }
        bridges.set(registeredRoom, {
          ws,
          stremioVersion: msg.stremioVersion || 'unknown',
          pending: new Map()
        });
        ws.send(JSON.stringify({ type: 'registered', roomKey: registeredRoom }));
        return;
      }

      if (!registeredRoom) return;
      const entry = bridges.get(registeredRoom);
      if (!entry) return;
      const reqState = entry.pending.get(msg.id);
      if (!reqState) return;

      if (msg.type === 'res_head') {
        reqState.resolve({
          status: msg.status,
          headers: msg.headers || {},
          bodyStream: reqState.stream
        });
      } else if (msg.type === 'res_chunk') {
        reqState.stream.write(Buffer.from(msg.data, 'base64'));
      } else if (msg.type === 'res_end') {
        reqState.stream.end();
        entry.pending.delete(msg.id);
      } else if (msg.type === 'res_error') {
        if (!reqState.settled) {
          reqState.settled = true;
          reqState.reject(new Error(msg.error || 'Bridge request failed'));
        } else {
          reqState.stream.destroy(new Error(msg.error || 'Bridge stream error'));
        }
        entry.pending.delete(msg.id);
      }
    });

    ws.on('close', () => {
      if (!registeredRoom) return;
      const entry = bridges.get(registeredRoom);
      if (entry && entry.ws === ws) {
        for (const [, p] of entry.pending) {
          if (!p.settled) p.reject(new Error('Bridge disconnected'));
          p.stream.destroy();
        }
        bridges.delete(registeredRoom);
      }
    });
  });

  return wss;
}

export function bridgeFetch(roomKey, { method = 'GET', path = '/', headers = {}, body = null }) {
  const entry = bridges.get(roomKey);
  if (!entry || entry.ws.readyState !== 1) {
    return Promise.reject(new Error(`No active Stremio bridge for room "${roomKey}"`));
  }

  const id = crypto.randomUUID();
  const stream = new PassThrough();

  return new Promise((resolve, reject) => {
    const reqState = {
      stream,
      settled: false,
      resolve: (val) => {
        reqState.settled = true;
        resolve(val);
      },
      reject: (err) => {
        reqState.settled = true;
        reject(err);
      }
    };
    entry.pending.set(id, reqState);

    entry.ws.send(
      JSON.stringify({
        type: 'req',
        id,
        method,
        path,
        headers,
        body: body ? Buffer.from(body).toString('base64') : null
      })
    );

    setTimeout(() => {
      if (!reqState.settled) {
        entry.pending.delete(id);
        stream.destroy();
        reqState.reject(new Error('Bridge request timed out'));
      }
    }, 20000);
  });
}
