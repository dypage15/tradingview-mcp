/**
 * Parse CR3 wick entry comment / pane label into structured fields.
 * Formats:
 *   CR3_WL|c3|r28.6|a20.4|m2.41|d-0.21|BaO  (strategy comment)
 *   multi-line pane label text (label.new)
 */

export function parseWickEntryComment(signal) {
  if (!signal || typeof signal !== 'string') return null;
  if (!signal.includes('|') || !/^CR3_W[LU]/i.test(signal)) return null;
  const side = signal.startsWith('CR3_WL') ? 'Long' : 'Short';
  const parts = signal.split('|');
  const out = {
    wick_type: side === 'Long' ? 'LOWER' : 'UPPER',
    conf: null,
    rsi: null,
    adx: null,
    macd: null,
    drsi: null,
    cloud: null,
    vwap: null,
    rsi_os: false,
    rsi_ob: false,
    adx_opt: false,
    source: 'entry_comment',
  };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'rt') {
      out.retest = true;
      continue;
    }
    if (p.startsWith('c')) out.conf = Number(p.slice(1));
    else if (p.startsWith('r')) out.rsi = Number(p.slice(1));
    else if (p.startsWith('a')) out.adx = Number(p.slice(1));
    else if (p.startsWith('m')) out.macd = Number(p.slice(1));
    else if (p.startsWith('d')) out.drsi = Number(p.slice(1));
    else if (/^[BRN][AaBb]?O?$/.test(p)) {
      out.cloud = p[0] === 'B' ? 'BULL' : p[0] === 'R' ? 'BEAR' : 'NEU';
      const v = p.slice(1);
      if (v.startsWith('A') || v.startsWith('a')) out.vwap = 'above';
      if (v.startsWith('B') || v.startsWith('b')) out.vwap = 'below';
      if (p.includes('O')) {
        if (side === 'Long') out.rsi_os = true;
        else out.rsi_ob = true;
      }
    }
  }
  if (out.adx != null && out.adx >= 18 && out.adx <= 35) out.adx_opt = true;
  return out;
}

export function parseWickPaneLabel(text) {
  if (!text || !/WICK/i.test(text)) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0] || '';
  const isLower = /LOWER WICK/i.test(head);
  const isUpper = /UPPER WICK/i.test(head);
  const confMatch = head.match(/(\d+)\/7/);
  const conf = confMatch ? Number(confMatch[1]) : null;
  const pick = (prefix) => {
    const row = lines.find((l) => l.startsWith(prefix));
    if (!row) return { raw: '', value: null, check: false };
    const check = /✓/.test(row);
    const num = row.match(/-?\d+\.?\d*/);
    return { raw: row, value: num ? Number(num[0]) : null, check };
  };
  const rsi = pick('RSI');
  const adx = pick('ADX');
  const macd = pick('MACD');
  const drsi = pick('D-RSI');
  const cloudLine = lines.find((l) => l.startsWith('Cloud')) || '';
  const cloud = /BULL/i.test(cloudLine) ? 'BULL' : /BEAR/i.test(cloudLine) ? 'BEAR' : 'NEU';
  const vwapLine = lines.find((l) => l.startsWith('VWAP')) || '';
  const vwapAbove = /above/i.test(vwapLine);
  const vwapBelow = /below/i.test(vwapLine);
  return {
    wick_type: isLower ? 'LOWER' : isUpper ? 'UPPER' : null,
    conf,
    rsi: rsi.value,
    rsi_os: /OS/.test(rsi.raw),
    rsi_ob: /OB/.test(rsi.raw),
    adx: adx.value,
    adx_opt: /OPT/.test(adx.raw),
    macd: macd.value,
    drsi: drsi.value,
    cloud,
    vwap: vwapAbove ? 'above' : vwapBelow ? 'below' : null,
    source: 'pane_label',
    label_text: text,
  };
}

export function researchBucket(parsed, side) {
  if (!parsed) return '';
  const isLong = side === 'Long' || parsed.wick_type === 'LOWER';
  const c = parsed.conf;
  if (isLong) {
    if (parsed.rsi_os) return 'W_L_OS';
    if (c === 1) return 'W_L_1';
    if (c === 2) return 'W_L_2';
    if (c >= 3) return 'W_L_3+';
  } else {
    if (parsed.rsi_ob) return 'W_U_OB';
    if (c === 1) return 'W_U_1';
    if (c === 2) return 'W_U_2';
    if (c >= 3) return 'W_U_3+';
  }
  return '';
}

export function paneFieldsToRow(parsed, side) {
  if (!parsed) return {};
  return {
    wick_type: parsed.wick_type,
    conf: parsed.conf,
    rsi: parsed.rsi,
    rsi_os: parsed.rsi_os ?? false,
    rsi_ob: parsed.rsi_ob ?? false,
    adx: parsed.adx,
    adx_opt: parsed.adx_opt ?? false,
    macd: parsed.macd,
    drsi: parsed.drsi,
    cloud: parsed.cloud,
    vwap: parsed.vwap,
    research_bucket: researchBucket(parsed, side),
    label_source: parsed.source,
  };
}
