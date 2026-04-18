import WebSocket from 'ws';
import { BrowserWindow } from 'electron';
import { getApiKey } from './apiKey.js';
import { classifyUtterance } from './classifier.js';
import { handleQuestion, setArmed } from './answerService.js';
import { addFinal as addTranscriptFinal, snapshot as transcriptSnapshot } from './rollingTranscript.js';
import {
  startSession as startTranscriptSession,
  endSession as endTranscriptSession,
  addUtterance as storeAddUtterance,
  attachClassification as storeAttachClassification,
} from './transcriptStore.js';
import { startHelper as startMacHelper, isHelperAvailable } from './macAudioCapture.js';
import type {
  AudioMode,
  OverlayEvent,
  TranscriptionEvent,
  TranscriptionStatus,
  TranscriptionStartResult,
} from '@shared/types';

const MODEL = 'gpt-4o-mini-transcribe';
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000];

type State =
  | { phase: 'idle' }
  | { phase: 'connecting'; ws: WebSocket; sampleRate: number }
  | { phase: 'ready'; ws: WebSocket; sampleRate: number; sessionStartedAtMs: number }
  | { phase: 'reconnecting'; sampleRate: number; attempts: number; timer: NodeJS.Timeout };

let state: State = { phase: 'idle' };
let currentAudioMode: AudioMode = 'loopback';

// Listening intent — true once the user has started a session, false only on
// explicit stop. Independent of the actual WebSocket state so we know whether
// to reconnect when the socket drops unexpectedly.
let listeningIntent = false;
let macHelperHandle: { stop: () => Promise<void>; pid: number } | null = null;

export function setAudioMode(mode: AudioMode): void {
  currentAudioMode = mode;
}

export function canUseMacSystemAudio(): boolean {
  return process.platform === 'darwin' && isHelperAvailable();
}

function startMacSystemAudioIfNeeded(): void {
  if (macHelperHandle) return;
  if (process.platform !== 'darwin') return;
  if (currentAudioMode !== 'loopback') return;
  const handle = startMacHelper({
    onFrame: (buf) => {
      pushFrame(buf);
    },
    onExit: (code, signal) => {
      macHelperHandle = null;
      if (listeningIntent) {
        emit({
          kind: 'error',
          message: `mac audio helper exited (code=${code} signal=${signal}) — switch to Microphone mode or stop+restart listening`,
        });
      }
    },
    onStderr: (line) => {
      console.log(`[audiotap] ${line}`);
    },
  });
  macHelperHandle = handle;
}

async function stopMacSystemAudioIfRunning(): Promise<void> {
  if (!macHelperHandle) return;
  const h = macHelperHandle;
  macHelperHandle = null;
  await h.stop();
}

function emit(event: TranscriptionEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('transcription:event', event);
  }
}

function toast(level: 'info' | 'success' | 'error', message: string): void {
  const event: OverlayEvent = { kind: 'toast', level, message };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('overlay:event', event);
  }
}

export function getStatus(): TranscriptionStatus {
  if (state.phase === 'ready') return { connected: true, model: MODEL };
  if (state.phase === 'connecting' || state.phase === 'reconnecting') {
    return { connected: false, model: MODEL };
  }
  return { connected: false };
}

function nowRelSec(startMs: number): number {
  return (Date.now() - startMs) / 1000;
}

function handleServerEvent(raw: string, sessionStartedAtMs: number): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const t = msg?.type as string | undefined;
  if (!t) return;

  if (t === 'error') {
    const message = msg.error?.message ?? JSON.stringify(msg.error ?? msg);
    emit({ kind: 'error', message });
    return;
  }

  if (t === 'input_audio_buffer.speech_started') {
    emit({ kind: 'speechStart', tStart: nowRelSec(sessionStartedAtMs) });
    return;
  }

  if (t === 'input_audio_buffer.speech_stopped') {
    emit({ kind: 'speechEnd', tEnd: nowRelSec(sessionStartedAtMs) });
    return;
  }

  if (t === 'conversation.item.input_audio_transcription.delta') {
    const itemId = msg.item_id ?? msg.id ?? 'unknown';
    const delta = msg.delta ?? msg.transcript ?? '';
    if (delta) {
      emit({ kind: 'partial', itemId, text: delta, tStart: nowRelSec(sessionStartedAtMs) });
    }
    return;
  }

  if (t === 'conversation.item.input_audio_transcription.completed') {
    const itemId = msg.item_id ?? msg.id ?? 'unknown';
    const text = (msg.transcript ?? '').trim();
    emit({
      kind: 'final',
      itemId,
      text,
      tStart: nowRelSec(sessionStartedAtMs),
      tEnd: nowRelSec(sessionStartedAtMs),
    });
    if (text) {
      const transcriptBefore = transcriptSnapshot();
      addTranscriptFinal(text);
      const tRelSec =
        state.phase === 'ready'
          ? (Date.now() - state.sessionStartedAtMs) / 1000
          : 0;
      storeAddUtterance({
        id: itemId,
        tStart: tRelSec,
        tEnd: tRelSec,
        text,
        source: currentAudioMode,
      });
      classifyUtterance(text)
        .then((result) => {
          emit({ kind: 'classification', itemId, text, result });
          storeAttachClassification(itemId, result);
          if (result.category === 'question_to_candidate') {
            handleQuestion(text, transcriptBefore, itemId);
          }
        })
        .catch((err) => {
          emit({
            kind: 'error',
            message: `classifier: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    }
    return;
  }

  if (t === 'conversation.item.input_audio_transcription.failed') {
    const message = msg.error?.message ?? 'transcription failed';
    emit({ kind: 'error', message });
    return;
  }
}

interface OpenResult {
  ok: boolean;
  error?: string;
}

/**
 * Open a WebSocket + configure the transcription session. Caller decides what
 * to do on failure (initial startup vs reconnect flow).
 */
async function openOnce(sampleRate: number): Promise<OpenResult> {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: 'No OpenAI API key available.' };

  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    ws.binaryType = 'arraybuffer';
    state = { phase: 'connecting', ws, sampleRate };

    ws.on('open', () => {
      const config = {
        type: 'transcription_session.update',
        session: {
          input_audio_format: 'pcm16',
          input_audio_transcription: {
            model: MODEL,
            language: 'en',
            prompt:
              'This is a university admissions interview in English. Topics include economics, business, leadership, entrepreneurship, essays, university applications, student council, start-ups, SSE Riga, Stockholm, Riga, iFund, Peak Time, Agenskalns gymnasium. Occasional Latvian or Russian proper nouns may appear; transcribe them phonetically when heard.',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
          },
          input_audio_noise_reduction: { type: 'near_field' },
        },
      };
      ws.send(JSON.stringify(config));
      const sessionStartedAtMs = Date.now();
      state = { phase: 'ready', ws, sampleRate, sessionStartedAtMs };
      emit({ kind: 'status', status: { connected: true, model: MODEL } });
      if (!settled) {
        settled = true;
        resolve({ ok: true });
      }
    });

    ws.on('message', (data) => {
      if (state.phase !== 'ready') return;
      const text = typeof data === 'string' ? data : data.toString('utf8');
      handleServerEvent(text, state.sessionStartedAtMs);
    });

    ws.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[transcription] ws error:', message);
      emit({ kind: 'error', message });
      emit({ kind: 'status', status: { connected: false, error: message } });
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: message });
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString('utf8') || '';
      console.warn(`[transcription] ws close code=${code} reason=${reasonStr || '(none)'}`);

      // If we were in ready/connecting AND intent is still listening, kick off
      // a reconnect. If the user stopped (intent=false), just settle into idle.
      const wasActive = state.phase === 'ready' || state.phase === 'connecting';
      state = { phase: 'idle' };
      emit({ kind: 'status', status: { connected: false } });

      if (wasActive && listeningIntent && code !== 1000) {
        scheduleReconnect(sampleRate, 0);
      } else if (wasActive && listeningIntent && code === 1000) {
        // Normal-closure but user still wants to listen — Realtime API session
        // timeouts close with 1000 after 15 min. Reconnect anyway.
        scheduleReconnect(sampleRate, 0);
      }
    });
  });
}

function scheduleReconnect(sampleRate: number, attempt: number): void {
  if (!listeningIntent) return;
  if (attempt >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[transcription] gave up after', attempt, 'reconnect attempts');
    setArmed(false);
    toast('error', 'transcription disconnected. stop + restart listening to retry.');
    emit({
      kind: 'error',
      message: `Transcription disconnected after ${attempt} reconnect attempts. Stop and restart listening.`,
    });
    listeningIntent = false;
    return;
  }

  const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  console.warn(`[transcription] reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
  if (attempt === 0) toast('info', 'transcription disconnected — reconnecting…');

  const timer = setTimeout(async () => {
    if (!listeningIntent) return;
    const result = await openOnce(sampleRate);
    if (result.ok) {
      console.log('[transcription] reconnected on attempt', attempt + 1);
      toast('success', 'transcription reconnected');
    } else {
      scheduleReconnect(sampleRate, attempt + 1);
    }
  }, delay);

  state = { phase: 'reconnecting', sampleRate, attempts: attempt + 1, timer };
}

export async function startTranscription(sampleRate: number): Promise<TranscriptionStartResult> {
  if (state.phase !== 'idle') {
    await stopTranscription();
  }
  listeningIntent = true;
  const result = await openOnce(sampleRate);
  if (result.ok) {
    startTranscriptSession(currentAudioMode, sampleRate);
    setArmed(true);
    // On macOS, system-audio capture happens in a native helper process
    // spawned from main — the renderer's getDisplayMedia path doesn't
    // produce loopback audio on mac. Start the helper if available and
    // the user picked loopback mode.
    startMacSystemAudioIfNeeded();
    return { ok: true };
  }
  listeningIntent = false;
  return { ok: false, error: result.error };
}

export async function stopTranscription(): Promise<void> {
  listeningIntent = false;
  await stopMacSystemAudioIfRunning();

  if (state.phase === 'reconnecting') {
    clearTimeout(state.timer);
    state = { phase: 'idle' };
    emit({ kind: 'status', status: { connected: false } });
    await endTranscriptSession();
    setArmed(false);
    return;
  }

  if (state.phase === 'idle') return;

  const { ws } = state;
  state = { phase: 'idle' };
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'client stop');
    }
  } catch {
    // ignore
  }
  await endTranscriptSession();
  emit({ kind: 'status', status: { connected: false } });
  setArmed(false);
}

export function pushFrame(pcm: ArrayBuffer | Uint8Array): void {
  if (state.phase !== 'ready') return;
  const buf =
    pcm instanceof Uint8Array ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : Buffer.from(pcm);
  const b64 = buf.toString('base64');
  try {
    state.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
  } catch {
    // WS likely closing; the close event will trigger reconnect.
  }
}
