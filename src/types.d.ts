// Shared ambient types. This file has no imports/exports on purpose: that
// keeps every declaration global, so the renderer (a plain, non-module
// script) can use them too.

type GremlinState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'sit'
  | 'sleep'
  | 'surprised'
  | 'falling'
  | 'held';

// One simulation frame, broadcast from the main process to every overlay
// window at ~60fps.
interface GremFrame {
  x: number;
  y: number;
  state: GremlinState;
  facing: number; // 1 = right, -1 = left
  say: string | null;
  hover: boolean; // cursor is over the gremlin (computed in main)
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
