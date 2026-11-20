# Mobile online build

Based on gorisanson/pikachu-volleyball-p2p-online.

Changes:
- Signaling and the open room list use public MQTT brokers (broker.emqx.io,
  broker.hivemq.com) instead of Firebase. Messages go to both brokers, so one
  broker outage does not break connections. No setup needed.
  Optional `?mqtt=wss://host:port/path[,wss://...]` URL param to use other brokers.
- Unreliable/unordered data channel (original design), 10 s grace period for
  temporary disconnections, screen wake lock during the game.
- Optional TURN relay servers: `src/resources/js/data_channel/turn_config.js`.
- On-screen touch controls on touch devices: arrow keys + 6 pre-combined HIT buttons
  (up/none/down x normal/forward), forward is mirrored for the right-side player.
- Landscape layout, fullscreen button and rotate hint on phones.
- Simplified start screen (nickname, create room, room list, join by ID).
- Chat removed. Quick match hidden (requires a quick match server).

Build: `npm ci && npm run build` -> `dist/`. Deployed to the `gh-pages` branch.
