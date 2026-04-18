export type ApiKeySource =
  | 'env:OPENAI_API_KEY'
  | 'keychain'
  | 'file:bundled'
  | 'file:ebay-scanner-config'
  | 'none';

export interface ApiKeyStatus {
  ok: boolean;
  source: ApiKeySource;
  sourcePath?: string;
  masked?: string;
  lastTestedAt?: number;
  modelCount?: number;
  error?: string;
}

export interface AuthStatus {
  key: ApiKeyStatus;
  ok: boolean;
}

export interface SetApiKeyResult {
  ok: boolean;
  status?: ApiKeyStatus;
  error?: string;
}

export type ContextSlotName = 'essay' | 'bio' | 'source' | 'other';

export interface SlotMeta {
  id: string;
  slot: ContextSlotName;
  originalName: string;
  bytes: number;
  words: number;
  tokens: number;
  preview: string;
  uploadedAt: number;
}

export interface ContextBundle {
  essay: SlotMeta | null;
  bio: SlotMeta | null;
  source: SlotMeta | null;
  other: SlotMeta[];
}

export type UploadOutcome =
  | { ok: true; meta: SlotMeta }
  | { ok: false; error: string }
  | { cancelled: true };

export type AudioMode = 'loopback' | 'mic';

export interface AudioDumpResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  durationSec?: number;
  error?: string;
}

export interface HotkeyBindingInfo {
  id: string;
  label: string;
  accelerator: string;
  description: string;
  registered: boolean;
  error?: string;
}

export interface TranscriptUtteranceRecord {
  id: string;
  tStart: number;
  tEnd: number;
  text: string;
  source: AudioMode;
  isQuestion?: boolean;
  classifierSource?: 'heuristic' | 'llm';
  classifierConfidence?: number;
  classifierReason?: string;
  classifierCategory?: QuestionCategory;
}

export interface TranscriptQuestionRecord {
  utteranceId: string;
  requestId: number;
  questionText: string;
  skeleton: string[];
  finalAnswer: string;
  regenCount: number;
  latencyMs: {
    firstToken: number | null;
    done: number | null;
  };
  tStart: number;
  tEnd: number | null;
  errors?: string[];
}

export interface SessionTranscript {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  sampleRate: number;
  mode: AudioMode;
  utterances: TranscriptUtteranceRecord[];
  questions: TranscriptQuestionRecord[];
}

export interface SessionSummary {
  sessionId: string;
  filename: string;
  path: string;
  startedAt: string;
  endedAt?: string;
  durationSec: number;
  utteranceCount: number;
  questionCount: number;
  flaggedQuestionCount: number;
  avgFirstTokenMs: number | null;
  mode: AudioMode;
}

export interface TranscriptionStatus {
  connected: boolean;
  model?: string;
  error?: string;
}

export type QuestionCategory = 'question_to_candidate' | 'reading_source' | 'other';

export interface ClassificationResult {
  category: QuestionCategory;
  confidence: number;
  source: 'heuristic' | 'llm';
  reason: string;
  rawLlmOutput?: string;
  latencyMs: number;
}

export type TranscriptionEvent =
  | { kind: 'status'; status: TranscriptionStatus }
  | { kind: 'partial'; itemId: string; text: string; tStart: number }
  | { kind: 'final'; itemId: string; text: string; tStart: number; tEnd: number }
  | { kind: 'speechStart'; tStart: number }
  | { kind: 'speechEnd'; tEnd: number }
  | { kind: 'classification'; itemId: string; text: string; result: ClassificationResult }
  | { kind: 'error'; message: string };

export type OverlayEvent =
  | { kind: 'question'; text: string; requestId: number; tStartMs: number }
  | { kind: 'skeleton'; bullets: string[]; requestId: number; firstTokenMs: number }
  | { kind: 'answerToken'; token: string; requestId: number }
  | { kind: 'answerDone'; requestId: number; totalMs: number }
  | { kind: 'error'; requestId: number; stage: 'skeleton' | 'answer'; message: string }
  | { kind: 'reset' }
  | { kind: 'armed'; armed: boolean }
  | { kind: 'protection'; enabled: boolean }
  | { kind: 'toast'; level: 'info' | 'success' | 'error'; message: string };

export interface TranscriptionStartResult {
  ok: boolean;
  error?: string;
}

export interface IpcApi {
  getAuthStatus: () => Promise<AuthStatus>;
  refreshAuth: () => Promise<AuthStatus>;
  setApiKey: (key: string) => Promise<SetApiKeyResult>;
  clearApiKey: () => Promise<AuthStatus>;
  getContext: () => Promise<ContextBundle>;
  uploadToSlot: (slot: Exclude<ContextSlotName, 'other'>) => Promise<UploadOutcome>;
  uploadOther: () => Promise<UploadOutcome>;
  deleteSlot: (slot: ContextSlotName, id?: string) => Promise<ContextBundle>;
  dumpWav: (pcmInt16: ArrayBuffer, sampleRate: number) => Promise<AudioDumpResult>;
  revealInFolder: (path: string) => Promise<void>;

  transcriptionStart: (sampleRate: number, mode?: AudioMode) => Promise<TranscriptionStartResult>;
  transcriptionStop: () => Promise<void>;
  transcriptionGetStatus: () => Promise<TranscriptionStatus>;
  transcriptionPushFrame: (pcm: ArrayBuffer) => void;
  onTranscriptionEvent: (cb: (event: TranscriptionEvent) => void) => () => void;

  onOverlayEvent: (cb: (event: OverlayEvent) => void) => () => void;
  overlayRegenerate: () => void;
  overlayToggleProtection: () => void;
  overlayGetProtection: () => Promise<boolean>;

  getHotkeys: () => Promise<HotkeyBindingInfo[]>;

  listSessions: () => Promise<SessionSummary[]>;
  loadSession: (sessionId: string) => Promise<SessionTranscript | null>;
  revealSession: (sessionId: string) => Promise<void>;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
