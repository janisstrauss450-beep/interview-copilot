import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AudioDumpResult,
  AuthStatus,
  ContextBundle,
  ContextSlotName,
  HotkeyBindingInfo,
  IpcApi,
  OverlayEvent,
  SessionSummary,
  SessionTranscript,
  TranscriptionEvent,
  TranscriptionStartResult,
  TranscriptionStatus,
  UploadOutcome,
} from '../shared/types.js';

const api: IpcApi = {
  getAuthStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
  refreshAuth: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:refresh'),
  setApiKey: (key: string) => ipcRenderer.invoke('auth:setKey', key),
  clearApiKey: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:clearKey'),
  getContext: (): Promise<ContextBundle> => ipcRenderer.invoke('context:get'),
  uploadToSlot: (slot): Promise<UploadOutcome> =>
    ipcRenderer.invoke('context:uploadSingleton', slot),
  uploadOther: (): Promise<UploadOutcome> => ipcRenderer.invoke('context:uploadOther'),
  deleteSlot: (slot: ContextSlotName, id?: string): Promise<ContextBundle> =>
    ipcRenderer.invoke('context:delete', slot, id),
  dumpWav: (pcm: ArrayBuffer, sampleRate: number): Promise<AudioDumpResult> =>
    ipcRenderer.invoke('audio:dumpWav', pcm, sampleRate),
  revealInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('audio:reveal', path),

  transcriptionStart: (sampleRate: number, mode): Promise<TranscriptionStartResult> =>
    ipcRenderer.invoke('transcription:start', sampleRate, mode),
  transcriptionStop: (): Promise<void> => ipcRenderer.invoke('transcription:stop'),
  transcriptionGetStatus: (): Promise<TranscriptionStatus> =>
    ipcRenderer.invoke('transcription:status'),
  transcriptionPushFrame: (pcm: ArrayBuffer): void => {
    ipcRenderer.send('transcription:pushFrame', pcm);
  },
  onTranscriptionEvent: (cb: (event: TranscriptionEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: TranscriptionEvent) => cb(payload);
    ipcRenderer.on('transcription:event', handler);
    return () => ipcRenderer.removeListener('transcription:event', handler);
  },

  onOverlayEvent: (cb: (event: OverlayEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: OverlayEvent) => cb(payload);
    ipcRenderer.on('overlay:event', handler);
    return () => ipcRenderer.removeListener('overlay:event', handler);
  },
  overlayRegenerate: (): void => {
    ipcRenderer.send('overlay:regenerate');
  },
  overlayToggleProtection: (): void => {
    ipcRenderer.send('overlay:toggleProtection');
  },
  overlayGetProtection: (): Promise<boolean> =>
    ipcRenderer.invoke('overlay:getProtection'),

  getHotkeys: (): Promise<HotkeyBindingInfo[]> => ipcRenderer.invoke('hotkeys:get'),

  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke('transcripts:list'),
  loadSession: (sessionId: string): Promise<SessionTranscript | null> =>
    ipcRenderer.invoke('transcripts:load', sessionId),
  revealSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('transcripts:reveal', sessionId),
};

contextBridge.exposeInMainWorld('api', api);
