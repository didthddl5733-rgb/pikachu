/**
 * On-screen touch controls for mobile devices.
 * Left: arrow keys (D-pad, corners = diagonals). Right: power hit button.
 * Also handles fullscreen / landscape helpers.
 */
'use strict';

export const touchInput = {
  xDirection: 0,
  yDirection: 0,
  // combo HIT buttons: direction overrides while held
  comboX: 0, // 1 means "toward the opponent"
  comboY: 0,
  // incremented on every HIT/combo press (edge detection)
  hitPressCount: 0,
};

/** combo definitions: [comboX (forward), comboY] */
const COMBOS = [
  [0, -1],
  [1, -1],
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];
const ARROWS = {
  '0,-1': '&#8593;',
  '1,-1': ['&#8599;', '&#8598;'],
  '0,0': '',
  '1,0': ['&#8594;', '&#8592;'],
  '0,1': '&#8595;',
  '1,1': ['&#8600;', '&#8601;'],
};
let mirrored = null;

/**
 * Update combo button arrows depending on which side I play
 * @param {boolean} isPlayer2
 */
export function setComboSide(isPlayer2) {
  if (mirrored === isPlayer2) {
    return;
  }
  mirrored = isPlayer2;
  document.querySelectorAll('#touch-combos .combo').forEach((el) => {
    // @ts-ignore
    const key = el.dataset.combo;
    const a = ARROWS[key];
    const arrow = Array.isArray(a) ? a[isPlayer2 ? 1 : 0] : a;
    el.querySelector('.arrow').innerHTML = arrow;
  });
}

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
    '<div id="touch-combos">' +
    COMBOS.map(
      ([x, y]) =>
        `<div class="combo${
          x === 0 && y === 0 ? ' plain' : ''
        }" data-combo="${x},${y}">` +
        '<span class="arrow"></span><span class="label">HIT</span></div>'
    ).join('') +
    '</div>' +
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
  setUpComboButtons();
  setComboSide(false);

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

function setUpComboButtons() {
  const container = document.getElementById('touch-combos');
  /** @type {Map<number, HTMLElement>} */
  const active = new Map();
  const update = () => {
    let x = 0;
    let y = 0;
    for (const el of active.values()) {
      const [cx, cy] = el.dataset.combo.split(',').map(Number);
      if (cx !== 0) x = cx;
      if (cy !== 0) y = cy;
    }
    touchInput.comboX = x;
    touchInput.comboY = y;
    container.querySelectorAll('.combo').forEach((el) => {
      el.classList.toggle('pressed', [...active.values()].includes(el));
    });
  };
  const comboAt = (event) => {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    return el ? el.closest('#touch-combos .combo') : null;
  };
  container.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const el = comboAt(event);
    if (!el) {
      return;
    }
    try {
      container.setPointerCapture(event.pointerId);
    } catch (e) {
      // ignore
    }
    active.set(event.pointerId, el);
    update();
    touchInput.hitPressCount++;
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
    container.addEventListener(type, (event) => {
      if (active.delete(event.pointerId)) {
        update();
      }
    });
  });
}
