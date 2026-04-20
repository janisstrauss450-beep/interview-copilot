import { BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

let setupWindowRef: BrowserWindow | null = null;
let overlayWindowRef: BrowserWindow | null = null;
// CI smoke tests set INTERVIEW_COPILOT_DISABLE_CONTENT_PROTECTION=1 so the
// windows are visible to our own screencapture. Never set this in production.
let protectionEnabled =
  process.env.INTERVIEW_COPILOT_DISABLE_CONTENT_PROTECTION !== '1';

export function getSetupWindow(): BrowserWindow | null {
  return setupWindowRef;
}
export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindowRef;
}

export function toggleOverlayVisibility(): boolean {
  const w = overlayWindowRef;
  if (!w || w.isDestroyed()) return false;
  if (w.isVisible()) {
    w.hide();
    return false;
  }
  w.showInactive();
  return true;
}

export function isOverlayProtected(): boolean {
  return protectionEnabled;
}

function protectedWindows(): BrowserWindow[] {
  return [overlayWindowRef, setupWindowRef].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  );
}

export function setOverlayProtection(enabled: boolean): boolean {
  protectionEnabled = enabled;
  for (const w of protectedWindows()) {
    w.setContentProtection(enabled);
  }
  return protectionEnabled;
}

export function toggleOverlayProtection(): boolean {
  return setOverlayProtection(!protectionEnabled);
}

export function createSetupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 880,
    height: 680,
    show: false,
    autoHideMenuBar: true,
    title: 'Interview Copilot — Setup',
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: join(__dirname, '../preload/setup.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/setup/index.html`);
  } else {
    win.loadFile(join(__dirname, '../renderer/setup/index.html'));
  }

  setupWindowRef = win;
  win.setContentProtection(protectionEnabled);
  win.on('show', () => {
    win.setContentProtection(protectionEnabled);
  });
  win.on('ready-to-show', () => {
    win.setContentProtection(protectionEnabled);
  });
  win.on('closed', () => {
    if (setupWindowRef === win) setupWindowRef = null;
  });
  return win;
}

export function createOverlayWindow(): BrowserWindow {
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1400, Math.max(900, Math.floor(work.width * 0.82)));
  const height = 220;
  const x = Math.max(0, Math.floor((work.width - width) / 2));
  const y = 24;

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 600,
    minHeight: 120,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Interview Copilot',
    focusable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(protectionEnabled);

  // Re-apply on every show — some Windows builds drop the display-affinity flag
  // when the window is hidden and re-shown.
  win.on('show', () => {
    win.setContentProtection(protectionEnabled);
  });

  win.on('ready-to-show', () => {
    win.setContentProtection(protectionEnabled);
    win.showInactive();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`);
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
  }

  overlayWindowRef = win;
  win.on('closed', () => {
    if (overlayWindowRef === win) overlayWindowRef = null;
  });
  return win;
}
