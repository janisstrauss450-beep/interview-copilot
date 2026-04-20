import { useEffect, useState } from 'react';
import type { HotkeyBindingInfo } from '../../../shared/types.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

function acceleratorLabel(accel: string): string {
  return accel
    .replace('CommandOrControl', isMac ? '⌘' : 'Ctrl')
    .replace('Shift', '⇧')
    .replace('Alt', isMac ? '⌥' : 'Alt')
    .replace(/\+/g, '');
}

export function HotkeysSection(): JSX.Element {
  const [bindings, setBindings] = useState<HotkeyBindingInfo[] | null>(null);

  useEffect(() => {
    window.api.getHotkeys().then(setBindings).catch(() => setBindings([]));
  }, []);

  const anyError = bindings?.some((b) => !b.registered);

  return (
    <div className="section">
      <div className="section-label">Hotkeys</div>
      <div className="card">
        {bindings == null ? (
          <span className="dim mono">loading…</span>
        ) : bindings.length === 0 ? (
          <span className="dim mono">no hotkeys registered</span>
        ) : (
          <ul className="hotkey-list">
            {bindings.map((b) => (
              <li key={b.id} className={`hotkey-row${b.registered ? '' : ' hotkey-err'}`}>
                <span className="hotkey-label">{b.label}</span>
                <span className="hotkey-desc dim">{b.description}</span>
                <span
                  className={`hotkey-chip mono${b.registered ? '' : ' hotkey-chip-err'}`}
                  title={b.error ?? 'registered'}
                >
                  {acceleratorLabel(b.accelerator)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {anyError && (
          <div className="slot-error" style={{ marginTop: 8 }}>
            Some hotkeys failed to register — another app is holding that combo. See each row's tooltip for detail. No custom-binding UI yet; edit <span className="mono">src/main/index.ts</span> to change.
          </div>
        )}
      </div>
    </div>
  );
}
