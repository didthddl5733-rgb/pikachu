/**
 * On-screen touch controls for mobile devices.
 * Left: 8-way direction pad. Right: power hit button.
 */
'use strict';

export const touchInput = {
  xDirection: 0,
  yDirection: 0,
  powerHitDown: false,
};

/**
 * Create the touch control elements and register event listeners
 */
export function setUpTouchControls() {
  const container = document.createElement('div');
  container.id = 'touch-controls';
  container.innerHTML =
    '<div id="touch-pad"><div id="touch-pad-knob"></div>' +
    '<span class="arrow up">&#9650;</span><span class="arrow down">&#9660;</span>' +
    '<span class="arrow left">&#9664;</span><span class="arrow right">&#9654;</span></div>' +
    '<div id="touch-hit">HIT</div>';
  document.body.appendChild(container);

  const pad = document.getElementById('touch-pad');
  const knob = document.getElementById('touch-pad-knob');
  const hit = document.getElementById('touch-hit');
  let padPointerId = null;

  const updatePad = (event) => {
    const rect = pad.getBoundingClientRect();
    const r = rect.width / 2;
    let dx = event.clientX - (rect.left + r);
    let dy = event.clientY - (rect.top + r);
    const dist = Math.hypot(dx, dy);
    if (dist < r * 0.2) {
      touchInput.xDirection = 0;
      touchInput.yDirection = 0;
    } else {
      // 8-way sectors
      const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
      const dirs = {
        0: [1, 0],
        1: [1, 1],
        2: [0, 1],
        3: [-1, 1],
        4: [-1, 0],
        '-4': [-1, 0],
        '-3': [-1, -1],
        '-2': [0, -1],
        '-1': [1, -1],
      };
      const d = dirs[sector];
      touchInput.xDirection = d[0];
      touchInput.yDirection = d[1];
    }
    const max = r * 0.6;
    if (dist > max) {
      dx = (dx / dist) * max;
      dy = (dy / dist) * max;
    }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  };

  const capture = (el, pointerId) => {
    try {
      el.setPointerCapture(pointerId);
    } catch (e) {
      // ignore
    }
  };

  const resetPad = () => {
    padPointerId = null;
    touchInput.xDirection = 0;
    touchInput.yDirection = 0;
    knob.style.transform = 'translate(-50%, -50%)';
  };

  pad.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    padPointerId = event.pointerId;
    capture(pad, event.pointerId);
    updatePad(event);
  });
  pad.addEventListener('pointermove', (event) => {
    if (event.pointerId === padPointerId) {
      event.preventDefault();
      updatePad(event);
    }
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
    pad.addEventListener(type, (event) => {
      if (event.pointerId === padPointerId) {
        resetPad();
      }
    });
  });

  hit.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    capture(hit, event.pointerId);
    touchInput.powerHitDown = true;
    hit.classList.add('pressed');
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
    hit.addEventListener(type, () => {
      touchInput.powerHitDown = false;
      hit.classList.remove('pressed');
    });
  });

  // Block context menu / long press selection on controls
  container.addEventListener('contextmenu', (event) => event.preventDefault());
}
