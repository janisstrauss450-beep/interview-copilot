import { BrowserWindow } from 'electron';
import { callChatCompletion, callChatCompletionStream } from './openaiClient.js';
import { buildAnswerInstructions, buildSkeletonInstructions, formatUserInput } from './promptBuilder.js';
import { snapshot as transcriptSnapshot } from './rollingTranscript.js';
import {
  startQuestion as storeStartQuestion,
  attachSkeleton as storeAttachSkeleton,
  appendAnswerToken as storeAppendToken,
  completeQuestion as storeCompleteQuestion,
  attachQuestionError as storeAttachError,
  sessionRelSec,
} from './transcriptStore.js';
import type { OverlayEvent } from '@shared/types';

// Prefer the newest / highest-quality model your account has access to.
// Each list is tried in order; first one accepted by OpenAI is used.
// gpt-5 (bare) is skipped — it's a reasoning model that eats output budget on
// internal reasoning tokens and often returns empty under tight caps.
const ANSWER_MODELS = ['gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-4.1', 'gpt-4o'];
const SKELETON_MODELS = ['gpt-5.4-mini', 'gpt-5.1-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];

let currentRequestId = 0;
let currentController: AbortController | null = null;
let lastQuestion = '';
let lastUtteranceId: string | null = null;
let lastFullAnswer = '';
const answerBuffers = new Map<number, string>();

function emit(event: OverlayEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('overlay:event', event);
    }
  }
}

function parseBullets(output: string): string[] {
  const cleaned = output
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*$/g, '')
    .trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  const jsonStr = match ? match[0] : cleaned;
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, 5);
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).bullets)) {
      return (parsed as any).bullets
        .filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0)
        .slice(0, 5);
    }
  } catch {
    // fall through to line-split fallback
  }
  return cleaned
    .split('\n')
    .map((line) => line.replace(/^[\s\-*·•]+|^\d+[\.\)]\s*/g, '').trim())
    .filter((line) => line.length > 0 && line.length < 120)
    .slice(0, 5);
}

async function generateSkeletonWith(
  userInput: string,
  requestId: number,
  controller: AbortController,
  tStartMs: number,
): Promise<void> {
  try {
    const system = await buildSkeletonInstructions();
    if (controller.signal.aborted) return;
    const output = await callChatCompletion({
      model: SKELETON_MODELS,
      system,
      user: userInput + '\n\nRespond with JSON of this shape: {"bullets": ["…", "…"]}',
      temperature: 0.2,
      maxTokens: 200,
      responseFormat: 'json_object',
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    const bullets = parseBullets(output);
    const firstTokenMs = Date.now() - tStartMs;
    if (bullets.length === 0) {
      const message = `skeleton parse failed; raw="${output.slice(0, 120)}"`;
      storeAttachError(requestId, 'skeleton', message);
      emit({ kind: 'error', requestId, stage: 'skeleton', message });
      return;
    }
    storeAttachSkeleton(requestId, bullets, firstTokenMs);
    emit({ kind: 'skeleton', bullets, requestId, firstTokenMs });
  } catch (err) {
    if (controller.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    storeAttachError(requestId, 'skeleton', message);
    emit({ kind: 'error', requestId, stage: 'skeleton', message });
  }
}

async function generateAnswerWith(
  userInput: string,
  requestId: number,
  controller: AbortController,
  tStartMs: number,
): Promise<void> {
  try {
    const system = await buildAnswerInstructions();
    if (controller.signal.aborted) return;
    answerBuffers.set(requestId, '');
    const stream = callChatCompletionStream({
      model: ANSWER_MODELS,
      system,
      user: userInput,
      temperature: 0.6,
      maxTokens: 600,
      signal: controller.signal,
    });
    for await (const token of stream) {
      if (controller.signal.aborted) return;
      const prev = answerBuffers.get(requestId) ?? '';
      answerBuffers.set(requestId, prev + token);
      storeAppendToken(requestId, token);
      emit({ kind: 'answerToken', token, requestId });
    }
    if (controller.signal.aborted) return;
    const totalMs = Date.now() - tStartMs;
    lastFullAnswer = answerBuffers.get(requestId) ?? '';
    answerBuffers.delete(requestId);
    storeCompleteQuestion(requestId, totalMs);
    emit({ kind: 'answerDone', requestId, totalMs });
  } catch (err) {
    if (controller.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    storeAttachError(requestId, 'answer', message);
    emit({ kind: 'error', requestId, stage: 'answer', message });
  }
}

export function handleQuestion(
  questionText: string,
  preSnapshotTranscript?: string,
  utteranceId?: string,
): void {
  handleQuestionInternal(questionText, preSnapshotTranscript, false, undefined, utteranceId);
}

function handleQuestionInternal(
  questionText: string,
  preSnapshotTranscript: string | undefined,
  force: boolean,
  userInputOverride?: string,
  utteranceId?: string,
): void {
  const text = questionText.trim();
  if (!text) return;
  if (!force && text === lastQuestion) return;
  lastQuestion = text;
  if (utteranceId !== undefined) lastUtteranceId = utteranceId;

  if (currentController) currentController.abort();
  const requestId = ++currentRequestId;
  const controller = new AbortController();
  currentController = controller;
  const tStartMs = Date.now();
  const transcript = preSnapshotTranscript ?? transcriptSnapshot();

  emit({ kind: 'question', text, requestId, tStartMs });
  storeStartQuestion(lastUtteranceId ?? 'unknown', text, requestId, sessionRelSec());

  const userInput = userInputOverride ?? formatUserInput(text, transcript);
  void generateSkeletonWith(userInput, requestId, controller, tStartMs);
  void generateAnswerWith(userInput, requestId, controller, tStartMs);
}

export function regenerate(): void {
  if (!lastQuestion) return;
  const q = lastQuestion;
  lastQuestion = '';
  if (currentController) currentController.abort();
  emit({ kind: 'reset' });
  handleQuestionInternal(q, undefined, true);
}

export function requestShorter(): void {
  rewriteFromLastAnswer('shorter');
}

export function requestLonger(): void {
  rewriteFromLastAnswer('longer');
}

function rewriteFromLastAnswer(mode: 'shorter' | 'longer'): void {
  const q = lastQuestion;
  if (!q) return;

  let prev = '';
  for (const v of answerBuffers.values()) {
    if (v.length > prev.length) prev = v;
  }
  if (!prev) prev = lastFullAnswer;

  const transcript = transcriptSnapshot();
  if (currentController) currentController.abort();
  emit({ kind: 'reset' });

  const userInput = prev
    ? formatRewriteInput(q, transcript, prev, mode)
    : formatUserInput(q, transcript) +
      '\n\n' +
      (mode === 'shorter'
        ? 'IMPORTANT: Produce a tighter answer — target about 20 seconds of speech, roughly half of a normal answer. Be terse.'
        : 'IMPORTANT: Produce a longer answer with one more concrete specific drawn from the essay or bio.');

  handleQuestionInternal(q, transcript, true, userInput);
}

function formatRewriteInput(
  question: string,
  transcript: string,
  previousAnswer: string,
  mode: 'shorter' | 'longer',
): string {
  const directive =
    mode === 'shorter'
      ? 'REWRITE this answer at roughly HALF the length. Target about 20 seconds of speech — 2 short sentences, maybe 3. Cut filler, tighten sentences, drop any generic preamble. Keep the same claims and the same voice. Do NOT introduce new facts.'
      : 'REWRITE this answer LONGER. Add one more concrete specific drawn from the essay or bio (a detail, a moment, an example). Keep the same opening. Target about 45-60 seconds of speech. Do NOT invent any facts not already in the essay/bio/source.';

  return [
    `Question: "${question.trim()}"`,
    '',
    'Previous answer you produced:',
    '"""',
    previousAnswer.trim(),
    '"""',
    '',
    directive,
    '',
    transcript ? `Recent interviewer context (last ~3 min):\n${transcript}\n` : '',
    'Output only the rewritten spoken answer. No preamble, no markdown, no meta-commentary.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function resetAnswer(): void {
  if (currentController) currentController.abort();
  currentController = null;
  lastQuestion = '';
  emit({ kind: 'reset' });
}

export function setArmed(armed: boolean): void {
  emit({ kind: 'armed', armed });
}
