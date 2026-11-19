/**
 * Room list (lobby) using public MQTT brokers over WebSocket.
 * The host advertises its room as a retained message, visitors subscribe
 * and see the list of open rooms. No server setup is required.
 */
'use strict';
import mqtt from 'mqtt/dist/mqtt.esm';

const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
const PREFIX = 'pikavb-mobile-k7q2x/v1/rooms/';
const ADVERTISE_INTERVAL = 8000;
const STALE_MS = 25000;

/** @return {string[]} */
function getBrokers() {
  const param = new URLSearchParams(window.location.search).get('mqtt');
  return param ? [param] : DEFAULT_BROKERS;
}

/** @type {Map<string, {nickname: string, ts: number, lastSeen: number}>} */
const rooms = new Map();
let lobbyClients = [];
let renderTimer = null;
let onChange = null;

/**
 * Start listening for open rooms
 * @param {function(Array<{roomId: string, nickname: string}>): void} callback
 */
export function startLobby(callback) {
  onChange = callback;
  stopLobby();
  for (const url of getBrokers()) {
    let client;
    try {
      client = mqtt.connect(url, {
        reconnectPeriod: 3000,
        connectTimeout: 8000,
        clean: true,
      });
    } catch (e) {
      console.log('lobby connect error', e);
      continue;
    }
    client.on('connect', () => {
      client.subscribe(`${PREFIX}+`, { qos: 0 });
    });
    client.on('message', (topic, payload, packet) => {
      const roomId = topic.slice(PREFIX.length);
      if (payload.length === 0) {
        rooms.delete(roomId);
        render();
        return;
      }
      let data;
      try {
        data = JSON.parse(new TextDecoder().decode(payload));
      } catch (e) {
        return;
      }
      if (typeof data.ts !== 'number' || roomId.length !== 20) {
        return;
      }
      const now = Date.now();
      if (packet.retain && Math.abs(now - data.ts) > STALE_MS) {
        return;
      }
      rooms.set(roomId, {
        nickname: String(data.nickname || '').slice(0, 8),
        ts: data.ts,
        lastSeen: now,
      });
      render();
    });
    client.on('error', (err) => console.log('lobby error', url, err));
    lobbyClients.push(client);
  }
  renderTimer = window.setInterval(render, 3000);
}

/** Stop listening for open rooms */
export function stopLobby() {
  for (const c of lobbyClients) {
    c.end(true);
  }
  lobbyClients = [];
  if (renderTimer !== null) {
    window.clearInterval(renderTimer);
    renderTimer = null;
  }
}

function render() {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (now - r.lastSeen > STALE_MS) {
      rooms.delete(id);
    }
  }
  if (onChange) {
    const list = [...rooms.entries()]
      .filter(([id]) => id !== advertisedRoomId)
      .sort((a, b) => b[1].ts - a[1].ts)
      .map(([roomId, r]) => ({ roomId, nickname: r.nickname }));
    onChange(list);
  }
}

let advertiseClients = [];
let advertiseTimer = null;
let advertisedRoomId = null;

/**
 * Advertise my room in the lobby
 * @param {string} roomId
 * @param {string} nickname
 */
export function advertiseRoom(roomId, nickname) {
  stopAdvertising();
  advertisedRoomId = roomId;
  const topic = PREFIX + roomId;
  for (const url of getBrokers()) {
    let client;
    try {
      client = mqtt.connect(url, {
        reconnectPeriod: 3000,
        connectTimeout: 8000,
        clean: true,
        will: { topic, payload: '', qos: 0, retain: true },
      });
    } catch (e) {
      console.log('advertise connect error', e);
      continue;
    }
    const publish = () => {
      if (client.connected) {
        client.publish(topic, JSON.stringify({ nickname, ts: Date.now() }), {
          qos: 0,
          retain: true,
        });
      }
    };
    client.on('connect', publish);
    client.on('error', (err) => console.log('advertise error', url, err));
    // @ts-ignore
    client.publishRoom = publish;
    advertiseClients.push(client);
  }
  advertiseTimer = window.setInterval(() => {
    // @ts-ignore
    advertiseClients.forEach((c) => c.publishRoom());
  }, ADVERTISE_INTERVAL);
}

/** Remove my room from the lobby */
export function stopAdvertising() {
  if (advertiseTimer !== null) {
    window.clearInterval(advertiseTimer);
    advertiseTimer = null;
  }
  const topic = advertisedRoomId ? PREFIX + advertisedRoomId : null;
  for (const c of advertiseClients) {
    if (topic && c.connected) {
      c.publish(topic, '', { qos: 0, retain: true }, () => c.end());
    } else {
      c.end(true);
    }
  }
  advertiseClients = [];
  advertisedRoomId = null;
}

window.addEventListener('pagehide', () => {
  stopAdvertising();
  stopLobby();
});
