import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  screen,
  ipcMain,
  nativeImage,
  shell,
  Display,
} from 'electron';
import * as path from 'path';
import { Brain } from './brain';
import { Chat, listOllamaModels } from './chat';
import { loadSettings, saveSettings } from './settings';

const brain = new Brain();
const chat = new Chat();
const windows = new Map<number, BrowserWindow>(); // display id -> window
let tray: Tray | null = null;
let settingsWin: BrowserWindow | null = null;
// The overlay window the chat bubble is currently open in. While set, that
// window stays interactive + focusable so the user can type.
let chatWin: BrowserWindow | null = null;

// Hover detection lives here, not in the renderer: forwarded mousemove events
// (setIgnoreMouseEvents forward:true) stop arriving on macOS whenever another
// app's window has focus (electron#36372), which made the gremlin unclickable
// as soon as any window was dragged onto his screen. Polling the cursor from
// the main process works regardless of focus.
const SIZE = 96; // must match renderer
const HOVER_PAD = 8;
let interactiveWin: BrowserWindow | null = null;

function updateHover(): boolean {
  const p = screen.getCursorScreenPoint();
  const hover =
    brain.state === 'held' || // never drop interactivity mid-drag
    (p.x >= brain.x - SIZE / 2 - HOVER_PAD &&
      p.x <= brain.x + SIZE / 2 + HOVER_PAD &&
      p.y >= brain.y - SIZE - HOVER_PAD &&
      p.y <= brain.y + HOVER_PAD);

  // While the chat bubble is open its window must stay interactive no matter
  // where the cursor is, so skip the click-through toggling entirely.
  if (chatWin) return hover;

  let target: BrowserWindow | null = null;
  if (hover) {
    const display = screen.getDisplayNearestPoint(p);
    target = windows.get(display.id) || null;
  }
  if (target !== interactiveWin) {
    if (interactiveWin && !interactiveWin.isDestroyed()) {
      interactiveWin.setIgnoreMouseEvents(true, { forward: true });
    }
    if (target && !target.isDestroyed()) {
      target.setIgnoreMouseEvents(false);
    }
    interactiveWin = target;
  }
  return hover;
}

function createWindowForDisplay(display: Display): void {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  // Float above everything, on every Space, including fullscreen apps.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through by default; updateHover() flips this while the cursor is
  // over the gremlin.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { dx: String(x), dy: String(y) },
  });
  windows.set(display.id, win);
}

// --- Chat -------------------------------------------------------------------
// Overlay windows are click-through and non-focusable by default; chatting
// needs both, so we flip them on for the gremlin's window and restore after.
function openChat(win: BrowserWindow): void {
  if (chatWin === win) return;
  if (chatWin) closeChat();
  brain.startChat();
  chatWin = win;
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  // Changing focusability can drop the always-on-top level; re-assert it.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.focus();
  win.webContents.send('chat-open', chat.history);
}

function closeChat(): void {
  if (!chatWin) return;
  const win = chatWin;
  chatWin = null;
  brain.endChat();
  if (!win.isDestroyed()) {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  if (interactiveWin === win) interactiveWin = null;
}

function syncWindows(): void {
  const displays = screen.getAllDisplays();
  const liveIds = new Set(displays.map((d) => d.id));

  for (const [id, win] of windows) {
    if (!liveIds.has(id)) {
      if (win === chatWin) closeChat();
      win.destroy();
      windows.delete(id);
    }
  }
  for (const display of displays) {
    const existing = windows.get(display.id);
    if (existing) {
      existing.setBounds(display.bounds);
    } else {
      createWindowForDisplay(display);
    }
  }
  brain.setDisplays(displays);
}

function createTray(): void {
  let icon = nativeImage.createEmpty();
  try {
    const sheet = nativeImage.createFromPath(
      path.join(__dirname, '..', 'assets', 'gremlin-sheet.png')
    );
    if (!sheet.isEmpty()) {
      const cell = Math.floor(sheet.getSize().width / 4);
      icon = sheet
        .crop({ x: 0, y: 0, width: cell, height: cell })
        .resize({ width: 20, height: 20 });
    }
  } catch (_) {
    // fall through to text-only tray
  }
  tray = new Tray(icon);
  if (icon.isEmpty()) tray.setTitle('grem');
  tray.setToolTip('Gremlin');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Poke gremlin',
        click: () => brain.poke(),
      },
      { label: 'Settings…', click: openSettings },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Gremlin Settings',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  syncWindows();
  screen.on('display-added', syncWindows);
  screen.on('display-removed', syncWindows);
  screen.on('display-metrics-changed', syncWindows);

  createTray();

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const frame: GremFrame = { ...brain.tick(dt), hover: updateHover() };
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('gremlin-frame', frame);
    }
  }, 1000 / 60);
});

ipcMain.on('gremlin-context-menu', (event, { x, y }: { x: number; y: number }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Chat', click: () => openChat(win) },
    brain.state === 'sleep'
      ? { label: 'Wake up', click: () => brain.wake() }
      : { label: 'Sleep here', click: () => brain.sleep() },
  ]);
  menu.popup({ window: win, x: Math.round(x), y: Math.round(y) });
});

ipcMain.on('poke', () => brain.poke());
ipcMain.on('grab', (_e, { x, y }: { x: number; y: number }) => brain.grab(x, y));
ipcMain.on('drag-move', (_e, { x, y }: { x: number; y: number }) =>
  brain.dragMove(x, y)
);
ipcMain.on('release', () => brain.release());

// --- Chat IPC ---------------------------------------------------------------
ipcMain.on('chat-send', async (_e, text: string) => {
  const reply = await chat.send(text);
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send('chat-reply', reply);
  }
});
ipcMain.on('chat-close', () => closeChat());

// --- Settings IPC -----------------------------------------------------------
ipcMain.handle('settings-get', () => loadSettings());
ipcMain.handle('settings-save', (_e, s: GremSettingsData) => saveSettings(s));
ipcMain.handle('ollama-models', (_e, url: string) => listOllamaModels(url));
ipcMain.on('open-external', (_e, url: string) => {
  if (url.startsWith('https://')) shell.openExternal(url);
});

// Keep running with no closable windows; quitting happens via the tray.
app.on('window-all-closed', () => {});
