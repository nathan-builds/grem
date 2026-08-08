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
const timerBox = document.getElementById('timer') as HTMLDivElement;
const timerForm = document.getElementById('timer-form') as HTMLFormElement;
const timerInput = document.getElementById('timer-input') as HTMLInputElement;
const timerHint = document.getElementById('timer-hint') as HTMLDivElement;
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

const ANIMS: Record<string, Anim> = {
  idle: { row: 0, start: 0, frames: 4, fps: 4 },
  walk: { row: 1, start: 0, frames: 4, fps: 8 },
  run: { row: 2, start: 0, frames: 4, fps: 14 },
  sit: { row: 3, start: 0, frames: 1, fps: 1 },
  sleep: { row: 3, start: 1, frames: 1, fps: 1 },
  held: { row: 3, start: 2, frames: 1, fps: 1 },
  falling: { row: 3, start: 2, frames: 1, fps: 1 },
  surprised: { row: 3, start: 3, frames: 1, fps: 1 },
};

// Poses that live on extra sheets. Each entry names its sheet (resolved
// lazily since sheets load async) and a fallback pose to try if that sheet
// is missing; fallback chains bottom out on the base sheet's ANIMS.
interface ExtraAnim {
  sheet: () => Sheet | null;
  anim: Anim;
  fallback: string;
}

const EXTRA_ANIMS: Record<string, ExtraAnim> = {
  // 4x4 actions sheet (gremlin-actions.png)
  carry: { sheet: () => actionSheet, anim: { row: 0, start: 0, frames: 2, fps: 6 }, fallback: 'walk' },
  climb: { sheet: () => actionSheet, anim: { row: 0, start: 2, frames: 2, fps: 5 }, fallback: 'held' },
  dig: { sheet: () => actionSheet, anim: { row: 1, start: 0, frames: 2, fps: 7 }, fallback: 'walk' },
  stir: { sheet: () => actionSheet, anim: { row: 1, start: 2, frames: 2, fps: 3 }, fallback: 'walk' },
  fishsit: { sheet: () => actionSheet, anim: { row: 2, start: 0, frames: 2, fps: 2 }, fallback: 'sit' },
  cheer: { sheet: () => actionSheet, anim: { row: 2, start: 2, frames: 2, fps: 5 }, fallback: 'surprised' },
  eat: { sheet: () => actionSheet, anim: { row: 3, start: 0, frames: 2, fps: 3 }, fallback: 'sit' },
  holdup: { sheet: () => actionSheet, anim: { row: 3, start: 2, frames: 2, fps: 4 }, fallback: 'surprised' },
  // 2x2 chef sheet (gremlin-chef.png): hat + apron
  chefstir: { sheet: () => chefSheet, anim: { row: 0, start: 0, frames: 2, fps: 3 }, fallback: 'stir' },
  chefeat: { sheet: () => chefSheet, anim: { row: 1, start: 0, frames: 2, fps: 3 }, fallback: 'eat' },
  // 2x2 popcorn sheet (gremlin-popcorn.png): 4-frame munch/toss loop
  // (cellIdx is row-major, so frames wrap onto the second row).
  popcorn: { sheet: () => popcornSheet, anim: { row: 0, start: 0, frames: 4, fps: 2.5 }, fallback: 'sit' },
};

interface CellAlign {
  cx: number;
  bottomGap: number;
}

interface Sheet {
  canvas: HTMLCanvasElement; // chroma-keyed offscreen canvas
  cell: number;
  cols: number;
  align: CellAlign[]; // per cell (row*cols+col), in sheet px
}

let sheet: Sheet | null = null; // main 4x4 sheet
let chatSheet: Sheet | null = null; // 2x2 glasses-and-keyboard sheet
let actionSheet: Sheet | null = null; // 4x4 activity poses sheet
let chefSheet: Sheet | null = null; // 2x2 chef hat + apron sheet
let popcornSheet: Sheet | null = null; // 2x2 popcorn bag sheet

function loadSheet(
  src: string,
  cols: number,
  rows: number,
  assign: (s: Sheet) => void
): void {
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
      const keyIsMagenta = br > 150 && bb > 150 && bg < 80;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const dr = r - br, dg = g - bg, db = b - bb;
        if (dr * dr + dg * dg + db * db < 90 * 90) {
          px[i + 3] = 0;
        } else if (
          // Darker shades of a magenta background are drop shadows baked
          // into generated art; key those out too.
          keyIsMagenta &&
          r > 90 &&
          b > 90 &&
          g < Math.min(r, b) * 0.45
        ) {
          px[i + 3] = 0;
        }
      }
      octx.putImageData(data, 0, 0);
    }

    const cell = Math.floor(off.width / cols);

    // Generated sheets rarely have the character flush with the cell edges.
    // Measure each cell's opaque bounding box so we can anchor feet to the
    // ground and center the body horizontally when drawing.
    const align: CellAlign[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
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
          align[row * cols + col] = { cx: 0, bottomGap: 0 };
        } else {
          align[row * cols + col] = {
            cx: (minX + maxX + 1) / 2 - cell / 2,
            bottomGap: cell - (maxY + 1),
          };
        }
      }
    }

    assign({ canvas: off, cell, cols, align });
  };
  img.src = src;
}

loadSheet('../../assets/gremlin-sheet.png', 4, 4, (s) => (sheet = s));
loadSheet('../../assets/gremlin-chat.png', 2, 2, (s) => (chatSheet = s));
loadSheet('../../assets/gremlin-actions.png', 4, 4, (s) => (actionSheet = s));
loadSheet('../../assets/gremlin-chef.png', 2, 2, (s) => (chefSheet = s));
loadSheet('../../assets/gremlin-popcorn.png', 2, 2, (s) => (popcornSheet = s));

// --- State from main --------------------------------------------------------
let frame: GremFrame | null = null;
let animStart = 0;
let dragging = false;
let dragMoved = 0;

window.grem.onFrame((f) => {
  // Restart the animation clock when the rendered pose changes (activities
  // can change pose without changing state, and vice versa for chatting).
  if (!frame || f.pose !== frame.pose || f.state !== frame.state) {
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

// --- Props ------------------------------------------------------------------
// Activity props arrive in global coordinates and are drawn procedurally in
// a chunky pixel-art style. Every window draws every prop (converted to its
// own local space), so a fishing line or tunnel exit can span monitors.

const PROP_BEHIND: Record<GremProp['kind'], boolean> = {
  box: true,
  pole: true,
  campfire: true,
  mound: true,
  chute: false,
  rod: false,
  line: false,
  catch: false,
  steam: false,
  dirt: false,
};

function pxRect(x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

// (x, y) = bottom center of the crate.
function drawBox(x: number, y: number, alpha: number): void {
  ctx.globalAlpha = alpha;
  const s = 40;
  pxRect(x - s / 2, y - s, s, s, '#b07a44');
  ctx.strokeStyle = '#6e4520';
  ctx.lineWidth = 3;
  ctx.strokeRect(Math.round(x - s / 2) + 1.5, Math.round(y - s) + 1.5, s - 3, s - 3);
  ctx.strokeStyle = '#8a5a2c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - s / 2 + 4, y - s + 4);
  ctx.lineTo(x + s / 2 - 4, y - 4);
  ctx.moveTo(x + s / 2 - 4, y - s + 4);
  ctx.lineTo(x - s / 2 + 4, y - 4);
  ctx.stroke();
}

function drawPole(x: number, y: number, h: number, alpha: number): void {
  ctx.globalAlpha = alpha;
  pxRect(x - 3, y - h, 6, h, '#8a9098');
  pxRect(x - 5, y - h - 2, 10, 4, '#c8cdd4');
  ctx.fillStyle = '#d8433b';
  ctx.beginPath();
  ctx.moveTo(x + 4, y - h + 2);
  ctx.lineTo(x + 28, y - h + 9);
  ctx.lineTo(x + 4, y - h + 16);
  ctx.closePath();
  ctx.fill();
}

// (x, y) = gremlin feet; the canopy floats above his head.
function drawChute(x: number, y: number, sway: number): void {
  const cx = x + sway * 12;
  const cy = y - 108;
  const R = 46;
  ctx.strokeStyle = '#d9d4c8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - R + 6, cy);
  ctx.lineTo(x - 12, y - 66);
  ctx.moveTo(cx + R - 6, cy);
  ctx.lineTo(x + 12, y - 66);
  ctx.moveTo(cx, cy - 2);
  ctx.lineTo(x, y - 68);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.arc(cx, cy, R, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = '#d8433b';
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = '#f2ece0';
  ctx.fillRect(cx - R * 0.6, cy - R, R * 0.35, R);
  ctx.fillRect(cx + R * 0.25, cy - R, R * 0.35, R);
  ctx.restore();
  ctx.strokeStyle = '#a83229';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.stroke();
}

function drawRod(x: number, y: number, tipX: number, tipY: number): void {
  ctx.strokeStyle = '#7a4e22';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
}

// Points are global; converted here since the line spans arbitrary space.
function drawFishline(points: { x: number; y: number }[], bobber: boolean): void {
  if (points.length < 2) return;
  ctx.strokeStyle = 'rgba(240, 240, 235, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(points[0].x - DX, points[0].y - DY);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x - DX, points[i].y - DY);
  }
  ctx.stroke();
  if (bobber) {
    const end = points[points.length - 1];
    const bx = end.x - DX;
    const by = end.y - DY;
    ctx.beginPath();
    ctx.arc(bx, by, 5, Math.PI, 0);
    ctx.fillStyle = '#d8433b';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, 5, 0, Math.PI);
    ctx.fillStyle = '#f2ece0';
    ctx.fill();
  }
}

function drawCatch(x: number, y: number, what: 'fish' | 'boot'): void {
  if (what === 'fish') {
    ctx.fillStyle = '#e8933c';
    ctx.beginPath();
    ctx.ellipse(x, y, 11, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 9, y);
    ctx.lineTo(x - 17, y - 6);
    ctx.lineTo(x - 17, y + 6);
    ctx.closePath();
    ctx.fill();
    pxRect(x + 5, y - 2, 3, 3, '#2b2119');
  } else {
    pxRect(x - 5, y - 16, 9, 13, '#7a5230');
    pxRect(x - 5, y - 5, 14, 5, '#7a5230');
    pxRect(x - 6, y - 1, 16, 3, '#4a3018');
  }
}

function drawCampfire(x: number, y: number, t: number, alpha: number): void {
  ctx.globalAlpha = alpha;
  // spit: two side sticks and a crossbar the pot hangs from
  pxRect(x - 24, y - 54, 3, 54, '#6e4a2a');
  pxRect(x + 21, y - 54, 3, 54, '#6e4a2a');
  pxRect(x - 24, y - 57, 48, 3, '#5d3f24');
  pxRect(x - 1, y - 54, 2, 8, '#c9b28a');
  // pot
  pxRect(x - 14, y - 46, 28, 16, '#33383e');
  pxRect(x - 16, y - 48, 32, 4, '#22262a');
  pxRect(x - 10, y - 43, 8, 2, '#5a616b');
  // logs
  pxRect(x - 16, y - 6, 32, 5, '#6e4a2a');
  pxRect(x - 12, y - 9, 24, 4, '#5d3f24');
  // flames, flickering
  const h = 16 + Math.sin(t * 9) * 3 + Math.sin(t * 23) * 2;
  ctx.fillStyle = '#e0662f';
  ctx.beginPath();
  ctx.moveTo(x - 9, y - 8);
  ctx.lineTo(x, y - 8 - h);
  ctx.lineTo(x + 9, y - 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f8c948';
  ctx.beginPath();
  ctx.moveTo(x - 5, y - 8);
  ctx.lineTo(x, y - 8 - h * 0.6);
  ctx.lineTo(x + 5, y - 8);
  ctx.closePath();
  ctx.fill();
}

function drawSteam(x: number, y: number, alpha: number): void {
  ctx.globalAlpha = alpha * 0.7;
  ctx.fillStyle = '#eceff2';
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawMound(x: number, y: number, alpha: number): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#6e4a2a';
  ctx.beginPath();
  ctx.ellipse(x, y - 3, 24, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#7d5631';
  for (const [ox, oy, r] of [[-20, -6, 4], [18, -7, 5], [2, -11, 4]] as const) {
    ctx.beginPath();
    ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#1e1710';
  ctx.beginPath();
  ctx.ellipse(x, y - 3, 15, 5, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawDirt(x: number, y: number, alpha: number): void {
  ctx.globalAlpha = Math.max(0, alpha);
  pxRect(x - 2, y - 2, 4, 4, '#5d3f24');
}

function drawProp(p: GremProp): void {
  ctx.save();
  switch (p.kind) {
    case 'box':
      drawBox(p.x - DX, p.y - DY, p.alpha);
      break;
    case 'pole':
      drawPole(p.x - DX, p.y - DY, p.height, p.alpha);
      break;
    case 'chute':
      drawChute(p.x - DX, p.y - DY, p.sway);
      break;
    case 'rod':
      drawRod(p.x - DX, p.y - DY, p.tipX - DX, p.tipY - DY);
      break;
    case 'line':
      drawFishline(p.points, p.bobber);
      break;
    case 'catch':
      drawCatch(p.x - DX, p.y - DY, p.what);
      break;
    case 'campfire':
      drawCampfire(p.x - DX, p.y - DY, p.t, p.alpha);
      break;
    case 'steam':
      drawSteam(p.x - DX, p.y - DY, p.alpha);
      break;
    case 'mound':
      drawMound(p.x - DX, p.y - DY, p.alpha);
      break;
    case 'dirt':
      drawDirt(p.x - DX, p.y - DY, p.alpha);
      break;
  }
  ctx.restore();
}

// --- Confetti -----------------------------------------------------------
// Fired when a sleep timer goes off. Each overlay window runs its own local
// particle burst from the gremlin's (global) position, so pieces arc onto
// neighboring displays too.
interface ConfettiPiece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vrot: number;
  color: string;
  life: number; // seconds lived
  maxLife: number;
  phase: number; // flutter offset
}

const CONFETTI_COLORS = [
  '#ff5252',
  '#ffb340',
  '#ffe14d',
  '#5ce07e',
  '#4dc3ff',
  '#b06cff',
  '#ff7ad0',
];
const CONFETTI_COUNT = 160;
const CONFETTI_GRAVITY = 850; // px/s^2
const CONFETTI_MAX_FALL = 160; // px/s terminal velocity (paper flutters)

let confetti: ConfettiPiece[] = [];

window.grem.onConfetti((origin) => {
  const ox = origin.x - DX;
  const oy = origin.y - DY - 50; // burst from around his head
  for (let i = 0; i < CONFETTI_COUNT; i++) {
    // Upward fan with a wide spread so pieces shower the whole screen.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.25;
    const speed = 350 + Math.random() * 750;
    confetti.push({
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 4 + Math.random() * 3,
      h: 5 + Math.random() * 5,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 14,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      life: 0,
      maxLife: 2.6 + Math.random() * 1.6,
      phase: Math.random() * Math.PI * 2,
    });
  }
});

function updateConfetti(dt: number): void {
  for (const p of confetti) {
    p.life += dt;
    p.vy = Math.min(p.vy + CONFETTI_GRAVITY * dt, CONFETTI_MAX_FALL);
    p.vx *= Math.exp(-1.4 * dt); // air drag on the launch kick
    p.x += (p.vx + Math.sin(p.life * 5 + p.phase) * 45) * dt;
    p.y += p.vy * dt;
    p.rot += p.vrot * dt;
  }
  confetti = confetti.filter((p) => p.life < p.maxLife);
}

function drawConfetti(): void {
  for (const p of confetti) {
    const fade = 1 - p.life / p.maxLife;
    ctx.save();
    ctx.globalAlpha = Math.min(1, fade * 3); // opaque until the last third
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    // Fake 3D tumble by squashing the width.
    ctx.scale(Math.abs(Math.sin(p.life * 7 + p.phase)) * 0.8 + 0.2, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
}

// --- Drawing ----------------------------------------------------------------
let lastDrawNow = 0;

function draw(now: number): void {
  const dt = Math.min((now - lastDrawNow) / 1000, 0.05);
  lastDrawNow = now;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  if (confetti.length) updateConfetti(dt);

  if (frame && sheet) {
    const props = frame.props || [];
    for (const p of props) if (PROP_BEHIND[p.kind]) drawProp(p);

    // Skip him while he's tunnelling underground, but keep drawing props.
    const visible = onThisDisplay(frame) && !frame.hidden;
    if (visible) {
      const t = (now - animStart) / 1000;

      // While chatting he swaps to the glasses-and-keyboard sheet: frame 0 is
      // resting, frames 1-3 cycle as a typing animation while a reply is due.
      const useChat = frame.state === 'chatting' && chatSheet !== null;
      let sh: Sheet;
      let cellIdx: number;
      if (useChat) {
        sh = chatSheet!;
        cellIdx = chatWaiting ? 1 + (Math.floor(t * 8) % 3) : 0;
      } else {
        // Resolve the pose: extra-sheet pose if its sheet loaded, otherwise
        // walk the fallback chain down to the base sheet.
        let pose: string = frame.pose;
        let anim: Anim | null = null;
        sh = sheet;
        for (let guard = 0; guard < 4 && !anim; guard++) {
          const extra = EXTRA_ANIMS[pose];
          if (extra) {
            const es = extra.sheet();
            if (es) {
              sh = es;
              anim = extra.anim;
            } else {
              pose = extra.fallback;
            }
          } else {
            anim = ANIMS[pose] || ANIMS.idle;
          }
        }
        if (!anim) anim = ANIMS.idle;
        cellIdx =
          anim.row * sh.cols + anim.start + (Math.floor(t * anim.fps) % anim.frames);
      }

      const sx = (cellIdx % sh.cols) * sh.cell;
      const sy = Math.floor(cellIdx / sh.cols) * sh.cell;
      const lx = frame.x - DX;
      const ly = frame.y - DY;
      const align = sh.align[cellIdx] || { cx: 0, bottomGap: 0 };
      const scale = SIZE / sh.cell;

      ctx.save();
      ctx.translate(lx, ly);
      if (frame.facing < 0) ctx.scale(-1, 1);
      ctx.drawImage(
        sh.canvas,
        sx,
        sy,
        sh.cell,
        sh.cell,
        -SIZE / 2 - align.cx * scale,
        -SIZE + align.bottomGap * scale,
        SIZE,
        SIZE
      );
      ctx.restore();
    }

    for (const p of props) if (!PROP_BEHIND[p.kind]) drawProp(p);

    if (visible) {
      const lx = frame.x - DX;
      const ly = frame.y - DY;
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

    if (timerOpen) {
      const half = timerBox.offsetWidth / 2;
      const cx = Math.max(half + 8, Math.min(window.innerWidth - half - 8, lx));
      timerBox.style.left = cx + 'px';
      timerBox.style.top = ly - SIZE - 14 + 'px';
    }
    } else {
      bubble.style.display = 'none';
    }
  } else {
    bubble.style.display = 'none';
  }

  if (confetti.length) drawConfetti();

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
  // The timer prompt can't stay up under the chat box (main already
  // restored click-through for it).
  timerOpen = false;
  timerBox.style.display = 'none';
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
  if (e.key === 'Escape') {
    closeChat();
    closeTimerPrompt();
  }
});

// --- Timer prompt -----------------------------------------------------------
let timerOpen = false;

// "1h30m", "5m", "90s", "1h", or a bare number (minutes). Decimals allowed.
function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t) * 60;
  const m = t.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const seconds =
    (m[1] ? parseFloat(m[1]) * 3600 : 0) +
    (m[2] ? parseFloat(m[2]) * 60 : 0) +
    (m[3] ? parseFloat(m[3]) : 0);
  return seconds > 0 ? seconds : null;
}

function closeTimerPrompt(): void {
  if (!timerOpen) return;
  timerOpen = false;
  timerBox.style.display = 'none';
  window.grem.timerPromptClose();
}

window.grem.onTimerPrompt(() => {
  timerOpen = true;
  timerInput.value = '';
  timerHint.style.display = 'none';
  timerBox.style.display = 'flex';
  setTimeout(() => timerInput.focus(), 50);
});

timerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const seconds = parseDuration(timerInput.value);
  if (seconds === null) {
    timerHint.style.display = 'block';
    timerInput.select();
    return;
  }
  timerOpen = false;
  timerBox.style.display = 'none';
  window.grem.timerSet(seconds); // main restores click-through
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
  if (timerOpen) {
    // Clicking anywhere outside the prompt dismisses it.
    if (!timerBox.contains(e.target as Node)) closeTimerPrompt();
    return;
  }
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
