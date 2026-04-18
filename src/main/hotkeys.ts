import { globalShortcut } from 'electron';

export interface HotkeyBinding {
  id: string;
  label: string;
  accelerator: string;
  description: string;
  registered: boolean;
  error?: string;
}

interface HotkeySpec {
  id: string;
  label: string;
  accelerator: string;
  description: string;
  action: () => void;
}

let currentBindings: HotkeyBinding[] = [];

export function registerHotkeys(specs: HotkeySpec[]): HotkeyBinding[] {
  unregisterHotkeys();
  const result: HotkeyBinding[] = [];
  for (const spec of specs) {
    let registered = false;
    let error: string | undefined;
    try {
      if (globalShortcut.isRegistered(spec.accelerator)) {
        error = `already registered by this app or another process`;
      } else {
        registered = globalShortcut.register(spec.accelerator, spec.action);
        if (!registered) error = 'OS rejected registration (likely already held by another app)';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    result.push({
      id: spec.id,
      label: spec.label,
      accelerator: spec.accelerator,
      description: spec.description,
      registered,
      error,
    });
  }
  currentBindings = result;
  return result;
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
  currentBindings = [];
}

export function getBindings(): HotkeyBinding[] {
  return currentBindings;
}
