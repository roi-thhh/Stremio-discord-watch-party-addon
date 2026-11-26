# Stremio Discord Activity

A custom Discord Activity powered by your local Stremio streaming server (`stremio-runtime.exe` / `127.0.0.1:11470`) and the Stremio Addon Protocol.

## Features
- **Stremio Addon Support**: Pre-seeded with Cinemeta; install any Stremio addon (e.g. Torrentio, Cyberflix, etc.) via `manifest.json` or `stremio://` URLs.
- **Torrent & Direct Stream Playback**: Uses your local Stremio server (`127.0.0.1:11470`) to stream torrents (`infoHash` + `fileIdx`) and transcode MKV/HEVC/AC3 to browser-safe HLS (`/hlsv2/...`) via FFmpeg/NVENC.
- **Discord Activity Proxy Ready**: Proxies addon requests, `.m3u8` playlists, and video segments through `/proxy/stremio` and `/proxy/external` so Discord's `/.proxy/` CSP allows playback.
- **Watch-Together Sync**: WebSocket room sync (`/ws`) per Discord Activity `instanceId` for play, pause, and seek.

## Setup

1. **Keep Stremio Desktop (or `stremio-runtime.exe`) running** on your PC so `http://127.0.0.1:11470` is active.
2. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```
   Fill in `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` from the [Discord Developer Portal](https://discord.com/developers/applications).
3. **Run the server**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` in your browser to test locally.
4. **Expose via HTTPS for Discord**:
   Use Cloudflare Tunnel (or ngrok) on port `3000`:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   In the Discord Developer Portal for your app:
   - **Activities → Settings**: Enable Activities.
   - **Activities → URL Mappings**: Map `/` (root) to your `https://....trycloudflare.com` URL.
   - **OAuth2 → Redirects**: Add `https://127.0.0.1` or your Activity URL if prompted.
