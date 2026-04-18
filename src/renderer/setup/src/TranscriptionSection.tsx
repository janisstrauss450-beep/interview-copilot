import { useEffect, useRef, useState } from 'react';
import type {
  ClassificationResult,
  TranscriptionEvent,
  TranscriptionStatus,
} from '../../../shared/types.js';

interface UtteranceRow {
  id: string;
  text: string;
  isFinal: boolean;
  tStart: number;
  tEnd?: number;
  updatedAt: number;
  classification?: ClassificationResult;
}

const MAX_ROWS = 80;

function ClassBadge({ result }: { result: ClassificationResult }): JSX.Element {
  const { category, confidence, source, reason, latencyMs } = result;
  const label =
    category === 'question_to_candidate'
      ? 'Q'
      : category === 'reading_source'
        ? 'R'
        : '·';
  const title =
    `${category} · conf ${confidence.toFixed(2)} · ${source} (${latencyMs}ms)\n${reason}`;
  return (
    <span className={`cls-badge cls-badge-${category}`} title={title}>
      {label}
      <span className="cls-badge-src">{source === 'llm' ? 'llm' : 'h'}</span>
    </span>
  );
}

export function TranscriptionSection(): JSX.Element {
  const [status, setStatus] = useState<TranscriptionStatus>({ connected: false });
  const [rows, setRows] = useState<UtteranceRow[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const partialBufRef = useRef<Record<string, string>>({});

  useEffect(() => {
    window.api.transcriptionGetStatus().then(setStatus).catch(() => {});
    const unsub = window.api.onTranscriptionEvent((event: TranscriptionEvent) => {
      switch (event.kind) {
        case 'status':
          setStatus(event.status);
          break;
        case 'speechStart':
          setSpeaking(true);
          break;
        case 'speechEnd':
          setSpeaking(false);
          break;
        case 'partial': {
          const current = (partialBufRef.current[event.itemId] ?? '') + event.text;
          partialBufRef.current[event.itemId] = current;
          setRows((prev) => {
            const next = [...prev];
            const idx = next.findIndex((r) => r.id === event.itemId && !r.isFinal);
            if (idx >= 0) {
              next[idx] = { ...next[idx], text: current, updatedAt: Date.now() };
            } else {
              next.push({
                id: event.itemId,
                text: current,
                isFinal: false,
                tStart: event.tStart,
                updatedAt: Date.now(),
              });
            }
            return next.slice(-MAX_ROWS);
          });
          break;
        }
        case 'final': {
          const finalText = event.text || partialBufRef.current[event.itemId] || '';
          delete partialBufRef.current[event.itemId];
          setRows((prev) => {
            const next = [...prev];
            const idx = next.findIndex((r) => r.id === event.itemId && !r.isFinal);
            if (idx >= 0) {
              next[idx] = {
                ...next[idx],
                text: finalText,
                isFinal: true,
                tEnd: event.tEnd,
                updatedAt: Date.now(),
              };
            } else {
              next.push({
                id: event.itemId,
                text: finalText,
                isFinal: true,
                tStart: event.tStart,
                tEnd: event.tEnd,
                updatedAt: Date.now(),
              });
            }
            return next.slice(-MAX_ROWS);
          });
          break;
        }
        case 'classification': {
          setRows((prev) => {
            const next = [...prev];
            const idx = next.findIndex((r) => r.id === event.itemId);
            if (idx >= 0) {
              next[idx] = { ...next[idx], classification: event.result };
            }
            return next;
          });
          break;
        }
        case 'error':
          setErrors((e) => [...e, event.message].slice(-5));
          break;
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [rows.length]);

  const dot = status.connected ? 'ok' : status.error ? 'bad' : 'neutral';

  return (
    <div className="section">
      <div className="section-label" style={{ display: 'flex', alignItems: 'center' }}>
        <span>Transcription (debug)</span>
        <span
          className="mono muted"
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <span className={`dot ${dot}`} style={{ width: 7, height: 7 }} />
          {status.connected ? status.model : 'disconnected'}
          {speaking && <span className="speaking-pill">speaking</span>}
        </span>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="transcript-log" ref={logRef}>
          {rows.length === 0 && (
            <div className="dim mono" style={{ padding: '20px 22px', fontSize: 11 }}>
              Start listening, then speak into the system audio source. Partial captions
              appear in italics, finals settle below in plain text.
            </div>
          )}
          {rows.map((r, i) => (
            <div
              key={`${r.id}-${i}`}
              className={`transcript-row${r.isFinal ? ' final' : ' partial'}${
                r.classification ? ` cls-${r.classification.category}` : ''
              }`}
            >
              <span className="mono dim transcript-time">
                {r.tStart.toFixed(1).padStart(5, ' ')}s
              </span>
              <div className="transcript-main">
                <span className="transcript-text">{r.text}</span>
                {r.classification && <ClassBadge result={r.classification} />}
              </div>
            </div>
          ))}
        </div>
        {errors.length > 0 && (
          <div className="slot-error" style={{ margin: '0 18px 14px' }}>
            {errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
