import { useCallback, useEffect, useState } from 'react';
import type {
  SessionSummary,
  SessionTranscript,
  TranscriptQuestionRecord,
} from '../../../shared/types.js';

function fmtDateTime(iso?: string): string {
  if (!iso) return '(ongoing)';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function SessionRow({
  summary,
  active,
  onSelect,
  onReveal,
}: {
  summary: SessionSummary;
  active: boolean;
  onSelect: () => void;
  onReveal: () => void;
}): JSX.Element {
  return (
    <div className={`session-row${active ? ' active' : ''}`}>
      <button className="session-main" onClick={onSelect}>
        <span className="session-date">{fmtDateTime(summary.startedAt)}</span>
        <span className="session-stats mono">
          {fmtDuration(summary.durationSec)} · {summary.questionCount} Q
          {summary.flaggedQuestionCount > 0 && (
            <span className="flagged"> · {summary.flaggedQuestionCount}⚠</span>
          )}
          {summary.avgFirstTokenMs != null && (
            <span className="dim"> · {summary.avgFirstTokenMs}ms avg</span>
          )}
        </span>
      </button>
      <button
        className="btn btn-ghost btn-tiny"
        onClick={onReveal}
        title="Reveal JSON in folder"
      >
        ↗
      </button>
    </div>
  );
}

function QuestionRow({ q }: { q: TranscriptQuestionRecord }): JSX.Element {
  const [open, setOpen] = useState(false);
  const flagged = q.regenCount >= 2;
  const firstTok = q.latencyMs.firstToken != null ? `${q.latencyMs.firstToken}ms` : '—';
  return (
    <div className={`q-row${flagged ? ' flagged' : ''}`}>
      <button className="q-head" onClick={() => setOpen((v) => !v)}>
        <span className="q-chev">{open ? '▾' : '▸'}</span>
        <span className="q-text">{q.questionText}</span>
        <span className="q-meta mono">
          <span className="dim">{fmtDuration(q.tStart)}</span>
          {' · '}
          {firstTok}
          {q.regenCount > 0 && (
            <span className={flagged ? 'flagged' : ''}> · regen ×{q.regenCount}</span>
          )}
          {q.errors && q.errors.length > 0 && <span className="err-chip"> err</span>}
        </span>
      </button>
      {open && (
        <div className="q-body">
          {q.skeleton.length > 0 && (
            <ul className="q-skel">
              {q.skeleton.map((b, i) => (
                <li key={i}>· {b}</li>
              ))}
            </ul>
          )}
          {q.finalAnswer && (
            <div className="q-answer">{q.finalAnswer}</div>
          )}
          {q.errors && q.errors.length > 0 && (
            <div className="slot-error">
              {q.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DebriefSection(): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const list = await window.api.listSessions();
    setSessions(list);
    if (selectedId && !list.find((s) => s.sessionId === selectedId)) {
      setSelectedId(null);
      setTranscript(null);
    }
  }, [selectedId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  const select = useCallback(async (id: string) => {
    setSelectedId(id);
    setLoading(true);
    try {
      const t = await window.api.loadSession(id);
      setTranscript(t);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="section">
      <div className="section-label" style={{ display: 'flex', alignItems: 'center' }}>
        <span>Debrief</span>
        <button
          className="btn btn-ghost btn-tiny"
          onClick={refresh}
          style={{ marginLeft: 'auto' }}
        >
          refresh
        </button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {sessions.length === 0 ? (
          <div className="dim mono" style={{ padding: '16px 20px', fontSize: 11 }}>
            No past sessions. They appear here automatically when you stop listening.
          </div>
        ) : (
          <div className="session-list">
            {sessions.map((s) => (
              <SessionRow
                key={s.sessionId}
                summary={s}
                active={selectedId === s.sessionId}
                onSelect={() => select(s.sessionId)}
                onReveal={() => window.api.revealSession(s.sessionId)}
              />
            ))}
          </div>
        )}
      </div>

      {loading && (
        <div className="dim mono" style={{ padding: '10px 4px', fontSize: 11 }}>
          loading…
        </div>
      )}

      {transcript && (
        <div className="card" style={{ marginTop: 10, padding: '14px 16px' }}>
          <div className="debrief-header">
            <div>
              <div className="debrief-title">{fmtDateTime(transcript.startedAt)}</div>
              <div className="mono dim" style={{ fontSize: 11 }}>
                {transcript.utterances.length} utterances · {transcript.questions.length} questions
                {' · '}
                {transcript.mode}
                {' · '}
                {transcript.sampleRate} Hz
              </div>
            </div>
          </div>
          {transcript.questions.length === 0 ? (
            <div className="dim mono" style={{ fontSize: 11, padding: '10px 0' }}>
              No questions detected in this session.
            </div>
          ) : (
            <div className="q-list">
              {transcript.questions.map((q) => (
                <QuestionRow key={`${q.requestId}-${q.tStart}`} q={q} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
