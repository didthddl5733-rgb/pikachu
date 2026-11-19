/**
 * On-screen touch controls for mobile devices.
 * Left: arrow keys (D-pad, corners = diagonals). Right: power hit button.
 * Also handles fullscreen / landscape helpers.
 */
'use strict';

export const touchInput = {
  xDirection: 0,
  yDirection: 0,
  powerHitDown: false,
};

const isKo = document.documentElement.lang === 'ko';
const TEXT = {
  rotate: isKo
    ? '휴대폰을 가로로 돌려주세요'
    : 'Please rotate your phone to landscape',
  fullscreen: isKo ? '가로 전체화면으로 전환' : 'Go fullscreen landscape',
  close: isKo ? '세로로 계속하기' : 'Continue in portrait',
};

/**
 * Enter fullscreen and try to lock landscape orientation
 */
export async function enterFullscreenLandscape() {
  const el = document.documentElement;
  try {
    if (!document.fullscreenElement) {
      if (el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: 'hide' });
        // @ts-ignore
      } else if (el.webkitRequestFullscreen) {
        // @ts-ignore
        el.webkitRequestFullscreen();
      }
    }
  } catch (e) {
    console.log('fullscreen failed', e);
  }
  try {
    // @ts-ignore
    if (screen.orientation && screen.orientation.lock) {
      // @ts-ignore
      await screen.orientation.lock('landscape');
    }
  } catch (e) {
    console.log('orientation lock failed', e);
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    enterFullscreenLandscape();
  }
}

/**
 * Create the touch control elements and register event listeners
 */
export function setUpTouchControls() {
  const container = document.createElement('div');
  container.id = 'touch-controls';
  container.innerHTML =
    '<div id="touch-dpad">' +
    '<div class="key up" data-dir="up">&#9650;</div>' +
    '<div class="key left" data-dir="left">&#9664;</div>' +
    '<div class="key right" data-dir="right">&#9654;</div>' +
    '<div class="key down" data-dir="down">&#9660;</div>' +
    '</div>' +
    '<div id="touch-hit">HIT</div>' +
    '<button type="button" id="touch-fullscreen-btn" aria-label="fullscreen">&#x26F6;</button>';
  document.body.appendChild(container);

  const rotateHint = document.createElement('div');
  rotateHint.id = 'rotate-hint';
  rotateHint.innerHTML =
    '<div class="rotate-icon">&#x21BB;</div>' +
    `<p>${TEXT.rotate}</p>` +
    `<button type="button" id="rotate-fullscreen-btn">${TEXT.fullscreen}</button>` +
    `<button type="button" id="rotate-close-btn">${TEXT.close}</button>`;
  document.body.appendChild(rotateHint);
  document
    .getElementById('rotate-fullscreen-btn')
    .addEventListener('click', () => enterFullscreenLandscape());
  document.getElementById('rotate-close-btn').addEventListener('click', () => {
    rotateHint.classList.add('dismissed');
  });
  document
    .getElementById('touch-fullscreen-btn')
    .addEventListener('click', toggleFullscreen);

  setUpDpad();
  setUpHitButton();

  // Block context menu / long press selection on controls
  container.addEventListener('contextmenu', (event) => event.preventDefault());
}

function setUpDpad() {
  const dpad = document.getElementById('touch-dpad');
  const keys = {
    up: dpad.querySelector('.up'),
    down: dpad.querySelector('.down'),
    left: dpad.querySelector('.left'),
    right: dpad.querySelector('.right'),
  };
  /** @type {Map<number, {col: number, row: number}>} */
  const pointers = new Map();

  const cellOf = (event) => {
    const rect = dpad.getBoundingClientRect();
    const col = Math.floor((3 * (event.clientX - rect.left)) / rect.width);
    const row = Math.floor((3 * (event.clientY - rect.top)) / rect.height);
    return {
      col: Math.max(0, Math.min(2, col)),
      row: Math.max(0, Math.min(2, row)),
    };
  };

  const update = () => {
    let left = false;
    let right = false;
    let up = false;
    let down = false;
    for (const { col, row } of pointers.values()) {
      if (col === 0) left = true;
      if (col === 2) right = true;
      if (row === 0) up = true;
      if (row === 2) down = true;
    }
    touchInput.xDirection = left === right ? 0 : left ? -1 : 1;
    touchInput.yDirection = up === down ? 0 : up ? -1 : 1;
    keys.left.classList.toggle('pressed', touchInput.xDirection === -1);
    keys.right.classList.toggle('pressed', touchInput.xDirection === 1);
    keys.up.classList.toggle('pressed', touchInput.yDirection === -1);
    keys.down.classList.toggle('pressed', touchInput.yDirection === 1);
  };

  dpad.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    try {
      dpad.setPointerCapture(event.pointerId);
    } catch (e) {
      // ignore
    }
    pointers.set(event.pointerId, cellOf(event));
    update();
  });
  dpad.addEventListener('pointermove', (event) => {
    if (pointers.has(event.pointerId)) {
      event.preventDefault();
      pointers.set(event.pointerId, cellOf(event));
      update();
    }
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
    dpad.addEventListener(type, (event) => {
      if (pointers.delete(event.pointerId)) {
        update();
      }
    });
  });
}

function setUpHitButton() {
  const hit = document.getElementById('touch-hit');
  const active = new Set();
  const update = () => {
    touchInput.powerHitDown = active.size > 0;
    hit.classList.toggle('pressed', touchInput.powerHitDown);
  };
  hit.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    try {
      hit.setPointerCapture(event.pointerId);
    } catch (e) {
      // ignore
    }
    active.add(event.pointerId);
    update();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
    hit.addEventListener(type, (event) => {
      if (active.delete(event.pointerId)) {
        update();
      }
    });
  });
}
