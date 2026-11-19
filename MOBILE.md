# Mobile online build

Based on gorisanson/pikachu-volleyball-p2p-online.

Changes:
- Signaling uses the PeerJS public broker instead of Firebase (no setup needed).
  Optional `?signal=https://host:port/` URL param to use a self-hosted PeerJS server.
- Open room list (lobby) via public MQTT brokers (broker.emqx.io, broker.hivemq.com).
  Optional `?mqtt=wss://host:port/path` URL param to use another broker.
- On-screen touch controls (arrow keys + HIT button) on touch devices.
- Landscape layout, fullscreen button and rotate hint on phones.
- Chat removed. Quick match hidden (requires a quick match server).

Build: `npm ci && npm run build` -> `dist/`. Deployed to the `gh-pages` branch.
