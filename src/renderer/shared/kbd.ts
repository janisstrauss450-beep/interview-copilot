// Tiny keyboard-shortcut helper shared between the setup + overlay renderers.
// Detects platform at load time from navigator.userAgent (renderer-only; don't
// import from main).
//
// Style: spelled-out words ("Cmd+Shift+R" / "Ctrl+Shift+R"), not Unicode glyphs
// (⌘⇧R) — easier to read for users who don't memorise Mac key symbols.

export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Plain modifier word for the platform. */
export const MOD = isMac ? 'Cmd' : 'Ctrl';
/** Alt/Option name for the platform. */
export const ALT = isMac ? 'Option' : 'Alt';
/** Canonical Cmd+Shift / Ctrl+Shift prefix used by most of our bindings. */
export const MOD_SHIFT = `${MOD}+Shift`;

/**
 * Format a single-letter accelerator with Cmd/Ctrl+Shift prefix.
 * kbd('R') → "Cmd+Shift+R" (Mac), "Ctrl+Shift+R" (Windows).
 */
export function kbd(letter: string): string {
  return `${MOD_SHIFT}+${letter}`;
}

/**
 * Format an accelerator in Electron's CommandOrControl+... form to a readable
 * label.
 * acceleratorLabel('CommandOrControl+Shift+R') → "Cmd+Shift+R" / "Ctrl+Shift+R".
 */
export function acceleratorLabel(accel: string): string {
  return accel.replace('CommandOrControl', MOD).replace('Alt', ALT);
}
