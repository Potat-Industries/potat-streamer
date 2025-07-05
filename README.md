# Potat Streamer

It streams the 24/7 grafana for [PotatBotat](https://potat.app)

## 🐳 Docker Compose

### 1. Prerequisites

- [Docker](https://www.docker.com/products/docker-desktop) and [Docker Compose](https://docs.docker.com/compose/) installed.
- [Node.js](https://nodejs.org/) and [npm](https://www.npmjs.com/).
- Rename `streamer.example.conf` to `streamer.conf` and enter your stream url and stream keys.

### 2. Create Container

```sh
docker compose up -d --build
```

- This will start the NGINX RTMP server and stunnel proxy.
- Build the NGINX RTMP image (with stunnel for Kick support).
- Copy your `streamer.conf` and `stunnel.conf` into the image.
- The RTMP server will listen on port `1935` (default RTMP port).
- Uses stunnel to stream to kick which requires rtmps, which nginx struggles with.
- The configuration will push your stream to Twitch, YouTube, and Kick.

## Start Streamer

```sh
npm install && npm run start
```

