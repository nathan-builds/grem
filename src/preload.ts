import { contextBridge, ipcRenderer } from 'electron';

const api: GremApi = {
  onFrame: (cb) =>
    ipcRenderer.on('gremlin-frame', (_e, frame: GremFrame) => cb(frame)),
  poke: () => ipcRenderer.send('poke'),
  grab: (x, y) => ipcRenderer.send('grab', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('drag-move', { x, y }),
  release: () => ipcRenderer.send('release'),
  contextMenu: (x, y) => ipcRenderer.send('gremlin-context-menu', { x, y }),
  chatSend: (text) => ipcRenderer.send('chat-send', text),
  chatClose: () => ipcRenderer.send('chat-close'),
  onChatOpen: (cb) =>
    ipcRenderer.on('chat-open', (_e, history: ChatMessage[]) => cb(history)),
  onChatReply: (cb) =>
    ipcRenderer.on('chat-reply', (_e, text: string) => cb(text)),
};

const settingsApi: GremSettingsApi = {
  getSettings: () => ipcRenderer.invoke('settings-get'),
  saveSettings: (s) => ipcRenderer.invoke('settings-save', s),
  listOllamaModels: (url) => ipcRenderer.invoke('ollama-models', url),
  openExternal: (url) => ipcRenderer.send('open-external', url),
};

contextBridge.exposeInMainWorld('grem', api);
contextBridge.exposeInMainWorld('gremSettings', settingsApi);
