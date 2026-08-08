// Shared ambient types. This file has no imports/exports on purpose: that
// keeps every declaration global, so the renderer (a plain, non-module
// script) can use them too.

// Scripted multi-phase activities the gremlin occasionally performs.
type GremActivity = 'boxes' | 'fishing' | 'cooking' | 'parachute' | 'digging';

type GremlinState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'sit'
  | 'sleep'
  | 'surprised'
  | 'falling'
  | 'held'
  | 'chatting'
  | GremActivity;

// Which sprite-sheet animation the renderer should show, decoupled from the
// logical state. The second group lives on the actions sheet
// (gremlin-actions.png) and falls back to base poses if that sheet is
// missing.
type GremlinPose =
  | 'idle'
  | 'walk'
  | 'run'
  | 'sit'
  | 'sleep'
  | 'surprised'
  | 'falling'
  | 'held'
  | 'carry' // hauling a crate overhead
  | 'climb' // scrambling up boxes / the flagpole / out of a hole
  | 'dig' // crouched, scrabbling at the ground
  | 'stir' // working the pot with a wooden spoon
  | 'fishsit' // sitting holding the rod
  | 'cheer' // arms up, triumphant
  | 'eat' // sitting with a bowl
  | 'holdup' // holding a prize overhead
  | 'chefstir' // stirring, in chef hat and apron
  | 'chefeat' // eating, in chef hat and apron
  | 'popcorn'; // sitting munching from a popcorn bag

// Props are drawn procedurally by every overlay window. All coordinates are
// global screen coordinates; y is the bottom / ground anchor of the prop.
type GremProp =
  | { kind: 'box'; x: number; y: number; alpha: number }
  | { kind: 'pole'; x: number; y: number; height: number; alpha: number }
  | { kind: 'chute'; x: number; y: number; sway: number } // x,y = gremlin feet
  | { kind: 'rod'; x: number; y: number; tipX: number; tipY: number }
  | { kind: 'line'; points: { x: number; y: number }[]; bobber: boolean }
  | { kind: 'catch'; x: number; y: number; what: 'fish' | 'boot' }
  | { kind: 'campfire'; x: number; y: number; t: number; alpha: number }
  | { kind: 'steam'; x: number; y: number; alpha: number }
  | { kind: 'mound'; x: number; y: number; alpha: number }
  | { kind: 'dirt'; x: number; y: number; alpha: number };

// One simulation frame, broadcast from the main process to every overlay
// window at ~60fps.
interface GremFrame {
  x: number;
  y: number;
  state: GremlinState;
  pose: GremlinPose; // sprite animation to render
  facing: number; // 1 = right, -1 = left
  say: string | null;
  hover: boolean; // cursor is over the gremlin (computed in main)
  hidden: boolean; // true while underground mid-dig; skip drawing him
  props: GremProp[];
}

// One message in the gremlin chat (session-only, kept in the main process).
interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

// Chat provider configuration, edited in the settings window.
interface GremSettingsData {
  provider: 'claude' | 'ollama';
  claudeApiKey: string;
  ollamaUrl: string;
  ollamaModel: string;
  // Which random activities he's allowed to do (all on by default).
  activities: Record<GremActivity, boolean>;
}

// The API exposed to the renderer by preload.ts.
interface GremApi {
  onFrame(cb: (frame: GremFrame) => void): void;
  poke(): void;
  grab(x: number, y: number): void;
  dragMove(x: number, y: number): void;
  release(): void;
  contextMenu(x: number, y: number): void;
  chatSend(text: string): void;
  chatClose(): void;
  onChatOpen(cb: (history: ChatMessage[]) => void): void;
  onChatReply(cb: (text: string) => void): void;
  timerSet(seconds: number): void;
  timerPromptClose(): void;
  onTimerPrompt(cb: () => void): void;
  onConfetti(cb: (origin: { x: number; y: number }) => void): void;
}

// Exposed to the settings window by the same preload script.
interface GremSettingsApi {
  getSettings(): Promise<GremSettingsData>;
  saveSettings(s: GremSettingsData): Promise<void>;
  listOllamaModels(
    url: string
  ): Promise<{ ok: boolean; models: string[]; error?: string }>;
  openExternal(url: string): void;
}

interface Window {
  grem: GremApi;
  gremSettings: GremSettingsApi;
}
