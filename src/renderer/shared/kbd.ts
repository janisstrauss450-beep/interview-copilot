// Tiny keyboard-shortcut helper shared between the setup + overlay renderers.
// Detects platform at load time from navigator.userAgent (renderer-only; don't
// import from main).

export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Modifier symbol for each platform. */
export const MOD = isMac ? '⌘' : 'Ctrl+';
/** Shift symbol: always the Unicode arrow on Mac, verbose on Windows. */
export const SHIFT = isMac ? '⇧' : 'Shift+';

/**
 * Format a single-letter accelerator.
 * kbd('R') → "⌘⇧R" on macOS, "Ctrl+Shift+R" on Windows.
 */
export function kbd(letter: string): string {
  return `${MOD}${SHIFT}${letter}`;
}

/**
 * Format an accelerator in Electron's CommandOrControl+... form.
 * acceleratorLabel('CommandOrControl+Shift+R') → "⌘⇧R" or "Ctrl+Shift+R".
 */
export function acceleratorLabel(accel: string): string {
  return accel
    .replace('CommandOrControl', isMac ? '⌘' : 'Ctrl')
    .replace('Shift', isMac ? '⇧' : 'Shift')
    .replace('Alt', isMac ? '⌥' : 'Alt')
    .replace(/\+/g, isMac ? '' : '+');
}
