import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { ApiKeyStatus, ApiKeySource, AuthStatus, SetApiKeyResult } from '@shared/types';

const EBAY_SCANNER_CONFIG = join(homedir(), 'ebay-scanner', 'config.py');

// Load .env from the project root on module init so both the Electron main
// path and the smoke-test path see OPENAI_API_KEY. Idempotent — dotenv
// won't override vars that are already set.
(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, '../../.env'),
    resolve(here, '../../../.env'),
    resolve(process.cwd(), '.env'),
  ]) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }
  }
})();

let userDataRoot: string | null = null;
export function setApiKeyUserDataRoot(path: string): void {
  userDataRoot = path;
}

function keychainPath(): string | null {
  if (!userDataRoot) return null;
  return join(userDataRoot, 'credentials', 'openai-key.bin');
}

function bakedKeyPath(): string | null {
  const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!rp) return null;
  return join(rp, 'baked-openai-key.txt');
}

export interface ResolvedApiKey {
  key: string;
  source: ApiKeySource;
  sourcePath?: string;
}

export function maskKey(key: string): string {
  if (key.length <= 12) return '***';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

async function readKeychainKey(): Promise<string | null> {
  try {
    // Lazy-import so this module still loads in non-Electron smoke scripts.
    const { safeStorage } = await import('electron');
    if (!safeStorage.isEncryptionAvailable()) return null;
    const p = keychainPath();
    if (!p || !existsSync(p)) return null;
    const buf = await readFile(p);
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

export async function resolveApiKey(): Promise<ResolvedApiKey | null> {
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey && envKey.length > 20) {
    return { key: envKey, source: 'env:OPENAI_API_KEY' };
  }

  const kc = await readKeychainKey();
  if (kc && kc.startsWith('sk-') && kc.length > 20) {
    const p = keychainPath();
    return { key: kc, source: 'keychain', sourcePath: p ?? undefined };
  }

  const baked = bakedKeyPath();
  if (baked && existsSync(baked)) {
    try {
      const contents = (await readFile(baked, 'utf8')).trim();
      if (contents.startsWith('sk-') && contents.length > 20) {
        return { key: contents, source: 'file:bundled', sourcePath: baked };
      }
    } catch {
      // fall through
    }
  }

  if (existsSync(EBAY_SCANNER_CONFIG)) {
    try {
      const src = await readFile(EBAY_SCANNER_CONFIG, 'utf8');
      const m = src.match(/^\s*OPENAI_API_KEY\s*=\s*["']([^"']+)["']/m);
      if (m && m[1] && m[1].startsWith('sk-') && m[1].length > 20) {
        return { key: m[1], source: 'file:ebay-scanner-config', sourcePath: EBAY_SCANNER_CONFIG };
      }
    } catch {
      // fall through
    }
  }

  return null;
}

export async function getApiKey(): Promise<string | null> {
  const resolved = await resolveApiKey();
  return resolved?.key ?? null;
}

export async function smokeTestApiKey(
  key: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status?: number; modelCount?: number; error?: string }> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, status: res.status, error: body.slice(0, 300) };
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return { ok: true, status: res.status, modelCount: (json.data ?? []).length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function resolveApiKeyStatus(): Promise<ApiKeyStatus> {
  const resolved = await resolveApiKey();
  if (!resolved) {
    return {
      ok: false,
      source: 'none',
      error: 'No OpenAI API key configured. Paste one in the setup window.',
    };
  }
  const smoke = await smokeTestApiKey(resolved.key);
  return {
    ok: smoke.ok,
    source: resolved.source,
    sourcePath: resolved.sourcePath,
    masked: maskKey(resolved.key),
    lastTestedAt: Date.now(),
    modelCount: smoke.modelCount,
    error: smoke.ok ? undefined : `HTTP ${smoke.status ?? '?'} from /v1/models: ${smoke.error}`,
  };
}

export async function resolveAuthStatus(): Promise<AuthStatus> {
  const key = await resolveApiKeyStatus();
  return { key, ok: key.ok };
}

export async function saveApiKeyToKeychain(rawKey: string): Promise<SetApiKeyResult> {
  const key = rawKey.trim();
  if (!key.startsWith('sk-') || key.length < 20) {
    return { ok: false, error: 'Key must start with "sk-" and be longer than 20 characters.' };
  }
  // Validate before saving.
  const smoke = await smokeTestApiKey(key);
  if (!smoke.ok) {
    return {
      ok: false,
      error: `Key rejected by OpenAI (HTTP ${smoke.status ?? '?'}): ${smoke.error ?? 'no detail'}`,
    };
  }
  try {
    const { safeStorage } = await import('electron');
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        error: 'OS-level encryption unavailable on this system — cannot securely store key.',
      };
    }
    const p = keychainPath();
    if (!p) return { ok: false, error: 'User-data path not initialised.' };
    await mkdir(dirname(p), { recursive: true });
    const encrypted = safeStorage.encryptString(key);
    await writeFile(p, encrypted);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to write key: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const status = await resolveApiKeyStatus();
  return { ok: status.ok, status };
}

export async function clearKeychainKey(): Promise<AuthStatus> {
  const p = keychainPath();
  if (p && existsSync(p)) {
    try {
      await unlink(p);
    } catch {
      // best effort
    }
  }
  return resolveAuthStatus();
}
