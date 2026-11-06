# Potat Streamer

It streams the 24/7 grafana for [PotatBotat](https://potat.app)

## 🐳 Docker Compose

### 1. Prerequisites

- [Docker](https://www.docker.com/products/docker-desktop) and [Docker Compose](https://docs.docker.com/compose/) installed.
- [Node.js](https://nodejs.org/) and [npm](https://www.npmjs.com/).
- Rename `streamer.example.conf` to `streamer.conf` and enter your stream url and stream keys.
- Rename `example-config.json` to `config.json` and fill it in. Leave `executablePath` empty when running in Docker.
- Create `cookies.json` (`[]` is fine), and add `image.png` and `music.mp3`. Compose mounts these files, so they have to exist first.

### 2. Create Container

```sh
docker compose up -d --build
```

- This will start the NGINX RTMP server and stunnel proxy.
- Build the NGINX RTMP image (with stunnel for Kick support).
- Mount your `streamer.conf` and copy `stunnel.conf` into the image.
- The RTMP server will listen on `127.0.0.1:1935`, so only the streamer on this host can publish to it.
- Build and start the streamer.
- Uses stunnel to stream to kick which requires rtmps, which nginx struggles with.
- The configuration will push your stream to Twitch, YouTube, and Kick.

## Start Streamer Without Docker

Skip this if you used Compose above. Set `executablePath` in `config.json` to your Chromium binary.

```sh
npm install && npm run start
```

## Remote Commands

Publish to `potatbotat.streamer-restart` with `{ "target": "page" }` to restart only the browser, which keeps the RTMP stream up, or `{ "target": "ffmpeg" }` to restart only the encoder. No target restarts both.
