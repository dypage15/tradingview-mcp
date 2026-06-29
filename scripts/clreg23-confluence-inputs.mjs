/** Map CLREG23_CONFLUENCE env to 0-indexed TV inputs in_35 / in_36 (RSI / BB toggles). */
export function confluenceInputs(mode = process.env.CLREG23_CONFLUENCE || 'RSI') {
  const m = String(mode).toUpperCase();
  if (m === 'OFF' || m === 'CLOUD') return { in_35: false, in_36: false };
  if (m === 'BB') return { in_35: false, in_36: true };
  if (m === 'BOTH' || m === 'RSI+BB') return { in_35: true, in_36: true };
  return { in_35: true, in_36: false }; // RSI default
}
