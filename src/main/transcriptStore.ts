import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AudioMode,
  ClassificationResult,
  SessionSummary,
  SessionTranscript,
  TranscriptQuestionRecord,
  TranscriptUtteranceRecord,
} from '@shared/types';

let userDataRoot: string | null = null;

export function setTranscriptUserDataRoot(path: string): void {
  userDataRoot = path;
}

function transcriptsDir(): string {
  const root = userDataRoot ?? process.cwd();
  return join(root, 'transcripts');
}

async function ensureDir(): Promise<void> {
  await mkdir(transcriptsDir(), { recursive: true });
}

function stampForFile(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

interface ActiveSession {
  data: SessionTranscript;
  startedAtMs: number;
  path: string;
  autosaveTimer: NodeJS.Timeout | null;
}

let active: ActiveSession | null = null;

export function startSession(mode: AudioMode, sampleRate: number): string {
  const sessionId = randomUUID();
  const startedAtMs = Date.now();
  const data: SessionTranscript = {
    sessionId,
    startedAt: new Date(startedAtMs).toISOString(),
    sampleRate,
    mode,
    utterances: [],
    questions: [],
  };
  const path = join(transcriptsDir(), `${stampForFile(new Date(startedAtMs))}.json`);
  const session: ActiveSession = { data, startedAtMs, path, autosaveTimer: null };
  session.autosaveTimer = setInterval(() => {
    void persistActive(session).catch(() => {});
  }, 30_000);
  active = session;
  return sessionId;
}

async function persistActive(session: ActiveSession): Promise<void> {
  await ensureDir();
  await writeFile(session.path, JSON.stringify(session.data, null, 2), 'utf8');
}

export async function endSession(): Promise<string | null> {
  if (!active) return null;
  active.data.endedAt = new Date().toISOString();
  if (active.autosaveTimer) clearInterval(active.autosaveTimer);
  active.autosaveTimer = null;
  const session = active;
  active = null;
  try {
    await persistActive(session);
  } catch {
    return null;
  }
  return session.path;
}

export function addUtterance(record: TranscriptUtteranceRecord): void {
  if (!active) return;
  active.data.utterances.push(record);
}

export function attachClassification(utteranceId: string, result: ClassificationResult): void {
  if (!active) return;
  const u = active.data.utterances.find((x) => x.id === utteranceId);
  if (!u) return;
  u.classifierSource = result.source;
  u.classifierConfidence = result.confidence;
  u.classifierReason = result.reason;
  u.classifierCategory = result.category;
  u.isQuestion = result.category === 'question_to_candidate';
}

export function startQuestion(utteranceId: string, questionText: string, requestId: number, tStartMsRel: number): void {
  if (!active) return;
  const existing = active.data.questions.find((q) => q.questionText === questionText && q.tEnd === null);
  if (existing) {
    existing.regenCount += 1;
    existing.skeleton = [];
    existing.finalAnswer = '';
    existing.latencyMs = { firstToken: null, done: null };
    existing.requestId = requestId;
    return;
  }
  active.data.questions.push({
    utteranceId,
    requestId,
    questionText,
    skeleton: [],
    finalAnswer: '',
    regenCount: 0,
    latencyMs: { firstToken: null, done: null },
    tStart: tStartMsRel,
    tEnd: null,
  });
}

export function attachSkeleton(requestId: number, bullets: string[], firstTokenMs: number): void {
  if (!active) return;
  const q = findQuestion(requestId);
  if (!q) return;
  q.skeleton = bullets;
  q.latencyMs.firstToken = firstTokenMs;
}

export function appendAnswerToken(requestId: number, token: string): void {
  if (!active) return;
  const q = findQuestion(requestId);
  if (!q) return;
  q.finalAnswer += token;
}

export function completeQuestion(requestId: number, totalMs: number): void {
  if (!active) return;
  const q = findQuestion(requestId);
  if (!q) return;
  q.latencyMs.done = totalMs;
  q.tEnd = totalMs;
}

export function attachQuestionError(requestId: number, stage: string, message: string): void {
  if (!active) return;
  const q = findQuestion(requestId);
  if (!q) return;
  q.errors = q.errors ?? [];
  q.errors.push(`${stage}: ${message}`);
}

function findQuestion(requestId: number): TranscriptQuestionRecord | undefined {
  if (!active) return undefined;
  for (let i = active.data.questions.length - 1; i >= 0; i--) {
    if (active.data.questions[i].requestId === requestId) return active.data.questions[i];
  }
  return undefined;
}

export function sessionRelSec(): number {
  if (!active) return 0;
  return (Date.now() - active.startedAtMs) / 1000;
}

export function activeSessionId(): string | null {
  return active?.data.sessionId ?? null;
}

export async function listSessions(): Promise<SessionSummary[]> {
  await ensureDir();
  const dir = transcriptsDir();
  const entries = await readdir(dir);
  const out: SessionSummary[] = [];
  for (const filename of entries) {
    if (!filename.endsWith('.json')) continue;
    const path = join(dir, filename);
    try {
      const raw = await readFile(path, 'utf8');
      const data = JSON.parse(raw) as SessionTranscript;
      const firstTokenLatencies = data.questions
        .map((q) => q.latencyMs.firstToken)
        .filter((x): x is number => typeof x === 'number');
      const avgFirstTokenMs =
        firstTokenLatencies.length > 0
          ? Math.round(firstTokenLatencies.reduce((a, b) => a + b, 0) / firstTokenLatencies.length)
          : null;
      const startedAtMs = Date.parse(data.startedAt);
      const endedAtMs = data.endedAt ? Date.parse(data.endedAt) : Date.now();
      out.push({
        sessionId: data.sessionId,
        filename,
        path,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        durationSec: Math.max(0, (endedAtMs - startedAtMs) / 1000),
        utteranceCount: data.utterances.length,
        questionCount: data.questions.length,
        flaggedQuestionCount: data.questions.filter((q) => q.regenCount >= 2).length,
        avgFirstTokenMs,
        mode: data.mode,
      });
    } catch {
      // skip broken file
    }
  }
  out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return out;
}

export async function loadSession(sessionId: string): Promise<SessionTranscript | null> {
  const all = await listSessions();
  const match = all.find((s) => s.sessionId === sessionId);
  if (!match) return null;
  try {
    const raw = await readFile(match.path, 'utf8');
    return JSON.parse(raw) as SessionTranscript;
  } catch {
    return null;
  }
}

export async function sessionPath(sessionId: string): Promise<string | null> {
  const all = await listSessions();
  return all.find((s) => s.sessionId === sessionId)?.path ?? null;
}
