/**
 * WebRTC signaling over public MQTT brokers (the same brokers as the lobby).
 * Messages are published to every broker and received from any of them,
 * so a single broker outage does not break the connection setup.
 */
'use strict';
import mqtt from 'mqtt/dist/mqtt.esm';
import { getBrokers } from '../lobby.js';

const SIG_PREFIX = 'pikavb-mobile-k7q2x/v1/sig/';

export class Signaling {
  /**
   * @param {string} roomId
   * @param {{willSubtopic?: string, onConnect?: function(): void}} [options]
   */
  constructor(roomId, options = {}) {
    this.base = `${SIG_PREFIX}${roomId}/`;
    this.handlers = new Map();
    this.closed = false;
    this.clients = [];
    for (const url of getBrokers()) {
      /** @type {Object} */
      const opts = {
        reconnectPeriod: 2000,
        connectTimeout: 8000,
        clean: true,
      };
      if (options.willSubtopic) {
        opts.will = {
          topic: this.base + options.willSubtopic,
          payload: '',
          qos: 1,
          retain: true,
        };
      }
      let client;
      try {
        client = mqtt.connect(url, opts);
      } catch (e) {
        console.log('signaling connect error', url, e);
        continue;
      }
      client.on('connect', () => {
        for (const sub of this.handlers.keys()) {
          client.subscribe(this.base + sub, { qos: 1 });
        }
        if (options.onConnect) {
          options.onConnect();
        }
      });
      client.on('message', (topic, payload) => {
        const sub = topic.slice(this.base.length);
        const handler = this.handlers.get(sub);
        if (!handler || payload.length === 0) {
          return;
        }
        try {
          handler(JSON.parse(new TextDecoder().decode(payload)));
        } catch (e) {
          console.log('signaling message error', e);
        }
      });
      client.on('error', (err) => console.log('signaling error', url, err));
      this.clients.push(client);
    }
  }

  /**
   * Resolve true when at least one broker is connected, false on timeout
   * @param {number} timeoutMs
   * @return {Promise<boolean>}
   */
  ready(timeoutMs) {
    return new Promise((resolve) => {
      if (this.clients.some((c) => c.connected)) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), timeoutMs);
      for (const c of this.clients) {
        c.once('connect', () => {
          clearTimeout(timer);
          resolve(true);
        });
      }
    });
  }

  /**
   * @param {string} sub
   * @param {Object|null} obj null clears a retained message
   * @param {boolean} retain
   */
  publish(sub, obj, retain) {
    const payload = obj === null ? '' : JSON.stringify(obj);
    for (const c of this.clients) {
      if (c.connected) {
        c.publish(this.base + sub, payload, { qos: 1, retain });
      }
    }
  }

  /**
   * @param {string} sub
   * @param {function(Object): void} handler
   */
  subscribe(sub, handler) {
    this.handlers.set(sub, handler);
    for (const c of this.clients) {
      if (c.connected) {
        c.subscribe(this.base + sub, { qos: 1 });
      }
    }
  }

  /**
   * Wait for the first message on a subtopic which passes the filter
   * @param {string} sub
   * @param {number} timeoutMs
   * @param {function(Object): boolean} filter
   * @return {Promise<Object|null>}
   */
  waitFor(sub, timeoutMs, filter) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.handlers.delete(sub);
        resolve(null);
      }, timeoutMs);
      this.subscribe(sub, (msg) => {
        if (filter(msg)) {
          clearTimeout(timer);
          this.handlers.delete(sub);
          resolve(msg);
        }
      });
    });
  }

  /**
   * Close all broker connections
   * @param {string[]} [clearRetained] subtopics to clear before closing
   */
  close(clearRetained = []) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const c of this.clients) {
      if (c.connected && clearRetained.length > 0) {
        let n = clearRetained.length;
        for (const sub of clearRetained) {
          c.publish(this.base + sub, '', { qos: 1, retain: true }, () => {
            n--;
            if (n === 0) {
              c.end();
            }
          });
        }
      } else {
        c.end(true);
      }
    }
  }
}
