import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { encode } from 'gpt-tokenizer';

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

async function extract(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const buffer = await readFile(filePath);
  if (ext === '.txt' || ext === '.md') return buffer.toString('utf8');
  if (ext === '.pdf') return extractPdf(buffer);
  if (ext === '.docx') return extractDocx(buffer);
  throw new Error(`Unsupported file type: ${ext}`);
}

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function preview(text: string, n = 180): string {
  const c = text.replace(/\s+/g, ' ').trim();
  return c.length <= n ? c : c.slice(0, n).trimEnd() + '…';
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: pnpm smoke:extract <path-to-file>');
    process.exit(2);
  }
  console.log(`file:    ${basename(path)}`);
  console.log(`path:    ${path}`);
  const t0 = Date.now();
  const text = await extract(path);
  const ms = Date.now() - t0;
  const words = countWords(text);
  const tokens = encode(text).length;
  console.log(`bytes:   ${(await readFile(path)).byteLength.toLocaleString()}`);
  console.log(`chars:   ${text.length.toLocaleString()}`);
  console.log(`words:   ${words.toLocaleString()}`);
  console.log(`tokens:  ${tokens.toLocaleString()}`);
  console.log(`time:    ${ms} ms`);
  console.log(`preview: ${preview(text)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
