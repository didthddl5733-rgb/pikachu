/**
 * Manages a data channel between the two peers.
 *
 * A large portion (mainly, {@link createRoom}, {@link joinRoom}, {@link registerPeerConnectionListeners} and {@link collectIceCandidates} functions)
 * of the code in this module is copied (or edited after copied) from the links below:
 * https://github.com/webrtc/FirebaseRTC
 * https://webrtc.org/getting-started/firebase-rtc-codelab
 * https://webrtc.org/getting-started/data-channels
 */
'use strict';
import { Signaling } from './mqtt_signaling.js';
import { turnServers } from './turn_config.js';
import { stopAdvertising, stopLobby } from '../lobby.js';
import seedrandom from 'seedrandom';
import { setCustomRng } from '../offline_version_js/rand.js';
import { mod, isInModRange } from '../utils/mod.js';
import { bufferLength, PikaUserInputWithSync } from '../keyboard_online.js';
import {
  noticeDisconnected,
  enableChatOpenBtnAndChatDisablingBtn,
  hideWaitingPeerAssetsLoadingBox,
  hidePingBox,
  printAvgPing,
  printStartsIn,
  printLog,
  printPeriodInLog,
  printNotValidRoomIdMessage,
  printNoRoomMatchingMessage,
  printConnectionFailed,
  disableCancelQuickMatchBtnForAWhile,
  askOptionsChangeReceivedFromPeer,
  noticeAgreeMessageFromPeer,
  notifyBySound,
  autoAskChangingToFastSpeedToPeer,
  applyAutoAskChangingToFastSpeedWhenBothPeerDo,
  MAX_NICKNAME_LENGTH,
} from '../ui_online.js';
import {
  displayMyAndPeerNicknameShownOrHidden,
  displayNicknameFor,
  displayPeerNicknameFor,
  displayPartialIPFor,
} from '../nickname_display.js';
import {
  setChatRngs,
  displayMyChatMessage,
  displayPeerChatMessage,
  displayMyAndPeerChatEnabledOrDisabled,
} from '../chat_display.js';
import { rtcConfiguration } from './rtc_configuration.js';
import { parsePublicIPFromCandidate, getPartialIP } from './parse_candidate.js';
import {
  convertUserInputTo5bitNumber,
  convert5bitNumberToUserInput,
} from '../utils/input_conversion.js';
import { replaySaver } from '../replay/replay_saver.js';

/** @typedef {{speed: string, winningScore: number}} Options */

// It is set to (1 << 16) since syncCounter is to be sent as Uint16
// 1 << 16 === 65536 and it corresponds to about 36 minutes of syncCounter
// wrap-around time in 30 FPS (fast game speed).
export const SYNC_DIVISOR = 1 << 16; // 65536

export const channel = {
  isOpen: false,
  gameStartAllowed: false,
  amICreatedRoom: false,
  amIPlayer2: null, // set from pikavolley_online.js
  isQuickMatch: null, // set from ui_online.js
  myNickname: '', // set from ui_online.js
  _peerNickname: '',
  myPartialPublicIP: '*.*.*.*',
  peerPartialPublicIP: '*.*.*.*',
  myChatEnabled: true,
  peerChatEnabled: true,
  myIsPeerNicknameVisible: true, // For nicknameHideBtn
  peerIsPeerNicknameVisible: true,
  willAskFastAutomatically: false,

  get peerNickname() {
    return this.myIsPeerNicknameVisible ? this._peerNickname : '';
  },
  set peerNickname(nickname) {
    this._peerNickname = nickname;
  },

  /** @type {PikaUserInputWithSync[]} */
  peerInputQueue: [],
  _peerInputQueueSyncCounter: 0,
  get peerInputQueueSyncCounter() {
    return this._peerInputQueueSyncCounter;
  },
  set peerInputQueueSyncCounter(counter) {
    this._peerInputQueueSyncCounter = mod(counter, SYNC_DIVISOR);
  },

  callbackAfterDataChannelOpened: null,
  callbackAfterDataChannelOpenedForUI: null,
  callbackAfterPeerInputQueueReceived: null,
};

const pingTestManager = {
  pingSentTimeArray: new Array(5),
  receivedPingResponseNumber: 0,
  pingMesurementArray: [],
};

/**
 * Return a message sync manager
 * @param {number} offset syncCounter offset (even number)
 */
function createMessageSyncManager(offset) {
  return {
    pendingMessage: '',
    resendIntervalID: null,
    _syncCounter: offset,
    _peerSyncCounter: offset + ((offset + 1) % 2),
    get syncCounter() {
      return this._syncCounter;
    },
    set syncCounter(n) {
      this._syncCounter = offset + (n % 2);
    },
    get peerSyncCounter() {
      return this._peerSyncCounter;
    },
    set peerSyncCounter(n) {
      this._peerSyncCounter = offset + (n % 2);
    },
    get nextPeerSyncCounter() {
      return offset + ((this._peerSyncCounter + 1) % 2);
    },
  };
}

const chatManager = createMessageSyncManager(0); // use 0, 1 for syncCounter
const optionsChangeManager = createMessageSyncManager(2); // use 2, 3 for syncCounter
const optionsChangeAgreeManager = createMessageSyncManager(4); // use 4, 5 for syncCounter
const chatEnabledManager = createMessageSyncManager(6); // use 6, 7 for syncCounter
const peerNicknameShownManager = createMessageSyncManager(8); // use 8, 9 for syncCounter

let peerConnection = null;
let dataChannel = null;
let roomId = null;
let signaling = null;
let offerRefreshTimer = null;
let disconnectTimer = null;
let isDataChannelEverOpened = false;
let isFirstInputQueueFromPeer = true;
// first chat message is used for nickname transmission
let isFirstChatMessageToPeerUsedForNickname = true;
let isFirstChatMessageFromPeerUsedForNickname = true;
let isAutoAskingFastWhenBothPeerDoApplied = false;

const OFFER_MAX_AGE_MS = 60000;
const OFFER_REFRESH_MS = 20000;
const DISCONNECT_GRACE_MS = 10000;

/**
 * Wait until ICE gathering completes (or timeout), so the SDP contains candidates.
 * @param {RTCPeerConnection} pc
 * @param {number} timeoutMs
 * @return {Promise<void>}
 */
function waitIceGathering(pc, timeoutMs) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === 'complete') {
        done();
      }
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/**
 * Get the partial public IP address from candidates in an SDP
 * @param {string} sdp
 * @return {string|null}
 */
function partialPublicIPFromSdp(sdp) {
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('a=candidate:')) {
      const ip = parsePublicIPFromCandidate(line.slice(2));
      if (ip !== null) {
        return getPartialIP(ip);
      }
    }
  }
  return null;
}

/**
 * Log which kind of path the connection uses (direct / relay)
 * @param {RTCPeerConnection} pc
 */
function logSelectedCandidatePair(pc) {
  pc.getStats()
    .then((stats) => {
      stats.forEach((report) => {
        if (
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          report.nominated
        ) {
          const local = stats.get(report.localCandidateId);
          const remote = stats.get(report.remoteCandidateId);
          const msg = `path: ${local ? local.candidateType : '?'} -> ${
            remote ? remote.candidateType : '?'
          }`;
          console.log(msg);
          printLog(msg);
        }
      });
    })
    .catch(() => {});
}

function iceGatherTimeout() {
  return turnServers.length > 0 ? 4000 : 2500;
}

/**
 * Create a room
 * @param {string} roomIdToCreate
 */
export async function createRoom(roomIdToCreate) {
  channel.amICreatedRoom = true;
  roomId = roomIdToCreate;

  console.log('Create PeerConnection with configuration: ', rtcConfiguration);
  peerConnection = new RTCPeerConnection(rtcConfiguration);
  registerPeerConnectionListeners(peerConnection);

  // Unreliable and unordered (UDP-like) data channel.
  // Transmission reliability is managed on the application layer.
  dataChannel = peerConnection.createDataChannel('pikavolley_p2p_channel', {
    ordered: false,
    maxRetransmits: 0,
  });
  dataChannel.addEventListener('open', dataChannelOpened);
  dataChannel.addEventListener('message', recieveFromPeer);
  dataChannel.addEventListener('close', dataChannelClosed);

  const nonce = Math.random().toString(36).slice(2);
  let offerSdp = null;
  const publishOffer = () => {
    if (offerSdp && signaling && !peerConnection.currentRemoteDescription) {
      signaling.publish(
        'offer',
        { type: 'offer', sdp: offerSdp, nonce, ts: Date.now() },
        true
      );
    }
  };
  signaling = new Signaling(roomId, {
    willSubtopic: 'offer',
    onConnect: publishOffer,
  });
  signaling.subscribe('answer', async (msg) => {
    if (
      msg.nonce !== nonce ||
      !msg.sdp ||
      peerConnection.currentRemoteDescription
    ) {
      return;
    }
    printLog('Answer received');
    stopOfferRefresh();
    // The room is taken now: remove the offer
    signaling.publish('offer', null, true);
    try {
      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: msg.sdp,
      });
    } catch (e) {
      console.log('setRemoteDescription failed', e);
      return;
    }
    const ip = partialPublicIPFromSdp(msg.sdp);
    if (ip !== null) {
      channel.peerPartialPublicIP = ip;
    }
  });

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await waitIceGathering(peerConnection, iceGatherTimeout());
  offerSdp = peerConnection.localDescription.sdp;
  const myIP = partialPublicIPFromSdp(offerSdp);
  if (myIP !== null) {
    channel.myPartialPublicIP = myIP;
  }

  const connected = await signaling.ready(10000);
  if (!connected) {
    printLog('Could not reach the signaling servers');
    notifyBySound();
    printConnectionFailed();
    return;
  }
  publishOffer();
  offerRefreshTimer = window.setInterval(publishOffer, OFFER_REFRESH_MS);
  console.log(`New room created. Room ID: ${roomId}`);
  printLog('Room created. Waiting for the peer...');
}

function stopOfferRefresh() {
  if (offerRefreshTimer !== null) {
    window.clearInterval(offerRefreshTimer);
    offerRefreshTimer = null;
  }
}

/**
 * Join the room
 * @param {string} roomIdToJoin
 */
export async function joinRoom(roomIdToJoin) {
  roomId = roomIdToJoin;
  if (roomId.length !== 20) {
    printNotValidRoomIdMessage();
    return false;
  }
  console.log('Join room: ', roomId);

  signaling = new Signaling(roomId);
  const connected = await signaling.ready(10000);
  if (!connected) {
    printLog('Could not reach the signaling servers');
    notifyBySound();
    printConnectionFailed();
    return false;
  }
  const offerMsg = await signaling.waitFor(
    'offer',
    8000,
    (msg) =>
      msg &&
      msg.type === 'offer' &&
      typeof msg.sdp === 'string' &&
      Math.abs(Date.now() - msg.ts) < OFFER_MAX_AGE_MS
  );
  if (offerMsg === null) {
    console.log('No room is matching the ID');
    printNoRoomMatchingMessage();
    signaling.close();
    signaling = null;
    return false;
  }
  printLog('Offer received');

  console.log('Create PeerConnection with configuration: ', rtcConfiguration);
  peerConnection = new RTCPeerConnection(rtcConfiguration);
  registerPeerConnectionListeners(peerConnection);

  await peerConnection.setRemoteDescription({
    type: 'offer',
    sdp: offerMsg.sdp,
  });
  const peerIP = partialPublicIPFromSdp(offerMsg.sdp);
  if (peerIP !== null) {
    channel.peerPartialPublicIP = peerIP;
  }
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  await waitIceGathering(peerConnection, iceGatherTimeout());
  const answerSdp = peerConnection.localDescription.sdp;
  const myIP = partialPublicIPFromSdp(answerSdp);
  if (myIP !== null) {
    channel.myPartialPublicIP = myIP;
  }
  signaling.publish(
    'answer',
    { type: 'answer', sdp: answerSdp, nonce: offerMsg.nonce },
    false
  );
  printLog('Answer sent. Connecting...');

  setTimeout(() => {
    if (!isDataChannelEverOpened) {
      notifyBySound();
      printConnectionFailed();
    }
  }, 25000);
  return true;
}

/**
 * Send data only when the data channel is open
 * @param {string|ArrayBuffer} data
 */
function safeSend(data) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    return;
  }
  try {
    dataChannel.send(data);
  } catch (e) {
    console.log('send failed', e);
  }
}

/**
 * Clean up the signaling server connection.
 * (Name kept for compatibility. Signaling now uses MQTT brokers.)
 */
export function cleanUpFirestoreRelevants() {
  stopOfferRefresh();
  if (signaling) {
    signaling.close(channel.amICreatedRoom ? ['offer'] : []);
    signaling = null;
  }
}

let wakeLock = null;

/** Keep the screen on during the game (mobile) */
async function requestWakeLock() {
  try {
    // @ts-ignore
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      // @ts-ignore
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    console.log('wake lock failed', e);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && channel.isOpen && !wakeLock) {
    requestWakeLock();
  }
});

export function closeConnection() {
  if (dataChannel) {
    dataChannel.close();
  }
  if (peerConnection) {
    peerConnection.close();
  }
  console.log('Did close data channel and peer connection');
}

/**
 * Send my input queue to the peer.
 *
 * Input is transmitted by 5 bits (so fit in 1 byte = 8 bits).
 * Refer: {@link convertUserInputTo5bitNumber}
 *
 * @param {PikaUserInputWithSync[]} inputQueue
 */
export function sendInputQueueToPeer(inputQueue) {
  const buffer = new ArrayBuffer(2 + inputQueue.length);
  const dataView = new DataView(buffer);
  dataView.setUint16(0, inputQueue[0].syncCounter, true);
  for (let i = 0; i < inputQueue.length; i++) {
    const input = inputQueue[i];
    const byte = convertUserInputTo5bitNumber(input);
    dataView.setUint8(2 + i, byte);
  }
  safeSend(buffer);
}

/**
 * Receive peer's input queue from the peer
 * @param {ArrayBuffer} data
 */
function receiveInputQueueFromPeer(data) {
  if (isFirstInputQueueFromPeer) {
    isFirstInputQueueFromPeer = false;
    hideWaitingPeerAssetsLoadingBox();
  }

  const dataView = new DataView(data);
  const syncCounter0 = dataView.getUint16(0, true);
  for (let i = 0; i < data.byteLength - 2; i++) {
    const syncCounter = mod(syncCounter0 + i, SYNC_DIVISOR);
    // isInModeRange in the below if statement is
    // to prevent overflow of the queue by a corrupted peer code
    if (
      syncCounter === channel.peerInputQueueSyncCounter &&
      (channel.peerInputQueue.length === 0 ||
        isInModRange(
          syncCounter,
          channel.peerInputQueue[0].syncCounter,
          channel.peerInputQueue[0].syncCounter + 2 * bufferLength - 1,
          SYNC_DIVISOR
        ))
    ) {
      const byte = dataView.getUint8(2 + i);
      const input = convert5bitNumberToUserInput(byte);
      const peerInputWithSync = new PikaUserInputWithSync(
        syncCounter,
        input.xDirection,
        input.yDirection,
        input.powerHit
      );
      channel.peerInputQueue.push(peerInputWithSync);
      channel.peerInputQueueSyncCounter++;
    }
  }
}

/**
 * Send chat message to the peer
 * @param {string} chatMessage
 */
export function sendChatMessageToPeer(chatMessage) {
  chatManager.pendingMessage = chatMessage;
  // append syncCounter at the end of chat message;
  const chatMessageToPeer = chatMessage + String(chatManager.syncCounter);
  safeSend(chatMessageToPeer);
  chatManager.resendIntervalID = setInterval(
    () => safeSend(chatMessageToPeer),
    1000
  );
  return;
}

/**
 * Receive chat message ACK(acknowledgment) array buffer from peer.
 * @param {ArrayBuffer} data array buffer with length 1
 */
function receiveChatMessageAckFromPeer(data) {
  const dataView = new DataView(data);
  const syncCounter = dataView.getInt8(0);
  if (syncCounter === chatManager.syncCounter) {
    chatManager.syncCounter++;
    clearInterval(chatManager.resendIntervalID);
    if (isFirstChatMessageToPeerUsedForNickname) {
      isFirstChatMessageToPeerUsedForNickname = false;
    } else {
      displayMyChatMessage(chatManager.pendingMessage);
      enableChatOpenBtnAndChatDisablingBtn();
    }
  }
}

/**
 * Receive chat meesage from the peer
 * @param {string} chatMessage
 */
function receiveChatMessageFromPeer(chatMessage) {
  // Read syncCounter at the end of chat message
  const peerSyncCounter = Number(chatMessage.slice(-1));
  if (peerSyncCounter === chatManager.peerSyncCounter) {
    // if peer resend prevMessage since peer did not recieve
    // the message ACK(acknowledgment) array buffer with length 1
    console.log('arraybuffer with length 1 for chat message ACK resent');
  } else if (peerSyncCounter === chatManager.nextPeerSyncCounter) {
    // if peer send new message
    chatManager.peerSyncCounter++;
    if (isFirstChatMessageFromPeerUsedForNickname) {
      isFirstChatMessageFromPeerUsedForNickname = false;
      channel.peerNickname = chatMessage
        .slice(0, -1)
        .trim()
        .slice(0, MAX_NICKNAME_LENGTH);
      displayPeerNicknameFor(channel.peerNickname, channel.amICreatedRoom);
      displayNicknameFor(channel.myNickname, !channel.amICreatedRoom);
      displayPartialIPFor(channel.peerPartialPublicIP, channel.amICreatedRoom);
      displayPartialIPFor(channel.myPartialPublicIP, !channel.amICreatedRoom);
      if (channel.amICreatedRoom) {
        replaySaver.recordNicknames(channel.myNickname, channel.peerNickname);
        replaySaver.recordPartialPublicIPs(
          channel.myPartialPublicIP,
          channel.peerPartialPublicIP
        );
      } else {
        replaySaver.recordNicknames(channel.peerNickname, channel.myNickname);
        replaySaver.recordPartialPublicIPs(
          channel.peerPartialPublicIP,
          channel.myPartialPublicIP
        );
      }
    } else {
      displayPeerChatMessage(chatMessage.slice(0, -1));
    }
  } else {
    console.log('invalid chat message received.');
    return;
  }

  // Send the message ACK array buffer with length 1.
  const buffer = new ArrayBuffer(1);
  const dataView = new DataView(buffer);
  dataView.setInt8(0, peerSyncCounter);
  safeSend(buffer);
}

/**
 * Send options change message to peer
 *
 * speed: one of 'slow', 'medium', 'fast', null
 * winningScore: one of 5, 10, 15, null
 * @param {Options} options
 */
export function sendOptionsChangeMessageToPeer(options) {
  if (!options.speed && !options.winningScore) {
    return;
  }
  let optionsChangeMessageToPeer = JSON.stringify(options);
  // append syncCounter at the end of options change message;
  optionsChangeMessageToPeer += String(optionsChangeManager.syncCounter);
  safeSend(optionsChangeMessageToPeer);
  optionsChangeManager.resendIntervalID = setInterval(
    () => safeSend(optionsChangeMessageToPeer),
    1000
  );
  return;
}

/**
 * Receive options change message ACK(acknowledgment) array buffer from peer.
 * @param {ArrayBuffer} data array buffer with length 1
 */
function receiveOptionsChangeMessageAckFromPeer(data) {
  const dataView = new DataView(data);
  const syncCounter = dataView.getInt8(0);
  if (syncCounter === optionsChangeManager.syncCounter) {
    optionsChangeManager.syncCounter++;
    clearInterval(optionsChangeManager.resendIntervalID);
  }
}

/**
 * Receive options change meesage from the peer
 * @param {string} optionsChangeMessage
 */
function receiveOptionsChangeMessageFromPeer(optionsChangeMessage) {
  // Read syncCounter at the end of options change message
  const peerSyncCounter = Number(optionsChangeMessage.slice(-1));
  if (peerSyncCounter === optionsChangeManager.peerSyncCounter) {
    // if peer resend prevMessage since peer did not recieve
    // the message ACK(acknowledgment) array buffer with length 1
    console.log(
      'arraybuffer with length 1 for options change message ACK resent'
    );
  } else if (peerSyncCounter === optionsChangeManager.nextPeerSyncCounter) {
    // if peer send new message
    optionsChangeManager.peerSyncCounter++;
    const options = JSON.parse(optionsChangeMessage.slice(0, -1));
    if (
      options.auto &&
      options.speed === 'fast' &&
      channel.willAskFastAutomatically
    ) {
      applyAutoAskChangingToFastSpeedWhenBothPeerDo();
      isAutoAskingFastWhenBothPeerDoApplied = true;
      return;
    }
    askOptionsChangeReceivedFromPeer(options);
  } else {
    console.log('invalid options change message received.');
    return;
  }

  // Send the message ACK array buffer with length 1.
  const buffer = new ArrayBuffer(1);
  const dataView = new DataView(buffer);
  dataView.setInt8(0, peerSyncCounter);
  safeSend(buffer);
}

/**
 * Send options change agree/disagree message to peer
 * @param {boolean} agree agree (true) or disagree (false)
 */
export function sendOptionsChangeAgreeMessageToPeer(agree) {
  let agreeMessageToPeer = String(agree);
  agreeMessageToPeer += String(optionsChangeAgreeManager.syncCounter);
  safeSend(agreeMessageToPeer);
  optionsChangeAgreeManager.resendIntervalID = setInterval(
    () => safeSend(agreeMessageToPeer),
    1000
  );
  return;
}

/**
 * Receive options change agree message ACK(acknowledgment) array buffer from peer.
 * @param {ArrayBuffer} data array buffer with length 1
 */
function receiveOptionsChangeAgreeMessageAckFromPeer(data) {
  const dataView = new DataView(data);
  const syncCounter = dataView.getInt8(0);
  if (syncCounter === optionsChangeAgreeManager.syncCounter) {
    optionsChangeAgreeManager.syncCounter++;
    clearInterval(optionsChangeAgreeManager.resendIntervalID);
  }
}

/**
 * Receive options change meesage from the peer
 * @param {string} optionsChangeAgreeMessage
 */
function receiveOptionsChangeAgreeMessageFromPeer(optionsChangeAgreeMessage) {
  // Read syncCounter at the end of options change agree message
  const peerSyncCounter = Number(optionsChangeAgreeMessage.slice(-1));
  if (peerSyncCounter === optionsChangeAgreeManager.peerSyncCounter) {
    // if peer resend prevMessage since peer did not recieve
    // the message ACK(acknowledgment) array buffer with length 1
    console.log(
      'arraybuffer with length 1 for options change message ACK resent'
    );
  } else if (
    peerSyncCounter === optionsChangeAgreeManager.nextPeerSyncCounter
  ) {
    // if peer send new message
    optionsChangeAgreeManager.peerSyncCounter++;
    const agree = optionsChangeAgreeMessage.slice(0, -1) === 'true';
    noticeAgreeMessageFromPeer(agree);
  } else {
    console.log('invalid options change message received.');
    return;
  }

  // Send the message ACK array buffer with length 1.
  const buffer = new ArrayBuffer(1);
  const dataView = new DataView(buffer);
  dataView.setInt8(0, peerSyncCounter);
  safeSend(buffer);
}

/**
 * Send chat enabled/disabled message to peer
 * @param {boolean} enabled true or false
 */
export function sendChatEnabledMessageToPeer(enabled) {
  let enabledMessageToPeer = String(enabled);
  enabledMessageToPeer += String(chatEnabledManager.syncCounter);
  safeSend(enabledMessageToPeer);
  chatEnabledManager.resendIntervalID = setInterval(
    () => safeSend(enabledMessageToPeer),
    1000
  );
  return;
}

/**
 * Receive chat enabled/disabled message ACK(acknowledgment) array buffer from peer.
 * @param {ArrayBuffer} data array buffer with length 1
 */
function receiveChatEnabledMessageAckFromPeer(data) {
  const dataView = new DataView(data);
  const syncCounter = dataView.getInt8(0);
  if (syncCounter === chatEnabledManager.syncCounter) {
    chatEnabledManager.syncCounter++;
    clearInterval(chatEnabledManager.resendIntervalID);
  }
}

/**
 * Receive chat enabled/disabled meesage from the peer
 * @param {string} chatEnabledMessage
 */
function receiveChatEnabledMessageFromPeer(chatEnabledMessage) {
  // Read syncCounter at the end of chat enabled/disabled message
  const peerSyncCounter = Number(chatEnabledMessage.slice(-1));
  if (peerSyncCounter === chatEnabledManager.peerSyncCounter) {
    // if peer resend prevMessage since peer did not recieve
    // the message ACK(acknowledgment) array buffer with length 1
    console.log(
      'arraybuffer with length 1 for chat enabled/disabled message ACK resent'
    );
  } else if (peerSyncCounter === chatEnabledManager.nextPeerSyncCounter) {
    // if peer send new message
    chatEnabledManager.peerSyncCounter++;
    const chatEnabled = chatEnabledMessage.slice(0, -1) === 'true';
    channel.peerChatEnabled = chatEnabled;
    displayMyAndPeerChatEnabledOrDisabled();
  } else {
    console.log('invalid chat enabled/disabled message received.');
    return;
  }

  // Send the message ACK array buffer with length 1.
  const buffer = new ArrayBuffer(1);
  const dataView = new DataView(buffer);
  dataView.setInt8(0, peerSyncCounter);
  safeSend(buffer);
}

/**
 * Send peer nickname shown/hidden message to peer
 * @param {boolean} shown true or false
 */
export function sendPeerNicknameShownMessageToPeer(shown) {
  let shownMessageToPeer = String(shown);
  shownMessageToPeer += String(peerNicknameShownManager.syncCounter);
  safeSend(shownMessageToPeer);
  peerNicknameShownManager.resendIntervalID = setInterval(
    () => safeSend(shownMessageToPeer),
    1000
  );
  return;
}

/**
 * Receive peer nickname shown/hidden ACK(acknowledgment) array buffer from peer.
 * @param {ArrayBuffer} data array buffer with length 1
 */
function receivePeerNicknameShownMessageAckFromPeer(data) {
  const dataView = new DataView(data);
  const syncCounter = dataView.getInt8(0);
  if (syncCounter === peerNicknameShownManager.syncCounter) {
    peerNicknameShownManager.syncCounter++;
    clearInterval(peerNicknameShownManager.resendIntervalID);
  }
}

/**
 * Receive peer nickname shown/hidden meesage from the peer
 * @param {string} peerNicknameShownMessage
 */
function receivePeerNicknameShownMessageFromPeer(peerNicknameShownMessage) {
  // Read syncCounter at the end of peer nickname shown/hidden message
  const peerSyncCounter = Number(peerNicknameShownMessage.slice(-1));
  if (peerSyncCounter === peerNicknameShownManager.peerSyncCounter) {
    // if peer resend prevMessage since peer did not recieve
    // the message ACK(acknowledgment) array buffer with length 1
    console.log(
      'arraybuffer with length 1 for peer nickname shown/hidden message ACK resent'
    );
  } else if (peerSyncCounter === peerNicknameShownManager.nextPeerSyncCounter) {
    // if peer send new message
    peerNicknameShownManager.peerSyncCounter++;
    const PeerNicknameShown = peerNicknameShownMessage.slice(0, -1) === 'true';
    channel.peerIsPeerNicknameVisible = PeerNicknameShown;
    displayMyAndPeerNicknameShownOrHidden();
  } else {
    console.log('invalid peer nickname shown/hidden message received.');
    return;
  }

  // Send the message ACK array buffer with length 1.
  const buffer = new ArrayBuffer(1);
  const dataView = new DataView(buffer);
  dataView.setInt8(0, peerSyncCounter);
  safeSend(buffer);
}

/**
 * Test average ping by sending ping test arraybuffers, then start the game
 */
function startGameAfterPingTest() {
  // Send my nick name to peer
  sendChatMessageToPeer(channel.myNickname);
  if (channel.willAskFastAutomatically) {
    autoAskChangingToFastSpeedToPeer(!isAutoAskingFastWhenBothPeerDoApplied);
  }

  printLog('start ping test');
  const buffer = new ArrayBuffer(1);
  const view = new DataView(buffer);
  view.setInt8(0, -1);
  let n = 0;
  const intervalID = setInterval(() => {
    if (n === 5) {
      window.clearInterval(intervalID);
      const sum = pingTestManager.pingMesurementArray.reduce(
        (acc, val) => acc + val,
        0
      );
      const avg = sum / pingTestManager.pingMesurementArray.length;
      console.log(
        `average ping: ${avg} ms, ping list: ${pingTestManager.pingMesurementArray}`
      );
      channel.callbackAfterDataChannelOpened();
      channel.callbackAfterDataChannelOpenedForUI();

      printAvgPing(avg);

      let t = 10;
      printStartsIn(t);
      const intervalID2 = setInterval(() => {
        t--;
        printStartsIn(t);
        if (t === 0) {
          window.clearInterval(intervalID2);
          hidePingBox();
          channel.gameStartAllowed = true;
          return;
        }
      }, 1000);
      return;
    }
    pingTestManager.pingSentTimeArray[n] = Date.now();
    safeSend(buffer);
    printPeriodInLog();
    n++;
  }, 1000);
}

/**
 * Respond to received ping test array buffer.
 * @param {ArrayBuffer} data array buffer with length 1
 */
function respondToPingTest(data) {
  const dataView = new DataView(data);
  if (dataView.getInt8(0) === -1) {
    const buffer = new ArrayBuffer(1);
    const view = new DataView(buffer);
    view.setInt8(0, -2);
    console.log('respond to ping');
    safeSend(buffer);
  } else if (dataView.getInt8(0) === -2) {
    pingTestManager.pingMesurementArray.push(
      Date.now() -
        pingTestManager.pingSentTimeArray[
          pingTestManager.receivedPingResponseNumber
        ]
    );
    pingTestManager.receivedPingResponseNumber++;
  }
}

/**
 * Event handler for the message event (which has data received from the peer) of data channel
 * @param {MessageEvent} event
 */
function recieveFromPeer(event) {
  const data = event.data;
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > 2 && data.byteLength <= 2 + 2 * bufferLength) {
      receiveInputQueueFromPeer(data);
      if (channel.callbackAfterPeerInputQueueReceived !== null) {
        const callback = channel.callbackAfterPeerInputQueueReceived;
        channel.callbackAfterPeerInputQueueReceived = null;
        window.setTimeout(callback, 0);
      }
    } else if (data.byteLength === 1) {
      const view = new DataView(data);
      const value = view.getInt8(0);
      if (value >= 8) {
        receivePeerNicknameShownMessageAckFromPeer(data);
      } else if (value >= 6) {
        receiveChatEnabledMessageAckFromPeer(data);
      } else if (value >= 4) {
        receiveOptionsChangeAgreeMessageAckFromPeer(data);
      } else if (value >= 2) {
        receiveOptionsChangeMessageAckFromPeer(data);
      } else if (value >= 0) {
        receiveChatMessageAckFromPeer(data);
      } else if (value < 0) {
        respondToPingTest(data);
      }
    }
  } else if (typeof data === 'string') {
    const syncCounter = Number(data.slice(-1));
    if (syncCounter >= 8) {
      receivePeerNicknameShownMessageFromPeer(data);
    } else if (syncCounter >= 6) {
      receiveChatEnabledMessageFromPeer(data);
    } else if (syncCounter >= 4) {
      receiveOptionsChangeAgreeMessageFromPeer(data);
    } else if (syncCounter >= 2) {
      receiveOptionsChangeMessageFromPeer(data);
    } else if (syncCounter >= 0) {
      receiveChatMessageFromPeer(data);
    }
  }
}

/**
 * Data channel open event listener
 */
function dataChannelOpened() {
  printLog('data channel opened!');
  console.log('data channel opened!');
  console.log(`dataChannel.ordered: ${dataChannel.ordered}`);
  console.log(`dataChannel.maxRetransmits: ${dataChannel.maxRetransmits}`);
  dataChannel.binaryType = 'arraybuffer';
  channel.isOpen = true;
  isDataChannelEverOpened = true;

  notifyBySound();
  cleanUpFirestoreRelevants();
  stopAdvertising();
  stopLobby();
  requestWakeLock();

  if (channel.isQuickMatch) {
    disableCancelQuickMatchBtnForAWhile();
  }

  // record roomId for RNG in replay
  replaySaver.recordRoomID(roomId);

  // Set the same RNG (used for the game) for both peers
  const customRng = seedrandom.alea(roomId.slice(10));
  setCustomRng(customRng);

  // Set the same RNG (used for displaying chat messages) for both peers
  const rngForPlayer1Chat = seedrandom.alea(roomId.slice(10, 15));
  const rngForPlayer2Chat = seedrandom.alea(roomId.slice(15));
  setChatRngs(rngForPlayer1Chat, rngForPlayer2Chat);

  startGameAfterPingTest();
}

/**
 * Data channel close event listener
 */
function dataChannelClosed() {
  console.log('data channel closed');
  channel.isOpen = false;
  noticeDisconnected();
}

function registerPeerConnectionListeners(peerConnection) {
  peerConnection.addEventListener('icegatheringstatechange', () => {
    console.log(
      `ICE gathering state changed: ${peerConnection.iceGatheringState}`
    );
    printLog(
      `ICE gathering state changed: ${peerConnection.iceGatheringState}`
    );
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    console.log(`Connection state change: ${peerConnection.connectionState}`);
    printLog(`Connection state change: ${peerConnection.connectionState}`);
    const state = peerConnection.connectionState;
    if (state === 'connected') {
      if (disconnectTimer !== null) {
        // recovered from a temporary disconnection
        window.clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
      logSelectedCandidatePair(peerConnection);
    } else if (state === 'disconnected' && isDataChannelEverOpened) {
      // Mobile networks often recover by themselves. Wait a while.
      if (disconnectTimer === null) {
        disconnectTimer = window.setTimeout(() => {
          disconnectTimer = null;
          if (peerConnection.connectionState !== 'connected') {
            channel.isOpen = false;
            noticeDisconnected();
          }
        }, DISCONNECT_GRACE_MS);
      }
    } else if (
      (state === 'closed' || state === 'failed') &&
      isDataChannelEverOpened
    ) {
      channel.isOpen = false;
      noticeDisconnected();
    }
    if (
      peerConnection.connectionState === 'failed' &&
      isDataChannelEverOpened === false
    ) {
      notifyBySound();
      printConnectionFailed();
    }
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    console.log(`Signaling state change: ${peerConnection.signalingState}`);
    printLog(`Signaling state change: ${peerConnection.signalingState}`);
  });

  peerConnection.addEventListener('iceconnectionstatechange ', () => {
    console.log(
      `ICE connection state change: ${peerConnection.iceConnectionState}`
    );
    printLog(
      `ICE connection state change: ${peerConnection.iceConnectionState}`
    );
  });

  peerConnection.addEventListener('datachannel', (event) => {
    dataChannel = event.channel;

    console.log('data channel received!', dataChannel);
    printLog('data channel received!');
    dataChannel.addEventListener('open', dataChannelOpened);
    dataChannel.addEventListener('message', recieveFromPeer);
    dataChannel.addEventListener('close', dataChannelClosed);
  });
}
