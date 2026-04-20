import { config as loadDotenv } from 'dotenv';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// Load .env from repo root (dev) or cwd (built app) before anything else
// touches process.env.
const __here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  resolvePath(__here, '../../.env'),
  resolvePath(__here, '../.env'),
  resolvePath(process.cwd(), '.env'),
]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate });
    break;
  }
}

import { app, ipcMain, BrowserWindow } from 'electron';
import { createSetupWindow, createOverlayWindow } from './windows.js';
import {
  resolveAuthStatus,
  saveApiKeyToKeychain,
  clearKeychainKey,
  setApiKeyUserDataRoot,
} from './apiKey.js';
import {
  getContextBundle,
  uploadSingleton,
  uploadSingletonFromPath,
  uploadOther,
  deleteSlot,
  setUserDataRoot,
} from './context.js';
import { captureToTempFile, removeTempScreenshot } from './screenshot.js';
import type { OverlayEvent } from '@shared/types';
import {
  setTranscriptUserDataRoot,
  listSessions as listTranscriptSessions,
  loadSession as loadTranscriptSession,
  sessionPath as transcriptSessionPath,
} from './transcriptStore.js';
import { shell } from 'electron';
import { installDisplayMediaHandler, dumpWavToDisk, revealInFolder } from './audio.js';
import {
  startTranscription,
  stopTranscription,
  pushFrame,
  getStatus as getTranscriptionStatus,
  setAudioMode,
} from './transcription.js';
import {
  regenerate as regenerateAnswer,
  requestShorter,
  requestLonger,
} from './answerService.js';
import { registerHotkeys, unregisterHotkeys, getBindings } from './hotkeys.js';
import {
  getOverlayWindow,
  toggleOverlayVisibility,
  toggleOverlayProtection,
  isOverlayProtected,
} from './windows.js';
import type { ContextSlotName } from '@shared/types';

let transcriptionMuted = false;

function broadcastProtection(enabled: boolean): void {
  broadcastOverlayEvent({ kind: 'protection', enabled });
}

function broadcastOverlayEvent(event: OverlayEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('overlay:event', event);
    }
  }
}

async function quickUploadSource(): Promise<void> {
  broadcastOverlayEvent({
    kind: 'toast',
    level: 'info',
    message: 'pick source file (text, pdf, or screenshot)…',
  });
  try {
    const outcome = await uploadSingleton('source', null);
    if ('ok' in outcome && outcome.ok) {
      broadcastOverlayEvent({
        kind: 'toast',
        level: 'success',
        message: `source: ${outcome.meta.words.toLocaleString()} words, ${outcome.meta.tokens.toLocaleString()} tokens`,
      });
    } else if ('cancelled' in outcome) {
      broadcastOverlayEvent({
        kind: 'toast',
        level: 'info',
        message: 'upload cancelled',
      });
    } else {
      broadcastOverlayEvent({
        kind: 'toast',
        level: 'error',
        message: `upload failed: ${outcome.error}`,
      });
    }
  } catch (err) {
    broadcastOverlayEvent({
      kind: 'toast',
      level: 'error',
      message: `upload failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function instantScreenshotSource(): Promise<void> {
  broadcastOverlayEvent({
    kind: 'toast',
    level: 'info',
    message: 'capturing screen…',
  });
  let tmpPath: string | null = null;
  try {
    tmpPath = await captureToTempFile();
    broadcastOverlayEvent({
      kind: 'toast',
      level: 'info',
      message: 'analysing with gpt-4o vision…',
    });
    const outcome = await uploadSingletonFromPath('source', tmpPath);
    if ('ok' in outcome && outcome.ok) {
      broadcastOverlayEvent({
        kind: 'toast',
        level: 'success',
        message: `source: ${outcome.meta.words.toLocaleString()} words from screen`,
      });
    } else if ('cancelled' in outcome) {
      broadcastOverlayEvent({
        kind: 'toast',
        level: 'info',
        message: 'screenshot cancelled',
      });
    } else {
      broadcastOverlayEvent({
        kind: 'toast',
        level: 'error',
        message: `screenshot OCR failed: ${outcome.error}`,
      });
    }
  } catch (err) {
    broadcastOverlayEvent({
      kind: 'toast',
      level: 'error',
      message: `screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    if (tmpPath) await removeTempScreenshot(tmpPath);
  }
}

let setupWin: BrowserWindow | null = null;

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function wireIpc() {
  ipcMain.handle('auth:status', async () => resolveAuthStatus());
  ipcMain.handle('auth:refresh', async () => resolveAuthStatus());
  ipcMain.handle('auth:setKey', async (_e, key: string) => saveApiKeyToKeychain(key));
  ipcMain.handle('auth:clearKey', async () => clearKeychainKey());

  ipcMain.handle('context:get', async () => getContextBundle());
  ipcMain.handle('context:uploadSingleton', async (event, slot: Exclude<ContextSlotName, 'other'>) => {
    return uploadSingleton(slot, senderWindow(event) ?? setupWin);
  });
  ipcMain.handle('context:uploadOther', async (event) => {
    return uploadOther(senderWindow(event) ?? setupWin);
  });
  ipcMain.handle('context:delete', async (_event, slot: ContextSlotName, id?: string) => {
    return deleteSlot(slot, id);
  });

  ipcMain.handle('audio:dumpWav', async (_event, pcm: ArrayBuffer, sampleRate: number) => {
    return dumpWavToDisk(new Uint8Array(pcm), sampleRate);
  });
  ipcMain.handle('audio:reveal', async (_event, path: string) => {
    await revealInFolder(path);
  });

  ipcMain.handle('transcription:start', async (_event, sampleRate: number, mode?: 'loopback' | 'mic') => {
    if (mode) setAudioMode(mode);
    return startTranscription(sampleRate);
  });
  ipcMain.handle('transcription:stop', async () => {
    await stopTranscription();
  });
  ipcMain.handle('transcription:status', async () => getTranscriptionStatus());
  ipcMain.on('transcription:pushFrame', (_event, pcm: ArrayBuffer) => {
    if (transcriptionMuted) return;
    pushFrame(pcm);
  });

  ipcMain.on('overlay:regenerate', () => {
    regenerateAnswer();
  });

  ipcMain.on('overlay:toggleProtection', () => {
    broadcastProtection(toggleOverlayProtection());
  });
  ipcMain.handle('overlay:getProtection', async () => isOverlayProtected());

  ipcMain.handle('hotkeys:get', async () => getBindings());

  ipcMain.handle('transcripts:list', async () => listTranscriptSessions());
  ipcMain.handle('transcripts:load', async (_e, sessionId: string) =>
    loadTranscriptSession(sessionId),
  );
  ipcMain.handle('transcripts:reveal', async (_e, sessionId: string) => {
    const p = await transcriptSessionPath(sessionId);
    if (p) shell.showItemInFolder(p);
  });
}

function toggleTranscriptionMute(): void {
  transcriptionMuted = !transcriptionMuted;
}

export function isTranscriptionMuted(): boolean {
  return transcriptionMuted;
}

function registerDefaultHotkeys() {
  registerHotkeys([
    {
      id: 'regenerate',
      label: 'Regenerate',
      accelerator: 'CommandOrControl+Shift+R',
      description: 'Re-draft the current answer from scratch.',
      action: () => regenerateAnswer(),
    },
    {
      id: 'shorter',
      label: 'Shorter',
      accelerator: 'CommandOrControl+Shift+S',
      description: 'Rewrite at roughly half the length.',
      action: () => requestShorter(),
    },
    {
      id: 'longer',
      label: 'Longer',
      accelerator: 'CommandOrControl+Shift+L',
      description: 'Expand with one more specific from the essay.',
      action: () => requestLonger(),
    },
    {
      id: 'hide',
      label: 'Hide overlay',
      accelerator: 'CommandOrControl+Shift+H',
      description: 'Toggle the overlay window visibility.',
      action: () => {
        toggleOverlayVisibility();
      },
    },
    {
      id: 'mute',
      label: 'Mute listening',
      accelerator: 'CommandOrControl+Shift+P',
      description: 'Pause audio capture + transcription (P not M to avoid Zoom mute-self conflict).',
      action: () => toggleTranscriptionMute(),
    },
    {
      id: 'visibility',
      label: 'Screen-share hiding',
      accelerator: 'CommandOrControl+Shift+V',
      description: 'Toggle whether the overlay is hidden from screen share.',
      action: () => {
        broadcastProtection(toggleOverlayProtection());
      },
    },
    {
      id: 'upload-source',
      label: 'Upload source',
      accelerator: 'CommandOrControl+Shift+U',
      description: 'Pick a file or screenshot as source material without opening the setup window.',
      action: () => {
        void quickUploadSource();
      },
    },
    {
      id: 'instant-screenshot',
      label: 'Instant-OCR screenshot',
      accelerator: 'CommandOrControl+Shift+I',
      description: 'Capture the primary screen, OCR it via GPT-4o, and store it as source.',
      action: () => {
        void instantScreenshotSource();
      },
    },
  ]);
}

function openAllWindows() {
  setupWin = createSetupWindow();
  createOverlayWindow();
}

app.whenReady().then(() => {
  app.setName('Interview Copilot');
  const userData = app.getPath('userData');
  setUserDataRoot(userData);
  setTranscriptUserDataRoot(userData);
  setApiKeyUserDataRoot(userData);
  wireIpc();
  installDisplayMediaHandler();
  openAllWindows();
  registerDefaultHotkeys();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openAllWindows();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


let quitInProgress = false;
app.on('before-quit', (event) => {
  if (quitInProgress) return;
  quitInProgress = true;
  event.preventDefault();
  (async () => {
    try {
      await stopTranscription();
    } catch {
      // best effort
    }
    unregisterHotkeys();
    app.exit(0);
  })();
});

void getOverlayWindow; // referenced by hotkey action above
