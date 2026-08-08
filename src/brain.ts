// The gremlin's behavior engine. Runs in the main process and simulates the
// gremlin in *global* screen coordinates so he can roam across displays.
// (x, y) is the point between his feet.

const WALK_SPEED = 70; // px/s
const RUN_SPEED = 210;
const GRAVITY = 2600; // px/s^2
const SURPRISED_TIME = 1.1; // s

const PHRASES = [
  'hey!',
  'grr!',
  'hehehe',
  'whatcha doing?',
  'leave me be!',
  'got snacks?',
  '!!',
  'busy busy busy',
];

// --- Activities ---------------------------------------------------------
// Scripted multi-phase behaviors. Each one drives the gremlin's position,
// pose, and a set of procedurally-drawn props (see GremProp in types.d.ts).

const BOX = 40; // crate size, px (rendered)
const ACTIVITY_CHANCE = 0.3; // chance per pickNextAction once off cooldown
const HOP_TIME = 0.38; // s per crate-climb hop
const CHUTE_FALL = 85; // px/s descent under canopy

const FOOD_PHRASES = ['soup!!', 'mmm. bug stew.', 'chef gremlin!', 'needs more crunch'];
const FISH_PHRASES = ['dinner!!', 'gotcha, fishy!', 'big one!!'];
const BOOT_PHRASES = ['a boot?!', 'grr. boot.', 'who fishes up a BOOT'];
const DIG_PHRASES = ['hehehe', 'surprise!', 'shortcut!'];

interface DirtParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
}

interface ActBoxes {
  kind: 'boxes';
  phase: 'carry' | 'climb' | 'sit' | 'leap' | 'fade';
  stackX: number;
  fetchX: number;
  count: number;
  placed: number;
  carrying: boolean;
  side: number; // which side of the stack he climbs from
  level: number;
  fromX: number;
  fromY: number;
  vx: number;
  vy: number;
  alpha: number;
  t: number;
}

interface ActFishing {
  kind: 'fishing';
  phase: 'cast' | 'wait' | 'reel' | 'show';
  t: number;
  casts: number;
  prog: number; // 0..1 line extension
  targetX: number;
  endX: number;
  endY: number;
  what: 'fish' | 'boot' | null;
}

interface ActCooking {
  kind: 'cooking';
  phase: 'stir' | 'eat' | 'fade';
  t: number;
  time: number; // total elapsed, drives flame flicker
  fireX: number;
  alpha: number;
  spawn: number; // countdown to next steam puff
  steam: { x: number; y: number; vy: number; alpha: number }[];
}

interface ActParachute {
  kind: 'parachute';
  phase: 'grow' | 'climb' | 'perch' | 'jump' | 'drift' | 'land';
  t: number;
  poleX: number;
  poleH: number;
  ground: number;
  grow: number;
  vy: number;
  sway: number;
  poleAlpha: number;
}

interface ActDigging {
  kind: 'digging';
  phase: 'dig' | 'travel' | 'emerge' | 'fade';
  t: number;
  holeA: { x: number; y: number };
  holeB: { x: number; y: number } | null;
  alpha: number;
  spawn: number;
  dirt: DirtParticle[];
  vy: number;
}

type Activity = ActBoxes | ActFishing | ActCooking | ActParachute | ActDigging;

interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Structural subset of Electron's Display; keeps this module free of
// electron imports so it stays trivially unit-testable.
interface BrainDisplay {
  id: number;
  workArea: WorkArea;
}

export class Brain {
  displays: BrainDisplay[] = [];
  x = 0;
  y = 0;
  vy = 0;
  facing = 1; // 1 = right, -1 = left
  state: GremlinState = 'idle';
  stateTime = 2;
  say: { text: string; until: number } | null = null; // until = ms epoch
  spawned = false;
  chatting = false; // pinned in place while the chat bubble is open
  act: Activity | null = null;
  pose: GremlinPose = 'idle';
  hidden = false; // underground mid-dig
  props: GremProp[] = []; // rebuilt every tick by the active activity
  actCooldown = 12; // s until an activity may be rolled again
  enabledActivities: Record<GremActivity, boolean> = {
    boxes: true,
    fishing: true,
    cooking: true,
    parachute: true,
    digging: true,
  };

  setDisplays(displays: BrainDisplay[]): void {
    this.displays = displays.map((d) => ({ id: d.id, workArea: d.workArea }));
    if (!this.spawned && this.displays.length) {
      const wa = this.displays[0].workArea;
      this.x = wa.x + wa.width / 2;
      this.y = wa.y + wa.height;
      this.spawned = true;
    } else if (this.spawned && !this.groundAt(this.x)) {
      // The display he was on disappeared; respawn on the first one.
      this.cancelActivity();
      const wa = this.displays[0].workArea;
      this.x = wa.x + wa.width / 2;
      this.y = wa.y + wa.height;
      this.state = 'falling';
      this.vy = 0;
    }
  }

  // Ground level (bottom of the work area) for the display under global x.
  // Prefers a display whose floor is at or below the current feet position.
  groundAt(x: number, y: number = this.y): number | null {
    let best: number | null = null;
    for (const d of this.displays) {
      const wa = d.workArea;
      if (x < wa.x || x > wa.x + wa.width) continue;
      const floor = wa.y + wa.height;
      if (best === null) best = floor;
      else if (floor >= y - 4 && (best < y - 4 || floor < best)) best = floor;
    }
    return best;
  }

  // Work area of the display he's currently standing on (matches groundAt).
  workAreaAt(x: number): WorkArea | null {
    const g = this.groundAt(x);
    if (g === null) return null;
    for (const d of this.displays) {
      const wa = d.workArea;
      if (x >= wa.x && x <= wa.x + wa.width && wa.y + wa.height === g) {
        return wa;
      }
    }
    return null;
  }

  pickNextAction(): void {
    if (
      this.actCooldown <= 0 &&
      Math.random() < ACTIVITY_CHANCE &&
      this.workAreaAt(this.x) !== null
    ) {
      this.startActivity();
      return;
    }
    const r = Math.random();
    if (r < 0.4) {
      this.state = 'walk';
      this.stateTime = 2 + Math.random() * 6;
      if (Math.random() < 0.5) this.facing *= -1;
    } else if (r < 0.55) {
      this.state = 'run';
      this.stateTime = 1 + Math.random() * 3;
    } else if (r < 0.8) {
      this.state = 'idle';
      this.stateTime = 2 + Math.random() * 5;
    } else if (r < 0.93) {
      this.state = 'sit';
      this.stateTime = 4 + Math.random() * 8;
    } else {
      this.state = 'sleep';
      this.stateTime = 8 + Math.random() * 15;
    }
  }

  // Commanded sleep: stays asleep in place until poked, grabbed, or woken.
  sleep(): void {
    if (this.state === 'held' || this.state === 'falling' || this.chatting)
      return;
    this.cancelActivity();
    const ground = this.groundAt(this.x);
    if (ground !== null) this.y = ground;
    this.state = 'sleep';
    this.stateTime = Infinity;
  }

  wake(): void {
    if (this.state !== 'sleep') return;
    this.state = 'idle';
    this.stateTime = 1 + Math.random() * 2;
  }

  // Chat mode: sit still (glasses on, keyboard out) so the chat bubble stays
  // anchored, and keep quiet (no random phrases) until the conversation ends.
  startChat(): void {
    this.cancelActivity();
    this.chatting = true;
    this.say = null;
    const ground = this.groundAt(this.x);
    if (ground !== null) this.y = ground;
    this.vy = 0;
    this.state = 'chatting';
    this.stateTime = Infinity;
  }

  endChat(): void {
    if (!this.chatting) return;
    this.chatting = false;
    this.state = 'idle';
    this.stateTime = 1 + Math.random() * 2;
  }

  poke(): void {
    if (this.state === 'held' || this.chatting) return;
    this.cancelActivity();
    this.state = 'surprised';
    this.stateTime = SURPRISED_TIME;
    const text = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    this.say = { text, until: Date.now() + 2500 };
  }

  grab(x: number, y: number): void {
    if (this.chatting) return; // he's busy talking
    this.cancelActivity();
    this.state = 'held';
    this.x = x;
    this.y = y + 34; // dangle below the cursor
    this.vy = 0;
  }

  dragMove(x: number, y: number): void {
    if (this.state !== 'held') return;
    this.x = x;
    this.y = y + 34;
  }

  release(): void {
    if (this.state !== 'held') return;
    this.state = 'falling';
    this.vy = 0;
  }

  tick(dt: number): Omit<GremFrame, 'hover'> {
    if (this.say && Date.now() > this.say.until) this.say = null;
    this.actCooldown -= dt;
    this.props = [];

    switch (this.state) {
      case 'walk':
      case 'run': {
        const speed = this.state === 'run' ? RUN_SPEED : WALK_SPEED;
        const nx = this.x + speed * dt * this.facing;
        const ground = this.groundAt(nx);
        if (ground === null) {
          this.facing *= -1; // hit the edge of the world
        } else {
          this.x = nx;
          if (ground > this.y + 4) {
            // Walked onto a display whose floor is lower: fall to it.
            this.state = 'falling';
            this.vy = 0;
          } else {
            this.y = ground;
          }
        }
        this.stateTime -= dt;
        if (this.stateTime <= 0) this.pickNextAction();
        break;
      }
      case 'idle':
      case 'sit':
      case 'sleep':
        this.stateTime -= dt;
        if (this.stateTime <= 0) this.pickNextAction();
        break;
      case 'surprised': {
        this.stateTime -= dt;
        if (this.stateTime <= 0) {
          const ground = this.groundAt(this.x);
          if (ground !== null && this.y < ground - 2) {
            this.state = 'falling';
            this.vy = 0;
          } else {
            this.pickNextAction();
          }
        }
        break;
      }
      case 'falling': {
        this.vy += GRAVITY * dt;
        this.y += this.vy * dt;
        const ground = this.groundAt(this.x);
        if (ground !== null && this.y >= ground) {
          this.y = ground;
          this.vy = 0;
          this.state = 'idle';
          this.stateTime = 1 + Math.random() * 2;
        } else if (ground === null && this.y > 20000) {
          // Fell into the void between displays; respawn.
          this.spawned = false;
          this.setDisplays(
            this.displays.map((d) => ({ id: d.id, workArea: d.workArea }))
          );
          this.state = 'idle';
          this.stateTime = 2;
        }
        break;
      }
      case 'held':
        break; // position driven by dragMove
      case 'chatting':
        break; // pinned in place until endChat()
      case 'boxes':
      case 'fishing':
      case 'cooking':
      case 'parachute':
      case 'digging':
        if (this.act) {
          this.tickActivity(dt);
        } else {
          this.state = 'idle';
          this.stateTime = 2;
        }
        break;
    }

    // Activities set this.pose themselves each tick; for plain states the
    // pose is the state (chatting renders from its own sheet, sit is a
    // harmless fallback there).
    if (!this.act) {
      this.pose =
        this.state === 'chatting' ? 'sit' : (this.state as GremlinPose);
    }

    return {
      x: this.x,
      y: this.y,
      state: this.state,
      pose: this.pose,
      facing: this.facing,
      say: this.say ? this.say.text : null,
      hidden: this.hidden,
      props: this.props,
    };
  }

  // --- Activity engine ------------------------------------------------------

  cancelActivity(): void {
    if (!this.act) return;
    // If he's mid-tunnel, put him back at the entrance before reappearing.
    if (this.act.kind === 'digging' && this.hidden) {
      this.x = this.act.holeA.x;
      this.y = this.act.holeA.y;
    }
    this.act = null;
    this.hidden = false;
    this.props = [];
  }

  private finishActivity(): void {
    this.act = null;
    this.hidden = false;
    this.pickNextAction();
  }

  private sayFrom(pool: string[]): void {
    const text = pool[Math.floor(Math.random() * pool.length)];
    this.say = { text, until: Date.now() + 2500 };
  }

  // Apply the settings toggles. If he's mid-way through a newly disabled
  // activity, stop it on the spot.
  setEnabledActivities(map: Record<GremActivity, boolean>): void {
    this.enabledActivities = { ...map };
    if (this.act && !this.enabledActivities[this.act.kind]) {
      this.cancelActivity();
      this.state = 'idle';
      this.stateTime = 1 + Math.random() * 2;
    }
  }

  private startActivity(): void {
    const wa = this.workAreaAt(this.x);
    const ground = this.groundAt(this.x);
    if (!wa || ground === null) {
      this.state = 'idle';
      this.stateTime = 2;
      return;
    }
    const all: GremActivity[] = [
      'boxes',
      'fishing',
      'cooking',
      'parachute',
      'digging',
    ];
    const kinds = all.filter((k) => this.enabledActivities[k]);
    if (kinds.length === 0) {
      this.state = 'idle';
      this.stateTime = 2;
      return;
    }
    this.actCooldown = 40 + Math.random() * 80;
    this.y = ground;
    this.vy = 0;
    const clampX = (v: number, pad: number) =>
      Math.max(wa.x + pad, Math.min(wa.x + wa.width - pad, v));

    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    this.state = kind;
    this.stateTime = Infinity;

    switch (kind) {
      case 'boxes': {
        const stackX = clampX(this.x + this.facing * 90, 130);
        // Fetch boxes from whichever side of the stack has more room.
        const side = stackX - wa.x > wa.x + wa.width - stackX ? -1 : 1;
        const fetchX = clampX(stackX + side * 170, 50);
        this.act = {
          kind,
          phase: 'carry',
          stackX,
          fetchX,
          count: 2 + Math.floor(Math.random() * 3),
          placed: 0,
          carrying: false,
          side,
          level: 0,
          fromX: 0,
          fromY: 0,
          vx: 0,
          vy: 0,
          alpha: 1,
          t: 0,
        };
        break;
      }
      case 'fishing': {
        // Face whichever way has more open "water" to cast into.
        this.facing = wa.x + wa.width - this.x >= this.x - wa.x ? 1 : -1;
        const targetX = clampX(
          this.x + this.facing * (180 + Math.random() * 260),
          30
        );
        this.act = {
          kind,
          phase: 'cast',
          t: 0,
          casts: 1 + Math.floor(Math.random() * 2),
          prog: 0,
          targetX,
          endX: this.x,
          endY: this.y,
          what: null,
        };
        break;
      }
      case 'cooking': {
        const fireX = clampX(this.x + this.facing * 70, 90);
        // Close enough for his wooden spoon to reach the pot.
        this.x = fireX - this.facing * 42;
        this.act = {
          kind,
          phase: 'stir',
          t: 6 + Math.random() * 5,
          time: 0,
          fireX,
          alpha: 1,
          spawn: 0,
          steam: [],
        };
        break;
      }
      case 'parachute': {
        const poleX = clampX(this.x, 140);
        this.x = poleX;
        const poleH = Math.max(
          120,
          Math.min(wa.height - 180, 240 + Math.random() * 180)
        );
        this.act = {
          kind,
          phase: 'grow',
          t: 0,
          poleX,
          poleH,
          ground,
          grow: 0,
          vy: 0,
          sway: 0,
          poleAlpha: 1,
        };
        break;
      }
      case 'digging': {
        this.act = {
          kind,
          phase: 'dig',
          t: 1.8,
          holeA: { x: this.x, y: this.y },
          holeB: null,
          alpha: 1,
          spawn: 0,
          dirt: [],
          vy: 0,
        };
        break;
      }
    }
  }

  private tickActivity(dt: number): void {
    const a = this.act!;
    switch (a.kind) {
      case 'boxes':
        this.tickBoxes(a, dt);
        break;
      case 'fishing':
        this.tickFishing(a, dt);
        break;
      case 'cooking':
        this.tickCooking(a, dt);
        break;
      case 'parachute':
        this.tickParachute(a, dt);
        break;
      case 'digging':
        this.tickDigging(a, dt);
        break;
    }
  }

  // Box stacking: haul crates into a stack, scramble up the side, sit on
  // top, leap off, and the crates fade away.
  private tickBoxes(a: ActBoxes, dt: number): void {
    const ground = this.groundAt(a.stackX);
    if (ground === null) return this.finishActivity();

    switch (a.phase) {
      case 'carry': {
        this.pose = a.carrying ? 'carry' : 'walk';
        const target = a.carrying ? a.stackX + a.side * 26 : a.fetchX;
        const dir = Math.sign(target - this.x) || 1;
        this.facing = dir;
        this.x += WALK_SPEED * 1.3 * dt * dir;
        this.y = ground;
        if ((target - this.x) * dir <= 0) {
          this.x = target;
          if (a.carrying) {
            a.placed++;
            a.carrying = false;
            if (a.placed >= a.count) {
              a.phase = 'climb';
              a.level = 0;
              a.t = 0;
              a.fromX = this.x;
              a.fromY = this.y;
              this.facing = -a.side; // face the stack
            }
          } else {
            a.carrying = true;
          }
        }
        break;
      }
      case 'climb': {
        this.pose = 'climb';
        a.t += dt / HOP_TIME;
        const k = a.level + 1;
        const last = k === a.count;
        const toX = last ? a.stackX : a.stackX + a.side * 26;
        const toY = ground - BOX * k;
        const p = Math.min(1, a.t);
        this.x = a.fromX + (toX - a.fromX) * p;
        this.y = a.fromY + (toY - a.fromY) * p - Math.sin(p * Math.PI) * 26;
        if (p >= 1) {
          a.level = k;
          a.t = 0;
          a.fromX = toX;
          a.fromY = toY;
          if (last) {
            a.phase = 'sit';
            a.t = 4 + Math.random() * 5;
          }
        }
        break;
      }
      case 'sit': {
        this.pose = 'popcorn'; // snack with a view
        a.t -= dt;
        if (a.t <= 0) {
          a.phase = 'leap';
          const wa = this.workAreaAt(a.stackX);
          const dir =
            wa && a.stackX - wa.x > wa.x + wa.width - a.stackX ? -1 : 1;
          this.facing = dir;
          a.vx = dir * 160;
          a.vy = -320;
        }
        break;
      }
      case 'leap': {
        this.pose = 'held';
        a.vy += GRAVITY * dt;
        this.x += a.vx * dt;
        this.y += a.vy * dt;
        const g = this.groundAt(this.x);
        if (g !== null && a.vy > 0 && this.y >= g) {
          this.y = g;
          a.phase = 'fade';
          a.t = 0.9;
        } else if (g === null) {
          // Leapt clear off the display: hand over to normal falling physics.
          this.cancelActivity();
          this.state = 'falling';
          this.vy = a.vy;
          return;
        }
        break;
      }
      case 'fade': {
        this.pose = 'idle';
        a.alpha -= dt / 0.8;
        if (a.alpha <= 0) return this.finishActivity();
        break;
      }
    }

    for (let i = 0; i < a.placed; i++) {
      this.props.push({
        kind: 'box',
        x: a.stackX,
        y: ground - BOX * i,
        alpha: Math.max(0, a.alpha),
      });
    }
    if (a.carrying) {
      // He hauls it overhead (carry pose has both arms straight up).
      this.props.push({
        kind: 'box',
        x: this.x,
        y: this.y - 88,
        alpha: 1,
      });
    }
  }

  // Fishing: sit with a rod, cast the line out in an arc, wait, reel in a
  // fish (or a boot) and show it off.
  private tickFishing(a: ActFishing, dt: number): void {
    const ground = this.groundAt(this.x);
    if (ground === null) return this.finishActivity();
    this.y = ground;
    this.pose = 'fishsit';

    const handX = this.x + this.facing * 18;
    const handY = this.y - 34;
    const tipX = this.x + this.facing * 42;
    const tipY = this.y - 64;

    switch (a.phase) {
      case 'cast': {
        a.prog = Math.min(1, a.prog + dt / 0.7);
        const p = a.prog;
        a.endX = tipX + (a.targetX - tipX) * p;
        a.endY = tipY + (ground - tipY) * p - Math.sin(p * Math.PI) * 90;
        if (p >= 1) {
          a.phase = 'wait';
          a.t = 3 + Math.random() * 5;
        }
        break;
      }
      case 'wait': {
        a.endX = a.targetX;
        a.endY = ground + Math.sin(Date.now() / 300) * 2;
        a.t -= dt;
        if (a.t <= 0) {
          a.what = Math.random() < 0.6 ? 'fish' : 'boot';
          a.phase = 'reel';
        }
        break;
      }
      case 'reel': {
        a.prog = Math.max(0, a.prog - dt / 0.5);
        const p = a.prog;
        a.endX = tipX + (a.targetX - tipX) * p;
        a.endY = tipY + (ground - tipY) * p - Math.sin(p * Math.PI) * 40;
        if (p <= 0) {
          a.phase = 'show';
          a.t = 1.8;
          this.sayFrom(a.what === 'fish' ? FISH_PHRASES : BOOT_PHRASES);
        }
        break;
      }
      case 'show': {
        this.pose = 'holdup';
        a.t -= dt;
        if (a.t <= 0) {
          a.casts--;
          if (a.casts <= 0) return this.finishActivity();
          a.what = null;
          a.phase = 'cast';
          a.prog = 0;
          const wa = this.workAreaAt(this.x);
          if (wa) {
            a.targetX = Math.max(
              wa.x + 30,
              Math.min(
                wa.x + wa.width - 30,
                this.x + this.facing * (180 + Math.random() * 260)
              )
            );
          }
        }
        break;
      }
    }

    this.props.push({ kind: 'rod', x: handX, y: handY, tipX, tipY });
    if (a.phase !== 'show') {
      // Sagging line from rod tip to the end point (quadratic bezier).
      const sag = a.phase === 'wait' ? 30 : 10;
      const mx = (tipX + a.endX) / 2;
      const my = (tipY + a.endY) / 2 + sag;
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i <= 12; i++) {
        const u = i / 12;
        const v = 1 - u;
        points.push({
          x: v * v * tipX + 2 * v * u * mx + u * u * a.endX,
          y: v * v * tipY + 2 * v * u * my + u * u * a.endY,
        });
      }
      this.props.push({ kind: 'line', points, bobber: a.what === null });
      if (a.what) {
        this.props.push({ kind: 'catch', x: a.endX, y: a.endY, what: a.what });
      }
    } else if (a.what) {
      // Held straight overhead to match the holdup pose.
      this.props.push({
        kind: 'catch',
        x: this.x,
        y: this.y - 102,
        what: a.what,
      });
    }
  }

  // Cooking: stand at a campfire stirring the pot, then sit and eat.
  private tickCooking(a: ActCooking, dt: number): void {
    const ground = this.groundAt(a.fireX);
    if (ground === null) return this.finishActivity();
    this.y = this.groundAt(this.x) ?? ground;
    a.time += dt;

    // Steam puffs rise from the pot and dissolve.
    for (const s of a.steam) {
      s.y += s.vy * dt;
      s.alpha -= dt * 0.5;
    }
    a.steam = a.steam.filter((s) => s.alpha > 0);

    switch (a.phase) {
      case 'stir': {
        this.pose = 'chefstir';
        this.facing = Math.sign(a.fireX - this.x) || 1;
        a.spawn -= dt;
        if (a.spawn <= 0) {
          a.spawn = 0.45;
          a.steam.push({
            x: a.fireX + (Math.random() * 12 - 6),
            y: ground - 50,
            vy: -28 - Math.random() * 14,
            alpha: 0.9,
          });
        }
        a.t -= dt;
        if (a.t <= 0) {
          a.phase = 'eat';
          a.t = 3 + Math.random() * 2;
          this.sayFrom(FOOD_PHRASES);
        }
        break;
      }
      case 'eat': {
        this.pose = 'chefeat';
        a.t -= dt;
        if (a.t <= 0) a.phase = 'fade';
        break;
      }
      case 'fade': {
        this.pose = 'idle';
        a.alpha -= dt / 0.9;
        if (a.alpha <= 0) return this.finishActivity();
        break;
      }
    }

    this.props.push({
      kind: 'campfire',
      x: a.fireX,
      y: ground,
      t: a.time,
      alpha: Math.max(0, a.alpha),
    });
    for (const s of a.steam) {
      this.props.push({
        kind: 'steam',
        x: s.x,
        y: s.y,
        alpha: s.alpha * Math.max(0, a.alpha),
      });
    }
  }

  // Parachute: a flagpole sprouts, he climbs it, perches, leaps, and drifts
  // down under a canopy, swaying — possibly onto a neighboring display.
  private tickParachute(a: ActParachute, dt: number): void {
    const top = a.ground - a.poleH;

    switch (a.phase) {
      case 'grow': {
        this.pose = 'idle';
        a.grow = Math.min(1, a.grow + dt / 0.6);
        if (a.grow >= 1) a.phase = 'climb';
        break;
      }
      case 'climb': {
        this.pose = 'climb';
        this.y -= 95 * dt;
        this.x = a.poleX + Math.sin(this.y / 12) * 2; // little scramble wiggle
        if (this.y <= top) {
          this.y = top;
          this.x = a.poleX;
          a.phase = 'perch';
          a.t = 1.3;
        }
        break;
      }
      case 'perch': {
        this.pose = 'sit';
        a.t -= dt;
        if (a.t <= 0) {
          a.phase = 'jump';
          a.t = 0.35;
          a.vy = -160;
          const wa = this.workAreaAt(a.poleX);
          this.facing =
            wa && a.poleX - wa.x > wa.x + wa.width - a.poleX ? -1 : 1;
        }
        break;
      }
      case 'jump': {
        this.pose = 'held';
        a.vy += GRAVITY * dt;
        this.y += a.vy * dt;
        this.x += this.facing * 70 * dt;
        a.t -= dt;
        if (a.t <= 0) {
          a.phase = 'drift';
          a.sway = 0;
        }
        break;
      }
      case 'drift': {
        this.pose = 'held';
        a.sway += dt;
        a.poleAlpha = Math.max(0, a.poleAlpha - dt / 1.2);
        this.y += CHUTE_FALL * dt;
        const nx =
          this.x + (this.facing * 35 + Math.cos(a.sway * 2) * 55) * dt;
        if (this.groundAt(nx) !== null) this.x = nx; // don't drift into the void
        const g = this.groundAt(this.x);
        if (g !== null && this.y >= g) {
          this.y = g;
          a.phase = 'land';
          a.t = 0.7;
        }
        break;
      }
      case 'land': {
        this.pose = 'cheer'; // stuck the landing
        a.poleAlpha = Math.max(0, a.poleAlpha - dt / 1.2);
        a.t -= dt;
        if (a.t <= 0) return this.finishActivity();
        break;
      }
    }

    if (a.poleAlpha > 0) {
      this.props.push({
        kind: 'pole',
        x: a.poleX,
        y: a.ground,
        height: a.poleH * a.grow,
        alpha: a.poleAlpha,
      });
    }
    if (a.phase === 'drift') {
      this.props.push({
        kind: 'chute',
        x: this.x,
        y: this.y,
        sway: Math.cos(a.sway * 2),
      });
    }
  }

  // Digging: burrow into the ground and pop out of a hole somewhere else —
  // possibly on a different monitor.
  private tickDigging(a: ActDigging, dt: number): void {
    for (const d of a.dirt) {
      d.vy += 1400 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.alpha -= dt * 1.4;
    }
    a.dirt = a.dirt.filter((d) => d.alpha > 0);

    switch (a.phase) {
      case 'dig': {
        this.pose = 'dig';
        a.spawn -= dt;
        if (a.spawn <= 0) {
          a.spawn = 0.07;
          a.dirt.push({
            x: this.x - this.facing * 6,
            y: this.y - 4,
            vx: -this.facing * (40 + Math.random() * 90),
            vy: -(140 + Math.random() * 160),
            alpha: 1,
          });
        }
        a.t -= dt;
        if (a.t <= 0) {
          // Pick an exit hole, favoring somewhere genuinely elsewhere.
          let exit = a.holeA;
          for (let tries = 0; tries < 8; tries++) {
            const d =
              this.displays[Math.floor(Math.random() * this.displays.length)];
            const wa = d.workArea;
            const ex = wa.x + 80 + Math.random() * Math.max(1, wa.width - 160);
            if (Math.abs(ex - a.holeA.x) > 160 || tries === 7) {
              exit = { x: ex, y: wa.y + wa.height };
              break;
            }
          }
          a.holeB = exit;
          this.hidden = true;
          a.phase = 'travel';
          a.t = 1.2 + Math.random() * 1.4;
        }
        break;
      }
      case 'travel': {
        a.t -= dt;
        if (a.t <= 0) {
          this.hidden = false;
          this.x = a.holeB!.x;
          this.y = a.holeB!.y + 8; // pop up from just inside the hole
          a.vy = -480;
          a.phase = 'emerge';
          if (Math.random() < 0.6) this.sayFrom(DIG_PHRASES);
        }
        break;
      }
      case 'emerge': {
        this.pose = 'climb'; // hauling himself out of the hole
        a.vy += GRAVITY * dt;
        this.y += a.vy * dt;
        if (a.vy > 0 && this.y >= a.holeB!.y) {
          this.y = a.holeB!.y;
          a.phase = 'fade';
          a.t = 1;
        }
        break;
      }
      case 'fade': {
        this.pose = 'idle';
        a.alpha -= dt;
        if (a.alpha <= 0) return this.finishActivity();
        break;
      }
    }

    const alpha = Math.max(0, a.alpha);
    this.props.push({ kind: 'mound', x: a.holeA.x, y: a.holeA.y, alpha });
    if (a.holeB) {
      this.props.push({ kind: 'mound', x: a.holeB.x, y: a.holeB.y, alpha });
    }
    for (const d of a.dirt) {
      this.props.push({ kind: 'dirt', x: d.x, y: d.y, alpha: d.alpha });
    }
  }
}
