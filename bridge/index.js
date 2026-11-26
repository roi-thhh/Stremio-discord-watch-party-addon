import 'dotenv/config';
import WebSocket from 'ws';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const eq = arg.indexOf('=');
    if (eq === -1) return [arg.replace(/^--/, ''), 'true'];
    return [arg.slice(0, eq).replace(/^--/, ''), arg.slice(eq + 1)];
  })
);

const ROOM_KEY = args.room || process.env.ROOM_KEY;
const SERVER_URL = (args.server || process.env.ACTIVITY_SERVER_URL || 'http://localhost:3000').replace(/\/+$/, '');
const STREMIO_URL = (args.stremio || process.env.STREMIO_SERVER_URL || 'http://127.0.0.1:11470').replace(/\/+$/, '');

if (!ROOM_KEY) {
  console.error('Usage: node bridge/index.js --room=<ROOM_KEY> [--server=https://your-activity-url] [--stremio=http://127.0.0.1:11470]');
  process.exit(1);
}

const wsUrl = SERVER_URL.replace(/^http/, 'ws') + '/bridge-ws';

async function getStremioVersion() {
  try {
    const res = await fetch(`${STREMIO_URL}/settings`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return 'offline';
    const data = await res.json();
    return data?.values?.serverVersion || 'unknown';
  } catch {
    return 'offline';
  }
}

function connect() {
  console.log(`Connecting Stremio Bridge (${STREMIO_URL}) -> ${wsUrl} [room: ${ROOM_KEY}]`);
  const ws = new WebSocket(wsUrl);

  ws.on('open', async () => {
    const stremioVersion = await getStremioVersion();
    ws.send(JSON.stringify({ type: 'register', roomKey: ROOM_KEY, stremioVersion }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'registered') {
      console.log(`Bridge active for room "${msg.roomKey}". Keep this window open while hosting.`);
      return;
    }

    if (msg.type === 'req') {
      const targetUrl = `${STREMIO_URL}${msg.path}`;
      try {
        const upstream = await fetch(targetUrl, {
          method: msg.method || 'GET',
          headers: msg.headers || {},
          body: msg.body ? Buffer.from(msg.body, 'base64') : undefined
        });

        const headersObj = {};
        for (const [k, v] of upstream.headers.entries()) {
          headersObj[k] = v;
        }

        ws.send(
          JSON.stringify({
            type: 'res_head',
            id: msg.id,
            status: upstream.status,
            headers: headersObj
          })
        );

        if (upstream.body) {
          for await (const chunk of upstream.body) {
            if (ws.readyState !== 1) break;
            ws.send(
              JSON.stringify({
                type: 'res_chunk',
                id: msg.id,
                data: Buffer.from(chunk).toString('base64')
              })
            );
          }
        }
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'res_end', id: msg.id }));
        }
      } catch (err) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'res_error', id: msg.id, error: err.message }));
        }
      }
    }
  });

  ws.on('close', () => {
    console.log('Bridge disconnected. Reconnecting in 3s...');
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error('Bridge error:', err.message);
  });
}

connect();
