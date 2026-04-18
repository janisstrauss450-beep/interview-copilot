import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app, desktopCapturer, session, shell, BrowserWindow } from 'electron';
import type { AudioDumpResult } from '@shared/types';

export function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          const screen = sources[0];
          if (!screen) {
            callback({});
            return;
          }
          callback({
            video: screen,
            audio: 'loopback',
          });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
}

function pcmToWav(pcm: Uint8Array, sampleRate: number, numChannels = 1, bitsPerSample = 16): Uint8Array {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.byteLength;
  const totalSize = 44 + dataSize;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  write(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);

  const out = new Uint8Array(totalSize);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export async function dumpWavToDisk(
  pcm: Uint8Array,
  sampleRate: number,
): Promise<AudioDumpResult> {
  try {
    const debugDir = join(app.getPath('userData'), 'debug');
    await mkdir(debugDir, { recursive: true });
    const path = join(debugDir, `audio_${timestamp()}.wav`);
    const wav = pcmToWav(pcm, sampleRate);
    await writeFile(path, wav);
    const samples = pcm.byteLength / 2;
    return {
      ok: true,
      path,
      bytes: wav.byteLength,
      durationSec: samples / sampleRate,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function revealInFolder(path: string): Promise<void> {
  shell.showItemInFolder(path);
}

export function ensureContentProtection(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.setContentProtection(true);
  }
}
