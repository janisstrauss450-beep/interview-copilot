interface Entry {
  text: string;
  tMs: number;
}

const WINDOW_MS = 3 * 60 * 1000;
const MAX_CHARS = 3000;

const buffer: Entry[] = [];

function prune(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (buffer.length > 0 && buffer[0].tMs < cutoff) buffer.shift();

  let total = 0;
  for (const e of buffer) total += e.text.length + 2;
  while (total > MAX_CHARS && buffer.length > 1) {
    total -= buffer[0].text.length + 2;
    buffer.shift();
  }
}

export function addFinal(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  buffer.push({ text: trimmed, tMs: Date.now() });
  prune();
}

export function snapshot(): string {
  prune();
  if (buffer.length === 0) return '';
  return buffer.map((e) => '- ' + e.text).join('\n');
}

export function resetTranscript(): void {
  buffer.length = 0;
}
