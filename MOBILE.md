# Mobile online build

Based on gorisanson/pikachu-volleyball-p2p-online.

Changes:
- Signaling uses the PeerJS public broker instead of Firebase (no setup needed).
  Optional `?signal=https://host:port/` URL param to use a self-hosted PeerJS server.
- On-screen touch controls (8-way pad + HIT button) on touch devices.
- Quick match hidden (requires a quick match server).

Build: `npm ci && npm run build` -> `dist/`. Deployed to the `gh-pages` branch.
