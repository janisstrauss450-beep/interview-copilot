import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

interface CaptureCallbacks {
  onFrame: (pcm: Uint8Array) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onStderr: (line: string) => void;
}

interface CaptureHandle {
  stop: () => Promise<void>;
  pid: number;
}

function helperPath(): string | null {
  // Production: inside .app/Contents/Resources
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    const bundled = join(resourcesPath, 'audiotap-mac');
    if (existsSync(bundled)) return bundled;
  }
  // Dev fallback: compiled in place
  const devBuilt = join(app.getAppPath(), 'native', 'mac', '.build', 'release', 'audiotap');
  if (existsSync(devBuilt)) return devBuilt;
  // Dev fallback: manually placed
  const resources = join(app.getAppPath(), 'resources', 'audiotap-mac');
  if (existsSync(resources)) return resources;
  return null;
}

export function isHelperAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  return helperPath() !== null;
}

export function startHelper(cb: CaptureCallbacks): CaptureHandle | null {
  if (process.platform !== 'darwin') return null;
  const path = helperPath();
  if (!path) {
    console.warn('[macAudioCapture] audiotap binary not found — mic fallback only');
    return null;
  }

  let child: ChildProcess;
  try {
    child = spawn(path, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('[macAudioCapture] spawn failed:', err);
    return null;
  }

  const bytesPerFrame = 320 * 2; // 20 ms @ 24 kHz * 2 bytes
  let carryBytes: Uint8Array = new Uint8Array(0);

  child.stdout?.on('data', (chunk: Uint8Array) => {
    // Coalesce incoming bytes into 20 ms frames before handing to the
    // transcription pipeline, which expects frame-aligned PCM.
    if (carryBytes.length > 0) {
      const merged = new Uint8Array(carryBytes.length + chunk.length);
      merged.set(carryBytes, 0);
      merged.set(chunk, carryBytes.length);
      carryBytes = merged;
    } else {
      carryBytes = chunk;
    }
    while (carryBytes.length >= bytesPerFrame) {
      const copy = new Uint8Array(bytesPerFrame);
      copy.set(carryBytes.subarray(0, bytesPerFrame));
      carryBytes = carryBytes.subarray(bytesPerFrame);
      cb.onFrame(copy);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) cb.onStderr(line);
    }
  });

  child.on('exit', (code, signal) => {
    console.warn(`[macAudioCapture] helper exited code=${code} signal=${signal}`);
    cb.onExit(code, signal);
  });

  child.on('error', (err) => {
    console.error('[macAudioCapture] child error:', err);
  });

  return {
    pid: child.pid ?? -1,
    stop: async () => {
      if (child.killed) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      // Give it a beat; if it doesn't die, SIGKILL.
      await new Promise((r) => setTimeout(r, 500));
      if (!child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    },
  };
}
