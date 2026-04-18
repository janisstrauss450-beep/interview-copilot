import { useCallback, useEffect, useState } from 'react';
import type {
  ContextBundle,
  ContextSlotName,
  SlotMeta,
  UploadOutcome,
} from '../../../shared/types.js';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US');
}

interface SlotCardProps {
  label: string;
  optional?: boolean;
  meta: SlotMeta | null;
  busy: boolean;
  error?: string;
  onUpload: () => void;
  onClear: () => void;
}

function SlotCard({ label, optional, meta, busy, error, onUpload, onClear }: SlotCardProps): JSX.Element {
  const filled = !!meta;
  return (
    <div className={`slot-card${filled ? ' filled' : ''}`}>
      <div className="slot-head">
        <span className="slot-label">{label}</span>
        {optional && <span className="slot-optional">optional</span>}
      </div>

      {filled && meta ? (
        <>
          <div className="slot-filename" title={meta.originalName}>{meta.originalName}</div>
          <div className="slot-stats">
            <span>{fmtNumber(meta.words)} words</span>
            <span className="dim">·</span>
            <span>{fmtNumber(meta.tokens)} tokens</span>
            <span className="dim">·</span>
            <span>{fmtBytes(meta.bytes)}</span>
          </div>
          <div className="slot-preview">{meta.preview}</div>
          <div className="slot-actions">
            <button className="btn" onClick={onUpload} disabled={busy}>
              {busy ? 'Uploading…' : 'Replace'}
            </button>
            <button className="btn btn-ghost" onClick={onClear} disabled={busy}>
              Clear
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="slot-empty">
            <span className="dim">txt · md · pdf · docx</span>
          </div>
          <div className="slot-actions">
            <button className="btn" onClick={onUpload} disabled={busy}>
              {busy ? 'Opening…' : 'Browse…'}
            </button>
          </div>
        </>
      )}

      {error && <div className="slot-error">{error}</div>}
    </div>
  );
}

export function ContextSection(): JSX.Element {
  const [bundle, setBundle] = useState<ContextBundle | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setBundle(await window.api.getContext());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUploadSingleton = useCallback(async (slot: Exclude<ContextSlotName, 'other'>) => {
    setBusySlot(slot);
    setErrors((e) => ({ ...e, [slot]: '' }));
    try {
      const outcome: UploadOutcome = await window.api.uploadToSlot(slot);
      if ('ok' in outcome && outcome.ok) {
        await refresh();
      } else if ('ok' in outcome && !outcome.ok) {
        setErrors((e) => ({ ...e, [slot]: outcome.error }));
      }
    } finally {
      setBusySlot(null);
    }
  }, [refresh]);

  const handleUploadOther = useCallback(async () => {
    setBusySlot('other');
    setErrors((e) => ({ ...e, other: '' }));
    try {
      const outcome: UploadOutcome = await window.api.uploadOther();
      if ('ok' in outcome && outcome.ok) {
        await refresh();
      } else if ('ok' in outcome && !outcome.ok) {
        setErrors((e) => ({ ...e, other: outcome.error }));
      }
    } finally {
      setBusySlot(null);
    }
  }, [refresh]);

  const handleClear = useCallback(async (slot: ContextSlotName, id?: string) => {
    const next = await window.api.deleteSlot(slot, id);
    setBundle(next);
  }, []);

  return (
    <div className="section">
      <div className="section-label">Context</div>

      <div className="slot-grid">
        <SlotCard
          label="Essay"
          meta={bundle?.essay ?? null}
          busy={busySlot === 'essay'}
          error={errors.essay}
          onUpload={() => handleUploadSingleton('essay')}
          onClear={() => handleClear('essay')}
        />
        <SlotCard
          label="Bio / about-me"
          meta={bundle?.bio ?? null}
          busy={busySlot === 'bio'}
          error={errors.bio}
          onUpload={() => handleUploadSingleton('bio')}
          onClear={() => handleClear('bio')}
        />
        <SlotCard
          label="Source text"
          optional
          meta={bundle?.source ?? null}
          busy={busySlot === 'source'}
          error={errors.source}
          onUpload={() => handleUploadSingleton('source')}
          onClear={() => handleClear('source')}
        />
        <div className="slot-card">
          <div className="slot-head">
            <span className="slot-label">Other</span>
            <span className="slot-optional">optional</span>
          </div>
          {bundle && bundle.other.length === 0 ? (
            <div className="slot-empty">
              <span className="dim">CV, past questions, research notes…</span>
            </div>
          ) : (
            <ul className="other-list">
              {bundle?.other.map((m) => (
                <li key={m.id}>
                  <span className="other-name" title={m.originalName}>{m.originalName}</span>
                  <span className="dim mono">{fmtNumber(m.words)}w</span>
                  <button
                    className="btn btn-ghost btn-tiny"
                    onClick={() => handleClear('other', m.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="slot-actions">
            <button className="btn" onClick={handleUploadOther} disabled={busySlot === 'other'}>
              {busySlot === 'other' ? 'Opening…' : '+ Add file'}
            </button>
          </div>
          {errors.other && <div className="slot-error">{errors.other}</div>}
        </div>
      </div>
    </div>
  );
}
