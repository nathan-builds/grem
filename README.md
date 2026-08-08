# grem

A little pixel-art gremlin that lives on your desktop. He wanders across all
your monitors, idles, sits, naps, and reacts when you click him. Everything
except the gremlin himself is click-through, so he never gets in your way.

## Run

```bash
npm install
npm start
```

Quit from the gremlin icon in the macOS menu bar.

## Interactions

- **Click him** — he gets startled and says something in a speech bubble
  (this is the seam where AI chat will plug in later).
- **Drag him** — pick him up, he dangles, and falls to the ground when dropped.
- **Menu bar icon** — poke him remotely, or quit.

## How it works

The app is written in TypeScript; `npm start` compiles `src/` to `dist/`
(via `tsc`) and launches Electron.

- `src/main.ts` — one transparent, frameless, always-on-top overlay window per
  display (rebuilt when displays are added/removed). Windows are click-through
  by default; the main process polls the cursor each tick and flips
  interactivity on only while the cursor is over the gremlin. Runs the 60fps
  tick loop and the tray.
- `src/brain.ts` — the behavior state machine (walk / run / idle / sit /
  sleep / surprised / held / falling), simulated in global screen coordinates
  so he can roam between monitors and fall onto lower screens.
- `src/renderer/gremlin.ts` — canvas rendering with nearest-neighbor scaling,
  sprite-sheet animation, chroma-keying of the sheet background, per-frame
  content alignment, click/drag handling, and the speech bubble. Compiled as
  a plain script (own `tsconfig.renderer.json`), loaded via a `<script>` tag.
- `src/types.d.ts` — shared ambient types (frame payload, preload API).
- `assets/gremlin-sheet.png` — 4x4 sprite sheet (rows: idle, walk, run, and
  sit / sleep / held / surprised).
