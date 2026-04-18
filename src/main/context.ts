import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { BrowserWindow } from 'electron';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { encode } from 'gpt-tokenizer';
import { getApiKey } from './apiKey.js';
import type {
  ContextBundle,
  ContextSlotName,
  SlotMeta,
  UploadOutcome,
} from '@shared/types';

const TEXT_EXTS = ['.txt', '.md'] as const;
const DOC_EXTS = ['.pdf', '.docx'] as const;
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] as const;
const ACCEPTED_EXT = [...TEXT_EXTS, ...DOC_EXTS, ...IMAGE_EXTS] as const;

let cachedUserDataRoot: string | null = null;

export function setUserDataRoot(path: string): void {
  cachedUserDataRoot = path;
}

function userDataRoot(): string {
  if (cachedUserDataRoot) return cachedUserDataRoot;
  const override = process.env.INTERVIEW_COPILOT_USER_DATA;
  if (override) return override;
  return join(homedir(), '.interview-copilot');
}

function contextRoot(): string {
  return join(userDataRoot(), 'context');
}

function otherRoot(): string {
  return join(contextRoot(), 'other');
}

async function ensureDirs(): Promise<void> {
  await mkdir(otherRoot(), { recursive: true });
}

function singletonTextPath(slot: Exclude<ContextSlotName, 'other'>): string {
  return join(contextRoot(), `${slot}.txt`);
}

function singletonMetaPath(slot: Exclude<ContextSlotName, 'other'>): string {
  return join(contextRoot(), `${slot}.meta.json`);
}

function otherTextPath(id: string): string {
  return join(otherRoot(), `${id}.txt`);
}

function otherMetaPath(id: string): string {
  return join(otherRoot(), `${id}.meta.json`);
}

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function makePreview(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return collapsed.slice(0, limit).trimEnd() + '…';
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

function mimeForImageExt(ext: string): string {
  const normalized = ext.replace(/^\./, '').toLowerCase();
  if (normalized === 'jpg') return 'image/jpeg';
  return `image/${normalized}`;
}

async function extractFromImage(buffer: Buffer, ext: string): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error(
      'No OpenAI API key available for image OCR. Set OPENAI_API_KEY or bundle a key.',
    );
  }
  const b64 = buffer.toString('base64');
  const mime = mimeForImageExt(ext);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Transcribe ALL visible text from this image verbatim. Preserve paragraph breaks and headings. If the image contains code, preserve indentation and characters exactly. If the image contains a task description or prompt from an interviewer, include all of it. Return only the transcribed text — no preamble, no markdown fences, no commentary.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' },
            },
          ],
        },
      ],
      max_tokens: 4000,
      temperature: 0.1,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vision OCR HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content ?? '';
  return text.trim();
}

async function extractFromFile(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const buffer = await readFile(filePath);
  if ((TEXT_EXTS as readonly string[]).includes(ext)) return buffer.toString('utf8');
  if (ext === '.pdf') return extractPdf(buffer);
  if (ext === '.docx') return extractDocx(buffer);
  if ((IMAGE_EXTS as readonly string[]).includes(ext)) return extractFromImage(buffer, ext);
  throw new Error(`Unsupported file type: ${ext}`);
}

function validateExt(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  if (!(ACCEPTED_EXT as readonly string[]).includes(ext)) {
    return `Unsupported file type "${ext}". Accepted: ${ACCEPTED_EXT.join(', ')}`;
  }
  return null;
}

async function buildMeta(
  id: string,
  slot: ContextSlotName,
  filePath: string,
  text: string,
): Promise<SlotMeta> {
  const bytes = (await readFile(filePath)).byteLength;
  const words = countWords(text);
  const tokens = encode(text).length;
  return {
    id,
    slot,
    originalName: basename(filePath),
    bytes,
    words,
    tokens,
    preview: makePreview(text),
    uploadedAt: Date.now(),
  };
}

async function writeSingleton(
  slot: Exclude<ContextSlotName, 'other'>,
  text: string,
  meta: SlotMeta,
): Promise<void> {
  await ensureDirs();
  await writeFile(singletonTextPath(slot), text, 'utf8');
  await writeFile(singletonMetaPath(slot), JSON.stringify(meta, null, 2), 'utf8');
}

async function writeOther(id: string, text: string, meta: SlotMeta): Promise<void> {
  await ensureDirs();
  await writeFile(otherTextPath(id), text, 'utf8');
  await writeFile(otherMetaPath(id), JSON.stringify(meta, null, 2), 'utf8');
}

async function readMetaIfExists(path: string): Promise<SlotMeta | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as SlotMeta;
  } catch {
    return null;
  }
}

export async function getContextBundle(): Promise<ContextBundle> {
  await ensureDirs();
  const essay = await readMetaIfExists(singletonMetaPath('essay'));
  const bio = await readMetaIfExists(singletonMetaPath('bio'));
  const source = await readMetaIfExists(singletonMetaPath('source'));

  const other: SlotMeta[] = [];
  if (existsSync(otherRoot())) {
    const entries = await readdir(otherRoot());
    for (const e of entries) {
      if (!e.endsWith('.meta.json')) continue;
      const meta = await readMetaIfExists(join(otherRoot(), e));
      if (meta) other.push(meta);
    }
    other.sort((a, b) => a.uploadedAt - b.uploadedAt);
  }

  return { essay, bio, source, other };
}

async function pickFile(fromWindow: BrowserWindow | null): Promise<string | null> {
  const { dialog } = await import('electron');
  const opts = {
    title: 'Choose a context document',
    properties: ['openFile'] as const,
    filters: [
      { name: 'Documents', extensions: ['txt', 'md', 'pdf', 'docx'] },
      { name: 'Images (OCR via GPT-4o)', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  // If no parent is passed, call dialog in window-less mode so a minimized
  // setup window doesn't get un-minimized when triggered via hotkey.
  const result = fromWindow
    ? await dialog.showOpenDialog(fromWindow, {
        ...opts,
        properties: [...opts.properties],
      })
    : await dialog.showOpenDialog({
        ...opts,
        properties: [...opts.properties],
      });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

export async function uploadSingleton(
  slot: Exclude<ContextSlotName, 'other'>,
  fromWindow: BrowserWindow | null,
): Promise<UploadOutcome> {
  const filePath = await pickFile(fromWindow);
  if (!filePath) return { cancelled: true };
  return processSingletonPath(slot, filePath);
}

export async function uploadSingletonFromPath(
  slot: Exclude<ContextSlotName, 'other'>,
  filePath: string,
): Promise<UploadOutcome> {
  return processSingletonPath(slot, filePath);
}

async function processSingletonPath(
  slot: Exclude<ContextSlotName, 'other'>,
  filePath: string,
): Promise<UploadOutcome> {
  const extError = validateExt(filePath);
  if (extError) return { ok: false, error: extError };

  try {
    const text = await extractFromFile(filePath);
    if (!text.trim()) {
      return { ok: false, error: 'File contains no extractable text.' };
    }
    const meta = await buildMeta(slot, slot, filePath, text);
    await writeSingleton(slot, text, meta);
    return { ok: true, meta };
  } catch (err) {
    return {
      ok: false,
      error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function uploadOther(fromWindow: BrowserWindow | null): Promise<UploadOutcome> {
  const filePath = await pickFile(fromWindow);
  if (!filePath) return { cancelled: true };

  const extError = validateExt(filePath);
  if (extError) return { ok: false, error: extError };

  try {
    const text = await extractFromFile(filePath);
    if (!text.trim()) {
      return { ok: false, error: 'File contains no extractable text.' };
    }
    const id = randomUUID();
    const meta = await buildMeta(id, 'other', filePath, text);
    await writeOther(id, text, meta);
    return { ok: true, meta };
  } catch (err) {
    return {
      ok: false,
      error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function deleteSlot(slot: ContextSlotName, id?: string): Promise<ContextBundle> {
  if (slot === 'other') {
    if (!id) throw new Error('deleteSlot(other) requires id');
    const txt = otherTextPath(id);
    const meta = otherMetaPath(id);
    if (existsSync(txt)) await unlink(txt);
    if (existsSync(meta)) await unlink(meta);
  } else {
    const txt = singletonTextPath(slot);
    const meta = singletonMetaPath(slot);
    if (existsSync(txt)) await unlink(txt);
    if (existsSync(meta)) await unlink(meta);
  }
  return getContextBundle();
}

export async function readSlotText(
  slot: Exclude<ContextSlotName, 'other'>,
): Promise<string | null> {
  const p = singletonTextPath(slot);
  if (!existsSync(p)) return null;
  return readFile(p, 'utf8');
}

export async function readOtherText(id: string): Promise<string | null> {
  const p = otherTextPath(id);
  if (!existsSync(p)) return null;
  return readFile(p, 'utf8');
}
