import { WebSocketServer } from 'ws';

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      state: {
        media: null,
        stream: null,
        playbackUrls: null,
        bridgeKey: null,
        queued: null,
        useHls: true,
        isPlaying: false,
        currentTime: 0,
        updatedAt: Date.now()
      }
    });
  }
  return rooms.get(roomId);
}

function broadcast(room, payload, excludeWs = null) {
  const msg = JSON.stringify(payload);
  for (const client of room.clients) {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(msg);
    }
  }
}

export function queueMediaForRoom(roomId, media) {
  const room = getRoom(roomId);
  room.state.queued = { ...media, queuedAt: Date.now() };
  broadcast(room, { type: 'queued', media: room.state.queued });
}

export function attachSyncServer() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    let currentRoomId = null;
    let user = { id: 'anon', username: 'Guest' };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'join') {
        currentRoomId = msg.roomId || 'default-room';
        user = msg.user || user;
        const room = getRoom(currentRoomId);
        room.clients.add(ws);

        ws.send(
          JSON.stringify({
            type: 'state',
            state: room.state,
            participants: room.clients.size
          })
        );
        broadcast(
          room,
          { type: 'participants', participants: room.clients.size, user },
          ws
        );
        return;
      }

      if (!currentRoomId) return;
      const room = getRoom(currentRoomId);

      if (msg.type === 'attach_bridge') {
        room.state.bridgeKey = msg.bridgeKey ? String(msg.bridgeKey).trim() : null;
        broadcast(room, { type: 'bridge_attached', bridgeKey: room.state.bridgeKey });
      } else if (msg.type === 'select_media') {
        room.state = {
          ...room.state,
          media: msg.media || null,
          stream: msg.stream || null,
          playbackUrls: msg.playbackUrls || null,
          useHls: msg.useHls ?? true,
          isPlaying: true,
          currentTime: 0,
          updatedAt: Date.now()
        };
        broadcast(room, { type: 'state', state: room.state, by: user.username });
      } else if (msg.type === 'playback') {
        room.state.isPlaying = Boolean(msg.isPlaying);
        room.state.currentTime = Number(msg.currentTime) || 0;
        room.state.updatedAt = Date.now();
        broadcast(
          room,
          {
            type: 'playback',
            isPlaying: room.state.isPlaying,
            currentTime: room.state.currentTime,
            updatedAt: room.state.updatedAt,
            by: user.username
          },
          ws
        );
      }
    });

    ws.on('close', () => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;
      room.clients.delete(ws);
      broadcast(room, { type: 'participants', participants: room.clients.size });
      if (room.clients.size === 0) {
        rooms.delete(currentRoomId);
      }
    });
  });

  return wss;
}
