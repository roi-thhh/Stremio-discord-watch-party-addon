<div align="center">
  <img src="./assets/icon.jpg" alt="Stremio Discord Watch Party" width="180" style="border-radius: 24px;" />
  <h1>Stremio Discord Watch Party</h1>
  <p><strong>Watch Stremio movies, series, and torrents together inside a Discord Activity with synchronized playback.</strong></p>

  <p>
    <a href="https://stremio-discord-watch-party-addon.onrender.com/configure"><strong>Configure &amp; Install Stremio Addon</strong></a>
    •
    <a href="#for-viewers">For Viewers</a>
    •
    <a href="#for-hosts-using-your-own-stremio">For Hosts</a>
    •
    <a href="#self-hosting">Self-Hosting</a>
  </p>
</div>

---

## Features

- **Synced Watch-Together Playback**: Play, pause, and seek stay synchronized across everyone in the Discord voice channel.
- **Full Stremio Addon Support**: Pre-loaded with Cinemeta catalogs and search; install Torrentio or any Stremio addon directly inside the Activity.
- **Browser-Safe Torrent Streaming**: Streams torrents via your local Stremio server (`127.0.0.1:11470`) with automatic HLS transcoding for MKV/HEVC/AC3 files.
- **Installable Stremio Addon**: Adds a **"Host Watch Party in Discord"** button inside your desktop/web Stremio app.
- **Viewport Fullscreen**: Dedicated fullscreen mode (`F` key or **Fullscreen** button) designed for Discord's Activity iframe.

---

## For Viewers

**Zero setup required.**

1. Join a Discord voice channel where the Activity is running.
2. Click **Join Activity**.
3. Wait for the host to pick a movie or episode — playback and controls sync automatically!

---

## For Hosts (Using Your Own Stremio)

Want to stream torrents or addons from **your own PC's Stremio** to friends in Discord?

### Step 1: Install the Stremio Addon
1. Open the **[Addon Configure Page](https://stremio-discord-watch-party-addon.onrender.com/configure)**.
2. Copy or customize your **Room Key** (for example, `room-abc123`).
3. Click **Install in Stremio** to add **Discord Watch Party** to your Stremio app.

### Step 2: Start the Local Stremio Bridge
Make sure **Stremio** is open on your PC, then download [`bridge.js`](https://stremio-discord-watch-party-addon.onrender.com/download/bridge.js) (requires [Node.js](https://nodejs.org/)) and run:

```bash
npm install ws
node bridge.js --room=YOUR_ROOM_KEY --server=https://stremio-discord-watch-party-addon.onrender.com
```

Keep that terminal window open while hosting.

### Step 3: Link & Watch in Discord
1. Open the Activity in your Discord voice channel.
2. Click **Link Bridge** in the top-right bar and enter `YOUR_ROOM_KEY`.
   *(Everyone else in the voice channel connects to your bridge automatically — they don't need to enter anything.)*
3. Pick any movie or episode inside the Activity (or click **"Host Watch Party in Discord"** from inside Stremio) and press play!

---

## Self-Hosting

### 1. Clone & Configure
```bash
git clone https://github.com/roi-thhh/Stremio-discord-watch-party-addon.git
cd Stremio-discord-watch-party-addon
npm install
cp .env.example .env
```

Set your credentials from the [Discord Developer Portal](https://discord.com/developers/applications) in `.env`:
```env
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
PORT=3000
STREMIO_SERVER_URL=http://127.0.0.1:11470
```

### 2. Run Locally or Deploy with Docker
```bash
# Development
npm run dev

# Production
npm run build
npm start
```

Or deploy directly to **Render** using the included [`render.yaml`](./render.yaml) and [`Dockerfile`](./Dockerfile).

### 3. Discord Developer Portal Setup
1. Enable **Activities** under **Activities → Settings**.
2. Under **Activities → URL Mappings**, map `/` to your `https://...` server URL.
