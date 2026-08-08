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

  setDisplays(displays: BrainDisplay[]): void {
    this.displays = displays.map((d) => ({ id: d.id, workArea: d.workArea }));
    if (!this.spawned && this.displays.length) {
      const wa = this.displays[0].workArea;
      this.x = wa.x + wa.width / 2;
      this.y = wa.y + wa.height;
      this.spawned = true;
    } else if (this.spawned && !this.groundAt(this.x)) {
      // The display he was on disappeared; respawn on the first one.
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

  pickNextAction(): void {
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

  // Chat mode: sit still so the chat bubble stays anchored, and keep quiet
  // (no random phrases) until the conversation ends.
  startChat(): void {
    this.chatting = true;
    this.say = null;
    const ground = this.groundAt(this.x);
    if (ground !== null) this.y = ground;
    this.vy = 0;
    this.state = 'sit';
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
    this.state = 'surprised';
    this.stateTime = SURPRISED_TIME;
    const text = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    this.say = { text, until: Date.now() + 2500 };
  }

  grab(x: number, y: number): void {
    if (this.chatting) return; // he's busy talking
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
    }

    return {
      x: this.x,
      y: this.y,
      state: this.state,
      facing: this.facing,
      say: this.say ? this.say.text : null,
    };
  }
}
