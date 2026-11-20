// STUN servers.
// network_test.js needs at least two STUN servers to detect symmetric NAT.
const stunServers = [
  {
    urls: ['stun:stun1.l.google.com:19302'],
  },
  {
    urls: ['stun:stun2.l.google.com:19302'],
  },
];

// TURN servers.
// When the two players can't connect directly (mobile data, school/office
// networks, strict NAT), the TURN server relays the game data between them.
// Without one, those players can never connect.
//
// Fill in the TURN address and credentials below.
// e.g. Metered (https://www.metered.ca/stun-turn) free plan:
//   after signing up, copy urls / username / credential from the dashboard's
//   "TURN Server" credentials as they are shown.
// While this array is empty, the game behaves exactly like before (STUN only).
const turnServers = [
  {
    urls: [
      'turn:seoul.relay.metered.ca:80',
      'turn:seoul.relay.metered.ca:80?transport=tcp',
      'turn:seoul.relay.metered.ca:443',
      'turns:seoul.relay.metered.ca:443?transport=tcp',
    ],
    username: 'f55ff2d5f8e41ebf5c1c53a0',
    credential: 'Y0IDeiSpjIOPUyOQ',
  },
];

// Config for real game connections: STUN + TURN.
export const rtcConfiguration = {
  iceServers: [...stunServers, ...turnServers],
};

// Config for the network test (network_test.js): STUN only.
// The test just checks the NAT type, so it doesn't need TURN
// (this also keeps it from eating TURN usage).
export const stunOnlyConfiguration = {
  iceServers: stunServers,
};

// Expose `rtcConfiguration` as a global variable so that it can be accessed in the browser console.
// Refer to:
// https://github.com/gorisanson/pikachu-volleyball-p2p-online/pull/27#issuecomment-1974752039
// @ts-ignore
window.rtcConfiguration = rtcConfiguration;
