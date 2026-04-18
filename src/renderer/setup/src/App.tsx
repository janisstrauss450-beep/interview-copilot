import { useCallback, useEffect, useState } from 'react';
import type {
  ApiKeyStatus,
  AuthStatus,
  OverlayEvent,
  SetApiKeyResult,
} from '../../../shared/types.js';
import { ContextSection } from './ContextSection.js';
import { AudioSection } from './AudioSection.js';
import { TranscriptionSection } from './TranscriptionSection.js';
import { HotkeysSection } from './HotkeysSection.js';
import { DebriefSection } from './DebriefSection.js';

const FIRST_RUN_SOURCES_OK = new Set<ApiKeyStatus['source']>([
  'env:OPENAI_API_KEY',
  'keychain',
  'file:bundled',
  'file:ebay-scanner-config',
]);

function formatLastTested(ms?: number): string {
  if (!ms) return '(never)';
  const delta = Math.floor((Date.now() - ms) / 1000);
  if (delta < 2) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

function SourceBadge({ source }: { source: ApiKeyStatus['source'] }): JSX.Element {
  const label =
    source === 'env:OPENAI_API_KEY'
      ? 'env var'
      : source === 'keychain'
        ? 'keychain (encrypted)'
        : source === 'file:bundled'
          ? 'bundled with installer'
          : source === 'file:ebay-scanner-config'
            ? 'ebay-scanner/config.py (legacy)'
            : 'none';
  return <span className="src-badge mono">{label}</span>;
}

function KeyCard({ status, onRefresh }: { status: AuthStatus; onRefresh: () => Promise<void> }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const save = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result: SetApiKeyResult = await window.api.setApiKey(draft.trim());
      if (result.ok) {
        setEditing(false);
        setDraft('');
        await onRefresh();
      } else {
        setError(result.error ?? 'Unknown error');
      }
    } finally {
      setSubmitting(false);
    }
  }, [draft, onRefresh]);

  const clear = useCallback(async () => {
    await window.api.clearApiKey();
    await onRefresh();
  }, [onRefresh]);

  const test = useCallback(async () => {
    setTesting(true);
    try {
      await onRefresh();
    } finally {
      setTesting(false);
    }
  }, [onRefresh]);

  const key = status.key;
  const dot = key.ok ? 'ok' : 'bad';

  return (
    <div className="card">
      <div className="chip-row">
        <span className={`dot ${dot}`} />
        <span className="chip-label">OpenAI API key</span>
        <span className="mono muted" style={{ marginLeft: 'auto' }}>
          answers · transcription · vision · classifier
        </span>
      </div>
      <div className="kv">
        <div className="k">source</div>
        <div className="v">
          <SourceBadge source={key.source} />
          {key.sourcePath && <span className="mono dim" style={{ marginLeft: 8 }}>{key.sourcePath}</span>}
        </div>
        {key.masked && (
          <>
            <div className="k">key</div>
            <div className="v mono">{key.masked}</div>
          </>
        )}
        {key.modelCount != null && (
          <>
            <div className="k">models</div>
            <div className="v mono">{key.modelCount} accessible</div>
          </>
        )}
        <div className="k">last tested</div>
        <div className="v mono">{formatLastTested(key.lastTestedAt)}</div>
        {key.error && (
          <>
            <div className="k">error</div>
            <div className="v error">{key.error}</div>
          </>
        )}
      </div>

      {editing ? (
        <div className="key-edit">
          <input
            className="key-input mono"
            type="password"
            autoFocus
            value={draft}
            placeholder="sk-proj-…"
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting) save();
              if (e.key === 'Escape') {
                setEditing(false);
                setDraft('');
                setError(null);
              }
            }}
          />
          <div className="slot-actions" style={{ marginTop: 10 }}>
            <button className="btn" onClick={save} disabled={submitting || draft.trim().length < 20}>
              {submitting ? 'Validating + saving…' : 'Save (Enter)'}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setEditing(false);
                setDraft('');
                setError(null);
              }}
              disabled={submitting}
            >
              Cancel (Esc)
            </button>
          </div>
          {error && <div className="slot-error" style={{ marginTop: 10 }}>{error}</div>}
          <div className="m1-note" style={{ marginTop: 10 }}>
            Your key is validated against <span className="mono">/v1/models</span> before being
            stored, then encrypted with your OS keychain (DPAPI on Windows, Keychain on macOS).
            Only the encrypted ciphertext touches disk.
          </div>
        </div>
      ) : (
        <div className="slot-actions" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => setEditing(true)}>
            {key.ok ? 'Change key' : 'Paste key'}
          </button>
          <button className="btn btn-ghost" onClick={test} disabled={testing}>
            {testing ? 'Re-testing…' : 'Re-test'}
          </button>
          {key.source === 'keychain' && (
            <button className="btn btn-ghost" onClick={clear}>
              Clear stored key
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FirstRunModal({ onSaved }: { onSaved: () => Promise<void> }): JSX.Element {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result: SetApiKeyResult = await window.api.setApiKey(draft.trim());
      if (result.ok) {
        setDraft('');
        await onSaved();
      } else {
        setError(result.error ?? 'Unknown error');
      }
    } finally {
      setSubmitting(false);
    }
  }, [draft, onSaved]);

  return (
    <div className="first-run-backdrop">
      <div className="first-run-card">
        <h2 className="first-run-title">Welcome to Interview Copilot</h2>
        <p className="first-run-lede">
          Paste your OpenAI API key to get started. Your key is validated, then encrypted with your
          OS keychain — it never touches disk in plaintext.
        </p>
        <p className="first-run-lede dim">
          Don't have one?{' '}
          <span className="mono">platform.openai.com/api-keys</span> — create a key, turn on
          free-tier data-sharing if you're comfortable with it, and most personal use stays at $0.
        </p>
        <input
          className="key-input key-input-big mono"
          type="password"
          autoFocus
          value={draft}
          placeholder="sk-proj-…"
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !submitting && draft.trim().length >= 20) save();
          }}
        />
        <div className="slot-actions" style={{ marginTop: 14 }}>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={submitting || draft.trim().length < 20}
          >
            {submitting ? 'Validating…' : 'Save and continue'}
          </button>
        </div>
        {error && <div className="slot-error" style={{ marginTop: 12 }}>{error}</div>}
      </div>
    </div>
  );
}

function ProtectionBanner(): JSX.Element {
  const [shielded, setShielded] = useState(true);

  useEffect(() => {
    window.api.overlayGetProtection().then(setShielded).catch(() => {});
    const unsub = window.api.onOverlayEvent((event: OverlayEvent) => {
      if (event.kind === 'protection') setShielded(event.enabled);
    });
    return () => unsub();
  }, []);

  return (
    <div
      className={`protect-banner ${shielded ? 'shield-on' : 'shield-off'}`}
      onClick={() => window.api.overlayToggleProtection()}
      title="⌘⇧V or click to toggle"
    >
      <span className="protect-icon">{shielded ? '◉' : '◎'}</span>
      <span className="protect-text">
        {shielded ? (
          <>
            <strong>Hidden from screen share.</strong> Both this window and the overlay are
            excluded from Zoom / Meet / Teams capture. <span className="mono dim">⌘⇧V to toggle</span>
          </>
        ) : (
          <>
            <strong>VISIBLE on screen share.</strong> Both windows will appear if you share
            your screen. <span className="mono dim">⌘⇧V to hide</span>
          </>
        )}
      </span>
    </div>
  );
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  const refresh = useCallback(async () => {
    const next = await window.api.refreshAuth();
    setStatus(next);
  }, []);

  useEffect(() => {
    window.api
      .getAuthStatus()
      .then(setStatus)
      .catch((err) => {
        setStatus({
          key: { ok: false, source: 'none', error: String(err) },
          ok: false,
        });
      });
  }, []);

  const loading = status == null;
  const needsFirstRun =
    !loading &&
    !status!.ok &&
    status!.key.source === 'none';

  return (
    <>
      {needsFirstRun && <FirstRunModal onSaved={refresh} />}

      <div className="wrap">
        <h1 className="app-title">Interview Copilot</h1>
        <p className="app-subtitle">
          Upload your essay. Start listening. When the interviewer asks a question, a grounded
          answer streams onto the overlay.
        </p>

        <ProtectionBanner />

        <div className="section">
          <div className="section-label">Auth</div>
          {loading ? (
            <div className="card muted" style={{ fontStyle: 'italic' }}>
              Checking credentials…
            </div>
          ) : (
            <KeyCard status={status!} onRefresh={refresh} />
          )}
          <div className="m1-note">
            One key powers everything: answer generation (gpt-4o), skeleton + classifier (gpt-4o-mini),
            transcription (gpt-4o-mini-transcribe via Realtime API), screenshot OCR (gpt-4o vision).
          </div>
        </div>

        <ContextSection />

        <AudioSection />

        <TranscriptionSection />

        <HotkeysSection />

        <DebriefSection />

        <footer className="app-footer mono">
          Interview Copilot · OpenAI · <span className="dim">everything local except inference calls</span>
        </footer>
      </div>
    </>
  );
}

void FIRST_RUN_SOURCES_OK;
