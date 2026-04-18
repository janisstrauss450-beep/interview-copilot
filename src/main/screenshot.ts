import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopCapturer, screen } from 'electron';

const MAX_LONG_EDGE = 2048;

export async function captureFullScreenPng(): Promise<Buffer> {
  const display = screen.getPrimaryDisplay();
  const { width: dispW, height: dispH } = display.size;
  const longer = Math.max(dispW, dispH);
  const scale = longer > MAX_LONG_EDGE ? MAX_LONG_EDGE / longer : 1;
  const thumbW = Math.max(1, Math.round(dispW * scale));
  const thumbH = Math.max(1, Math.round(dispH * scale));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbW, height: thumbH },
  });
  if (!sources || sources.length === 0) {
    throw new Error('No screen sources available. Check Screen Recording permission.');
  }

  // Prefer a source whose display_id matches the primary display, else pick the
  // first with a non-empty thumbnail.
  const primaryId = String(display.id);
  const match =
    sources.find((s) => (s as { display_id?: string }).display_id === primaryId) ??
    sources.find((s) => !s.thumbnail.isEmpty()) ??
    sources[0];

  const png = match.thumbnail.toPNG();
  if (!png || png.length === 0) {
    throw new Error('desktopCapturer returned empty PNG.');
  }
  return png;
}

export async function captureToTempFile(): Promise<string> {
  const dir = join(tmpdir(), 'interview-copilot-screenshots');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `capture-${randomUUID()}.png`);
  const png = await captureFullScreenPng();
  await writeFile(path, png);
  return path;
}

export async function removeTempScreenshot(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best effort
  }
}
