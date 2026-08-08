// Renderer for one display's overlay window. Receives the gremlin's global
// position from the main process and draws him if he's on this display.
//
// NOTE: this file must stay a plain script (no imports/exports) — it is
// loaded directly via a <script> tag, not through a bundler.

const params = new URLSearchParams(location.search);
const DX = Number(params.get('dx')) || 0; // this display's global origin
const DY = Number(params.get('dy')) || 0;

const SIZE = 96; // rendered gremlin size in px

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const bubble = document.getElementById('bubble') as HTMLDivElement;
const chatBox = document.getElementById('chat') as HTMLDivElement;
const chatLog = document.getElementById('chat-log') as HTMLDivElement;
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatCloseBtn = document.getElementById('chat-close') as HTMLButtonElement;
const ctx = canvas.getContext('2d')!;

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
resize();
window.addEventListener('resize', resize);

// --- Sprite sheet -----------------------------------------------------------
// 4x4 grid. Rows: 0 idle, 1 walk, 2 run, 3 [sit, sleep, held, surprised].
interface Anim {
  row: number;
  start: number;
  frames: number;
  fps: number;
}

const ANIMS: Record<GremlinState, Anim> = {
  idle: { row: 0, start: 0, frames: 4, fps: 4 },
  walk: { row: 1, start: 0, frames: 4, fps: 8 },
  run: { row: 2, start: 0, frames: 4, fps: 14 },
  sit: { row: 3, start: 0, frames: 1, fps: 1 },
  sleep: { row: 3, start: 1, frames: 1, fps: 1 },
  held: { row: 3, start: 2, frames: 1, fps: 1 },
  falling: { row: 3, start: 2, frames: 1, fps: 1 },
  surprised: { row: 3, start: 3, frames: 1, fps: 1 },
};

interface CellAlign {
  cx: number;
  bottomGap: number;
}

let sheet: HTMLCanvasElement | null = null; // chroma-keyed offscreen canvas
let cell = 0;
let cellAlign: CellAlign[] = []; // per cell (row*4+col), in sheet px

const img = new Image();
img.onload = () => {
  const off = document.createElement('canvas');
  off.width = img.width;
  off.height = img.height;
  const octx = off.getContext('2d')!;
  octx.drawImage(img, 0, 0);
  // Key out the background color (sampled from the top-left corner) so the
  // sheet works even if it wasn't generated with real transparency.
  const data = octx.getImageData(0, 0, off.width, off.height);
  const px = data.data;
  if (px[3] > 0) {
    const br = px[0], bg = px[1], bb = px[2];
    for (let i = 0; i < px.length; i += 4) {
      const dr = px[i] - br, dg = px[i + 1] - bg, db = px[i + 2] - bb;
      if (dr * dr + dg * dg + db * db < 90 * 90) px[i + 3] = 0;
    }
    octx.putImageData(data, 0, 0);
  }

  cell = Math.floor(off.width / 4);

  // Generated sheets rarely have the character flush with the cell edges.
  // Measure each cell's opaque bounding box so we can anchor feet to the
  // ground and center the body horizontally when drawing.
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let minX = cell, maxX = -1, maxY = -1;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const gx = col * cell + x;
          const gy = row * cell + y;
          if (px[(gy * off.width + gx) * 4 + 3] > 40) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) {
        cellAlign[row * 4 + col] = { cx: 0, bottomGap: 0 };
      } else {
        cellAlign[row * 4 + col] = {
          cx: (minX + maxX + 1) / 2 - cell / 2,
          bottomGap: cell - (maxY + 1),
        };
      }
    }
  }

  sheet = off;
};
img.src = '../../assets/gremlin-sheet.png';

// --- State from main --------------------------------------------------------
let frame: GremFrame | null = null;
let animState: GremlinState | null = null;
let animStart = 0;
let dragging = false;
let dragMoved = 0;

window.grem.onFrame((f) => {
  if (!frame || f.state !== frame.state) {
    animState = f.state;
    animStart = performance.now();
  }
  frame = f;
  document.body.classList.toggle('over-gremlin', f.hover && !dragging);
});

function onThisDisplay(f: GremFrame): boolean {
  const lx = f.x - DX;
  const ly = f.y - DY;
  return (
    lx > -SIZE &&
    lx < window.innerWidth + SIZE &&
    ly > -SIZE &&
    ly < window.innerHeight + SIZE * 2
  );
}

// --- Drawing ----------------------------------------------------------------
function draw(now: number): void {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  if (frame && sheet && onThisDisplay(frame)) {
    const anim = ANIMS[frame.state] || ANIMS.idle;
    const t = (now - animStart) / 1000;
    const idx = anim.start + (Math.floor(t * anim.fps) % anim.frames);
    const sx = idx * cell;
    const sy = anim.row * cell;
    const lx = frame.x - DX;
    const ly = frame.y - DY;
    const align = cellAlign[anim.row * 4 + idx] || { cx: 0, bottomGap: 0 };
    const scale = SIZE / cell;

    ctx.save();
    ctx.translate(lx, ly);
    if (frame.facing < 0) ctx.scale(-1, 1);
    ctx.drawImage(
      sheet,
      sx,
      sy,
      cell,
      cell,
      -SIZE / 2 - align.cx * scale,
      -SIZE + align.bottomGap * scale,
      SIZE,
      SIZE
    );
    ctx.restore();

    if (frame.say && !chatOpen) {
      bubble.textContent = frame.say;
      bubble.style.display = 'block';
      bubble.style.left = lx + 'px';
      bubble.style.top = ly - SIZE - 10 + 'px';
    } else {
      bubble.style.display = 'none';
    }

    if (chatOpen) {
      // Keep the bubble on-screen even when he sits near a screen edge.
      const half = chatBox.offsetWidth / 2;
      const cx = Math.max(half + 8, Math.min(window.innerWidth - half - 8, lx));
      chatBox.style.left = cx + 'px';
      chatBox.style.top = ly - SIZE - 14 + 'px';
    }
  } else {
    bubble.style.display = 'none';
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// --- Chat -------------------------------------------------------------------
let chatOpen = false;
let chatWaiting = false;
let typingEl: HTMLDivElement | null = null;

function addMsg(kind: 'user' | 'gremlin', text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function closeChat(): void {
  if (!chatOpen) return;
  chatOpen = false;
  chatWaiting = false;
  typingEl = null;
  chatBox.style.display = 'none';
  window.grem.chatClose();
}

window.grem.onChatOpen((history) => {
  chatOpen = true;
  chatWaiting = false;
  typingEl = null;
  chatLog.innerHTML = '';
  if (history.length === 0) {
    addMsg('gremlin', 'you rang?');
  } else {
    for (const m of history) {
      addMsg(m.role === 'user' ? 'user' : 'gremlin', m.text);
    }
  }
  chatBox.style.display = 'flex';
  chatInput.value = '';
  setTimeout(() => chatInput.focus(), 50);
});

window.grem.onChatReply((text) => {
  if (!chatOpen) return;
  if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
  chatWaiting = false;
  addMsg('gremlin', text);
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || chatWaiting) return;
  chatInput.value = '';
  addMsg('user', text);
  typingEl = addMsg('gremlin', '...');
  typingEl.classList.add('typing');
  chatWaiting = true;
  window.grem.chatSend(text);
});

chatCloseBtn.addEventListener('click', closeChat);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeChat();
});

// --- Mouse interaction ------------------------------------------------------
// Whether the window is click-through is decided by the main process (it
// polls the cursor each tick); frame.hover tells us the cursor is on him.
window.addEventListener('mousemove', (e) => {
  if (dragging) {
    dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
    window.grem.dragMove(DX + e.clientX, DY + e.clientY);
  }
});

window.addEventListener('contextmenu', (e) => {
  if (!frame || !frame.hover) return;
  e.preventDefault();
  window.grem.contextMenu(e.clientX, e.clientY);
});

window.addEventListener('mousedown', (e) => {
  if (chatOpen) {
    // While chatting the whole window is interactive; a click anywhere
    // outside the chat bubble (and not on the gremlin) dismisses it.
    if (!chatBox.contains(e.target as Node) && !frame?.hover) closeChat();
    return; // no dragging mid-conversation
  }
  if (!frame || !frame.hover || e.button !== 0) return;
  dragging = true;
  dragMoved = 0;
  document.body.classList.add('dragging');
  window.grem.grab(DX + e.clientX, DY + e.clientY);
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  if (dragMoved < 6) {
    // A click, not a drag: drop him and make him react.
    window.grem.release();
    window.grem.poke();
  } else {
    window.grem.release();
  }
});

window.addEventListener('blur', () => {
  if (dragging) {
    dragging = false;
    document.body.classList.remove('dragging');
    window.grem.release();
  }
});
