# Mobile online build

Based on gorisanson/pikachu-volleyball-p2p-online.

Changes:
- Signaling uses the PeerJS public broker instead of Firebase (no setup needed).
  Optional `?signal=https://host:port/` URL param to use a self-hosted PeerJS server.
- Open room list (lobby) via public MQTT brokers (broker.emqx.io, broker.hivemq.com).
  Optional `?mqtt=wss://host:port/path` URL param to use another broker.
- On-screen touch controls on touch devices: arrow keys + 6 pre-combined HIT buttons
  (up/none/down x normal/forward), forward is mirrored for the right-side player.
- Landscape layout, fullscreen button and rotate hint on phones.
- Simplified start screen (nickname, create room, room list, join by ID).
- Chat removed. Quick match hidden (requires a quick match server).

Build: `npm ci && npm run build` -> `dist/`. Deployed to the `gh-pages` branch.
