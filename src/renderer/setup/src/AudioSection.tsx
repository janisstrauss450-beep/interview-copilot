import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioCapture, concatInt16, type CaptureStats } from './audioCapture.js';
import type { AudioDumpResult, AudioMode } from '../../../shared/types.js';

const DUMP_SECONDS = 5;

function dbfsToPct(dbfs: number): number {
  if (dbfs <= -60) return 0;
  if (dbfs >= 0) return 100;
  return ((dbfs + 60) / 60) * 100;
}

export function AudioSection(): JSX.Element {
  const [mode, setMode] = useState<AudioMode>('loopback');
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<CaptureStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [dumping, setDumping] = useState(false);
  const [dumpResult, setDumpResult] = useState<AudioDumpResult | null>(null);
  const dumpFrames = useRef<Int16Array[]>([]);
  const dumpTargetFrames = useRef(0);
  const dumpPromise = useRef<((v: void) => void) | null>(null);

  const captureRef = useRef<AudioCapture | null>(null);

  const handleFrame = useCallback((frame: Int16Array) => {
    if (dumping) {
      dumpFrames.current.push(frame);
      if (dumpFrames.current.length >= dumpTargetFrames.current) {
        dumpPromise.current?.();
      }
    }
    const copy = new ArrayBuffer(frame.byteLength);
    new Uint8Array(copy).set(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
    window.api.transcriptionPushFrame(copy);
  }, [dumping]);

  const handleStats = useCallback((s: CaptureStats) => {
    setStats(s);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const cap = new AudioCapture(handleFrame, handleStats);
      captureRef.current = cap;
      await cap.start(mode);
      const txResult = await window.api.transcriptionStart(cap.sampleRate, mode);
      if (!txResult.ok) {
        setError(`Transcription failed to start: ${txResult.error ?? 'unknown'}`);
      }
      setRunning(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      captureRef.current = null;
    } finally {
      setBusy(false);
    }
  }, [mode, handleFrame, handleStats]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await window.api.transcriptionStop();
      await captureRef.current?.stop();
      captureRef.current = null;
      setRunning(false);
      setStats(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      captureRef.current?.stop().catch(() => {});
    };
  }, []);

  const doDump = useCallback(async () => {
    if (!captureRef.current || !running) return;
    const sampleRate = captureRef.current.sampleRate;
    const framesTarget = Math.ceil((DUMP_SECONDS * sampleRate) / (sampleRate * 0.02));
    dumpFrames.current = [];
    dumpTargetFrames.current = framesTarget;
    setDumpResult(null);
    setDumping(true);
    await new Promise<void>((resolve) => {
      dumpPromise.current = resolve;
    });
    setDumping(false);
    dumpPromise.current = null;
    const pcm = concatInt16(dumpFrames.current);
    dumpFrames.current = [];
    const copy = new ArrayBuffer(pcm.byteLength);
    new Uint8Array(copy).set(pcm);
    const result = await window.api.dumpWav(copy, sampleRate);
    setDumpResult(result);
  }, [running]);

  const dbfsDisplay = stats?.dbfs ?? -60;
  const meterPct = dbfsToPct(dbfsDisplay);

  return (
    <div className="section">
      <div className="section-label">Audio</div>
      <div className="card">
        <div className="radio-row">
          <label className={`radio${mode === 'loopback' ? ' selected' : ''}`}>
            <input
              type="radio"
              name="audio-mode"
              checked={mode === 'loopback'}
              disabled={running}
              onChange={() => setMode('loopback')}
            />
            <span className="radio-label">System audio (loopback, recommended)</span>
          </label>
          <label className={`radio${mode === 'mic' ? ' selected' : ''}`}>
            <input
              type="radio"
              name="audio-mode"
              checked={mode === 'mic'}
              disabled={running}
              onChange={() => setMode('mic')}
            />
            <span className="radio-label">Microphone <span className="dim mono">(picks up your voice)</span></span>
          </label>
        </div>

        <div className="meter-row">
          <div className="meter-bar" aria-label="audio level">
            <div className="meter-fill" style={{ width: `${meterPct}%` }} />
          </div>
          <span className="meter-readout mono">
            {running ? `${dbfsDisplay.toFixed(1)} dBFS` : '— idle —'}
          </span>
          {stats && (
            <span className="mono dim" style={{ marginLeft: 8 }}>
              {stats.sampleRate} Hz
            </span>
          )}
        </div>

        <div className="slot-actions" style={{ marginTop: 14 }}>
          {!running ? (
            <button className="btn btn-primary" onClick={start} disabled={busy}>
              {busy ? 'Starting…' : 'Start listening'}
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={stop} disabled={busy}>
              {busy ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <button
            className="btn"
            onClick={doDump}
            disabled={!running || dumping}
          >
            {dumping ? `Recording ${DUMP_SECONDS}s…` : `Dump ${DUMP_SECONDS}s WAV`}
          </button>
        </div>

        {error && <div className="slot-error">{error}</div>}

        {dumpResult?.ok && dumpResult.path && (
          <div className="dump-result">
            <span className="mono dim">saved</span>{' '}
            <span className="mono">{dumpResult.path}</span>{' '}
            <span className="mono dim">
              ({((dumpResult.bytes ?? 0) / 1024).toFixed(1)} KB · {dumpResult.durationSec?.toFixed(2)}s)
            </span>
            <button
              className="btn btn-ghost btn-tiny"
              style={{ marginLeft: 8 }}
              onClick={() => window.api.revealInFolder(dumpResult.path!)}
            >
              reveal
            </button>
          </div>
        )}
        {dumpResult && !dumpResult.ok && (
          <div className="slot-error">{dumpResult.error}</div>
        )}
      </div>
    </div>
  );
}
