#!/usr/bin/env node
/**
 * Local dashboard for the quant advisor: metrics, rule flags, LLM brief, and streamed AI interpretation.
 *
 * Usage:
 *   Windows: double-click `Start-Advisor-Dashboard.cmd` in the repo root (easiest).
 *   node scripts/advisor-ui.mjs
 *   npm run advisor:ui
 *   ADVISOR_UI_PORT=4890 node scripts/advisor-ui.mjs
 *
 * Env:
 *   Loads `.env.local` then `.env` from repo root if present (see `.env.example`).
 *   OPENAI_API_KEY — enables "Ask AI" streaming (gpt-4o-mini by default)
 *   ADVISOR_OPENAI_MODEL — override model id
 *   ADVISOR_INITIAL_CAPITAL, ADVISOR_MAX_DD_USD, ADVISOR_WARN_DD_PCT, ADVISOR_MIN_TRADES — surfaced in GET /api/env for the risk banner (no secrets leaked)
 *
 * Opens http://127.0.0.1:<port>/ in your browser (Windows: start).
 *
 * If the preferred port is busy, the next free port is used (unless ADVISOR_UI_STRICT_PORT=1).
 */

import http from 'http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { loadEnvFromRoot } from './lib/load-env.mjs';
import { findFirstFreePort } from './lib/find-free-port.mjs';

loadEnvFromRoot();

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const LATEST = join(root, 'data', 'advisor-latest.json');

function parsePort() {
  const n = Number(process.env.ADVISOR_UI_PORT || 4890);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error('[advisor-ui] Invalid ADVISOR_UI_PORT — must be 1–65535. Using 4890.');
    return 4890;
  }
  return n;
}

const WANT_PORT = parsePort();
const HOST = (process.env.ADVISOR_UI_HOST || '127.0.0.1').trim() || '127.0.0.1';
const STRICT_PORT = process.env.ADVISOR_UI_STRICT_PORT === '1';

let PORT;
try {
  PORT = STRICT_PORT ? WANT_PORT : await findFirstFreePort(WANT_PORT, HOST, 30);
} catch (e) {
  console.error('[advisor-ui]', e.message || e);
  process.exit(1);
}
if (!STRICT_PORT && PORT !== WANT_PORT) {
  console.error(`[advisor-ui] Port ${WANT_PORT} busy — using ${PORT} instead.`);
}

function openBrowser(url) {
  const p = process.platform;
  try {
    if (p === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else if (p === 'darwin') execFile('open', [url], () => {});
    else execFile('xdg-open', [url], () => {});
  } catch {
    /* ignore */
  }
}

function runAdvisorCli() {
  return new Promise((resolve, reject) => {
    const script = join(root, 'scripts', 'quant-advisor.mjs');
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ADVISOR_QUIET: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `advisor exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()));
      } catch (e) {
        reject(new Error(`Invalid JSON from advisor: ${e.message}`));
      }
    });
  });
}

async function* streamOpenAI(brief) {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) throw new Error('OPENAI_API_KEY not set — add to .env in repo root and restart the dashboard.');
  const model = process.env.ADVISOR_OPENAI_MODEL || 'gpt-4o-mini';
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        {
          role: 'system',
          content: `${brief.model_role}\n\nConstraints:\n${(brief.constraints || []).join('\n')}`,
        },
        { role: 'user', content: brief.user_message },
      ],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI ${r.status}: ${t.slice(0, 500)}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const j = JSON.parse(data);
          const t = j.choices?.[0]?.delta?.content;
          if (t) yield t;
        } catch {
          /* partial JSON line */
        }
      }
    }
    const tail = buf.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim();
      if (data !== '[DONE]') {
        try {
          const j = JSON.parse(data);
          const t = j.choices?.[0]?.delta?.content;
          if (t) yield t;
        } catch {
          /* ignore */
        }
      }
    }
  }

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Quant Advisor</title>
  <style>
    :root {
      --bg: #0d1117;
      --panel: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --bad: #f85149;
      --ok: #3fb950;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: ui-sans-serif, system-ui, sans-serif;
      background: var(--bg); color: var(--text);
      min-height: 100vh;
    }
    header {
      padding: 1rem 1.25rem; border-bottom: 1px solid var(--border);
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem;
    }
    h1 { font-size: 1.1rem; font-weight: 600; margin: 0; }
    .sub { color: var(--muted); font-size: 0.85rem; }
    main { padding: 1rem 1.25rem 2rem; max-width: 1100px; margin: 0 auto; }
    .row { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; }
    button {
      background: var(--panel); color: var(--text); border: 1px solid var(--border);
      padding: 0.45rem 0.85rem; border-radius: 6px; cursor: pointer; font-size: 0.9rem;
    }
    button:hover { border-color: var(--accent); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .primary { background: #1f6feb; border-color: #388bfd; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 0.6rem; }
    .card {
      background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
      padding: 0.65rem 0.75rem;
    }
    .card .k { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .card .v { font-size: 1.05rem; font-variant-numeric: tabular-nums; margin-top: 0.2rem; }
    section {
      background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
      padding: 0.85rem 1rem; margin-bottom: 1rem;
    }
    section h2 { font-size: 0.8rem; color: var(--muted); margin: 0 0 0.6rem; font-weight: 600; }
    ul.flags { margin: 0; padding-left: 1.1rem; }
    ul.flags li { margin: 0.35rem 0; font-size: 0.9rem; }
    .level-high { color: var(--bad); }
    .level-medium { color: #d29922; }
    .level-low { color: var(--muted); }
    pre.brief {
      white-space: pre-wrap; word-break: break-word; font-size: 0.8rem;
      max-height: 220px; overflow: auto; margin: 0;
      color: #c9d1d9;
    }
    #think {
      white-space: pre-wrap; word-break: break-word; font-size: 0.9rem;
      line-height: 1.5; min-height: 120px; color: #c9d1d9;
    }
    .hint { font-size: 0.8rem; color: var(--muted); margin-top: 0.5rem; }
    .err { color: var(--bad); font-size: 0.85rem; margin-top: 0.5rem; }
    .pulse::after { content: ''; animation: dots 1s steps(4) infinite; }
    @keyframes dots { 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
    .risk-banner {
      border-radius: 8px; padding: 0.65rem 1rem; margin-bottom: 1rem;
      border: 1px solid var(--border); font-size: 0.9rem; line-height: 1.45; display: none;
    }
    .risk-banner.show { display: block; }
    .risk-banner.high { background: rgba(248, 81, 73, 0.12); border-color: #f8514966; }
    .risk-banner.medium { background: rgba(210, 153, 34, 0.12); border-color: #d2992266; }
    .risk-banner.ok { background: rgba(63, 185, 80, 0.08); border-color: #3fb95044; }
    .risk-banner .rb-title { font-weight: 600; margin-bottom: 0.35rem; }
    .risk-banner .rb-sub { color: var(--muted); font-size: 0.82rem; margin-top: 0.35rem; }
    .poll-hint {
      font-size: 0.8rem; color: var(--muted); margin: -0.35rem 0 0.85rem 0;
      max-width: 52rem; line-height: 1.45;
    }
    .poll-hint code { background: var(--panel); padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.78rem; }
    ul.plan-followups { margin: 0.4rem 0 0; padding-left: 1.2rem; }
    ul.plan-followups li { margin: 0.35rem 0; font-size: 0.88rem; color: #c9d1d9; }
  </style>
</head>
<body>
  <header>
    <h1>Quant Advisor</h1>
    <span class="sub">Live view · same CDP data as <code>tv</code> CLI</span>
    <span class="sub" id="status"></span>
  </header>
  <main>
    <div id="riskBanner" class="risk-banner ok"></div>
    <div class="row">
      <button type="button" class="primary" id="btnRun">Refresh from TradingView</button>
      <button type="button" id="btnPoll" title="Re-read data/advisor-latest.json every 3s — does not call TradingView">Poll snapshot every 3s</button>
      <button type="button" id="btnAi" disabled>Ask AI (stream)</button>
      <button type="button" id="btnCopy">Copy LLM brief</button>
    </div>
    <p class="poll-hint" id="pollHint">
      <strong>Poll snapshot</strong> only reloads the last saved <code>data/advisor-latest.json</code> on disk — it does <em>not</em> fetch new metrics from TradingView.
      Click <strong>Refresh from TradingView</strong> to run the quant advisor (requires TV Desktop + CDP).
    </p>
    <p class="hint" id="aiHint"></p>
    <div class="grid" id="kpis"></div>
    <section>
      <h2>Memory trend</h2>
      <p class="hint" id="memoryTrend">—</p>
    </section>
    <section>
      <h2>Suggested next steps</h2>
      <ul class="flags" id="suggestedActions"></ul>
    </section>
    <section>
      <h2>Plan refinement</h2>
      <p class="hint" style="margin-top:0">Follow-ups from the LLM brief — checklist for your next review or paste into <strong>Ask AI</strong>.</p>
      <ul class="plan-followups" id="planFollowups"></ul>
    </section>
    <section>
      <h2>Rule engine</h2>
      <ul class="flags" id="flags"></ul>
    </section>
    <section>
      <h2>LLM brief (user_message)</h2>
      <pre class="brief" id="brief"></pre>
    </section>
    <section>
      <h2>AI interpretation <span class="sub" id="thinkLabel"></span></h2>
      <div id="think">Run a refresh, then Ask AI to stream the model’s reasoning here.</div>
      <div class="err" id="err"></div>
    </section>
  </main>
  <script>
  const el = (id) => document.getElementById(id);
  let pollTimer = null;
  const LABEL_POLL_IDLE = 'Poll snapshot every 3s';
  const LABEL_POLL_ON = 'Stop polling';

  let advisorEnv = {};
  let hasOpenai = false;

  function fmt(n, d) {
    if (n == null || typeof n !== 'number' || !isFinite(n)) return '—';
    return n.toFixed(d);
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function renderRiskBanner(data) {
    const rb = el('riskBanner');
    if (!data || data.empty) {
      rb.className = 'risk-banner ok';
      rb.innerHTML =
        '<div class="rb-title">No snapshot loaded</div><div class="rb-sub">Click <strong>Refresh from TradingView</strong> to run the quant advisor and populate KPIs.</div>';
      rb.classList.add('show');
      return;
    }
    const pri = (data.advisor && data.advisor.priorities) || [];
    const hasHigh = pri.some((p) => p.level === 'high');
    const hasMed = pri.some((p) => p.level === 'medium');
    const m = data.metricsSummary || {};
    const est = m.estimatedMaxDdUsd;
    const cap = advisorEnv.advisorMaxDdUsd || 0;
    const warnPct = advisorEnv.advisorWarnDdPct || 0;
    const ddPct = m.maxStrategyDrawDownPercent;

    let cls = 'ok';
    let title = 'Risk snapshot';
    let lines = [];

    if (hasHigh) {
      cls = 'high';
      title = 'High-severity risk flags';
      lines = pri.filter((p) => p.level === 'high').slice(0, 2).map((p) => p.text);
    } else if (hasMed) {
      cls = 'medium';
      title = 'Medium-severity risk flags';
      lines = pri.filter((p) => p.level === 'medium').slice(0, 2).map((p) => p.text);
    } else {
      title = 'No high-severity flags on this snapshot';
      lines = ['Still validate out-of-sample / walk-forward before sizing up.'];
    }

    let sub = '';
    if (cap > 0 && est != null && typeof est === 'number') {
      sub +=
        'Env <code>ADVISOR_MAX_DD_USD</code> = $' +
        fmt(cap, 0) +
        ' · Est. max DD = $' +
        fmt(est, 2) +
        (est > cap ? ' <strong>(exceeds cap)</strong>' : '') +
        '. ';
    }
    if (warnPct > 0 && ddPct != null && typeof ddPct === 'number' && ddPct > warnPct) {
      sub += 'Tester max DD% (' + fmt(ddPct, 2) + '%) is above ADVISOR_WARN_DD_PCT (' + warnPct + '%). ';
    }
    if (advisorEnv.advisorInitialCapital) {
      sub += 'Initial capital (env): $' + fmt(advisorEnv.advisorInitialCapital, 0) + '. ';
    }

    rb.className = 'risk-banner ' + cls + ' show';
    rb.innerHTML =
      '<div class="rb-title">' +
      escapeHtml(title) +
      '</div>' +
      (lines.length
        ? '<div>' + lines.map((t) => escapeHtml(t)).join('<br/>') + '</div>'
        : '') +
      (sub ? '<div class="rb-sub">' + sub + '</div>' : '');
  }

  function renderPlanFollowups(data) {
    const ul = el('planFollowups');
    const fu = data && data.llm_brief && data.llm_brief.suggested_followups;
    if (!data || data.empty || !fu || !fu.length) {
      ul.innerHTML =
        '<li class="level-low">' +
        (data && data.empty
          ? 'Run <strong>Refresh from TradingView</strong> to generate follow-ups.'
          : 'No follow-ups in brief — refresh after a successful advisor run.') +
        '</li>';
      return;
    }
    ul.innerHTML = fu.map((t) => '<li>' + escapeHtml(String(t)) + '</li>').join('');
  }

  function render(data) {
    el('err').textContent = '';
    renderRiskBanner(data);

    if (!data || data.empty) {
      el('status').textContent = 'No snapshot yet — click Refresh.';
      el('btnAi').disabled = true;
      el('kpis').innerHTML = '';
      el('planFollowups').innerHTML =
        '<li class="level-low">Run <strong>Refresh from TradingView</strong> first.</li>';
      return;
    }
    el('status').textContent = (data.chart && data.chart.symbol) ? data.chart.symbol + ' @ ' + data.chart.resolution : '';
    const m = data.metricsSummary || {};
    const q = data.quantitative || {};
    const ts = data.tradeStats || {};
    const ls = ts.longShort || {};
    const eq = data.equityInfo || {};

    const eqDdPct =
      eq.equityMaxDrawdownFrac != null && typeof eq.equityMaxDrawdownFrac === 'number' && isFinite(eq.equityMaxDrawdownFrac)
        ? (eq.equityMaxDrawdownFrac * 100).toFixed(2) + '%'
        : '—';

    const kpiRows = [
      ['Net profit', fmt(m.netProfit, 2)],
      ['Profit factor (strategy)', fmt(m.profitFactor, 3)],
      ['Win % (strategy)', m.percentProfitable == null ? '—' : (m.percentProfitable * 100).toFixed(1) + '%'],
      ['Trades', m.totalTrades != null ? String(m.totalTrades) : '—'],
      ['Max DD % (tester)', m.maxStrategyDrawDownPercent == null ? '—' : fmt(m.maxStrategyDrawDownPercent, 2) + '%'],
      ['Est. max DD $', m.estimatedMaxDdUsd == null ? '—' : fmt(m.estimatedMaxDdUsd, 2)],
      ['Sample expectancy', q.sampleExpectancy == null ? '—' : fmt(q.sampleExpectancy, 4)],
      ['Sharpe (strategy)', m.sharpe == null ? '—' : fmt(m.sharpe, 3)],
      ['Profit factor (trades)', ts.profitFactor == null ? '—' : fmt(ts.profitFactor, 3)],
      ['Max loss streak', ts.maxConsecLosses == null ? '—' : String(ts.maxConsecLosses)],
      ['Max win streak', ts.maxConsecWins == null ? '—' : String(ts.maxConsecWins)],
      ['Long / Short #', (ls.long != null ? String(ls.long) : '—') + ' / ' + (ls.short != null ? String(ls.short) : '—')],
      ['Best trade', ts.bestTrade == null ? '—' : fmt(ts.bestTrade, 2)],
      ['Worst trade', ts.worstTrade == null ? '—' : fmt(ts.worstTrade, 2)],
      ['PnL σ (sample)', ts.pnlStdDev == null ? '—' : fmt(ts.pnlStdDev, 2)],
      ['Equity DD (curve)', eqDdPct],
      ['Equity points', eq.curvePoints != null ? String(eq.curvePoints) : '—'],
    ];

    el('kpis').innerHTML = kpiRows.map(([k, v]) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');

    const mem = data.memory || {};
    const tr = mem.trend;
    if (tr && tr.sampleSize >= 2) {
      el('memoryTrend').innerHTML =
        '<strong>' + escapeHtml(tr.direction || 'flat') + '</strong> over ' +
        tr.sampleSize +
        ' saved runs · first ' + fmt(tr.firstNet, 2) + ' → last ' + fmt(tr.lastNet, 2) +
        (tr.avgNet != null ? ' · avg ' + fmt(tr.avgNet, 2) : '');
    } else {
      el('memoryTrend').textContent =
        mem.skipped ? 'Memory disabled for this run.' : 'Need at least 2 saved runs on this symbol/timeframe for a trend.';
    }

    const acts = (data.advisor && data.advisor.suggested_actions) || [];
    el('suggestedActions').innerHTML = acts.length
      ? acts
          .map(
            (a) =>
              '<li><strong>' +
              escapeHtml(a.title || '') +
              '</strong> <span class="sub">[' +
              escapeHtml(a.kind || '') +
              ']</span><br/>' +
              escapeHtml(a.detail || '') +
              '</li>'
          )
          .join('')
      : '<li class="level-low">No structured actions — see rule flags below.</li>';

    renderPlanFollowups(data);

    const pri = (data.advisor && data.advisor.priorities) || [];
    el('flags').innerHTML = pri.length
      ? pri.map((p) => '<li class="level-' + p.level + '"><strong>' + p.code + '</strong> — ' + escapeHtml(p.text) + '</li>').join('')
      : '<li>No flags</li>';

    const brief = data.llm_brief && data.llm_brief.user_message;
    el('brief').textContent = brief || '(no brief)';
    el('btnAi').disabled = !brief || !hasOpenai;
  }

  async function loadLatest() {
    const r = await fetch('/api/latest');
    const j = await r.json();
    render(j);
  }

  async function runTv() {
    el('btnRun').disabled = true;
    el('thinkLabel').textContent = '';
    try {
      const r = await fetch('/api/run', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'run failed');
      render(j);
    } catch (e) {
      el('err').textContent = e.message || String(e);
    } finally {
      el('btnRun').disabled = false;
    }
  }

  async function askAi() {
    el('think').innerHTML = '<span class="pulse">Thinking</span>';
    el('thinkLabel').textContent = '(streaming…)';
    el('err').textContent = '';
    el('btnAi').disabled = true;
    try {
      const r = await fetch('/api/interpret', { method: 'POST' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'HTTP ' + r.status);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      el('think').textContent = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        el('think').textContent += dec.decode(value, { stream: true });
      }
      el('thinkLabel').textContent = '(done)';
    } catch (e) {
      el('err').textContent = e.message || String(e);
      el('think').textContent = '';
    } finally {
      el('btnAi').disabled = false;
    }
  }

  function copyBrief() {
    const t = el('brief').textContent;
    navigator.clipboard.writeText(t).then(() => {
      el('thinkLabel').textContent = '(copied brief)';
      setTimeout(() => { el('thinkLabel').textContent = ''; }, 2000);
    });
  }

  el('btnRun').addEventListener('click', runTv);
  el('btnAi').addEventListener('click', askAi);
  el('btnCopy').addEventListener('click', copyBrief);
  el('btnPoll').addEventListener('click', () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      el('btnPoll').textContent = LABEL_POLL_IDLE;
    } else {
      pollTimer = setInterval(loadLatest, 3000);
      el('btnPoll').textContent = LABEL_POLL_ON;
      loadLatest();
    }
  });

  fetch('/api/env')
    .then((r) => r.json())
    .then((env) => {
      advisorEnv = env;
      hasOpenai = env.openai;
      if (env.openai) {
        el('aiHint').textContent = 'Ask AI is on — key loaded from the environment (.env / .env.local or system).';
      } else {
        const parts = [];
        parts.push('Ask AI needs OPENAI_API_KEY.');
        if (!env.hasEnvFile && !env.hasEnvLocal) {
          parts.push('Copy .env.example to .env in the tradingview-mcp folder, add OPENAI_API_KEY=sk-..., save, then restart this dashboard.');
        } else {
          parts.push('Put OPENAI_API_KEY=sk-... in .env or .env.local (repo root), save, restart the dashboard.');
        }
        el('aiHint').textContent = parts.join(' ');
      }
      loadLatest();
    })
    .catch(() => loadLatest());
  </script>
</body>
</html>`;

function readLatest() {
  if (!existsSync(LATEST)) return { empty: true };
  try {
    const raw = readFileSync(LATEST, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { empty: true, error: 'Could not read advisor-latest.json' };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/latest') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readLatest()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/env') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        openai: Boolean(process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim()),
        envPath: join(root, '.env'),
        hasEnvFile: existsSync(join(root, '.env')),
        hasEnvLocal: existsSync(join(root, '.env.local')),
        advisorMaxDdUsd: Number(process.env.ADVISOR_MAX_DD_USD || 0) || 0,
        advisorWarnDdPct: Number(process.env.ADVISOR_WARN_DD_PCT ?? 5) || 0,
        advisorInitialCapital: Number(process.env.ADVISOR_INITIAL_CAPITAL ?? 100000) || 100000,
        advisorMinTrades: Number(process.env.ADVISOR_MIN_TRADES ?? 15) || 0,
      })
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    try {
      const data = await runAdvisorCli();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/interpret') {
    const latest = readLatest();
    if (latest.empty || !latest.llm_brief) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No llm_brief — run Refresh from TradingView first.' }));
      return;
    }
    if (!String(process.env.OPENAI_API_KEY || '').trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'OPENAI_API_KEY not set. Add it to .env or .env.local in the repo root, then restart advisor-ui.',
        })
      );
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    try {
      for await (const chunk of streamOpenAI(latest.llm_brief)) {
        res.write(chunk);
      }
      res.end();
    } catch (e) {
      res.write(`\n\n[Error] ${e.message || e}`);
      res.end();
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', (err) => {
  console.error('[advisor-ui] HTTP server error:', err.message || err);
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      '[advisor-ui] Unexpected EADDRINUSE after port probe — try ADVISOR_UI_STRICT_PORT=1 or a higher ADVISOR_UI_PORT.',
    );
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const u = `http://${HOST}:${PORT}/`;
  const keyOk = Boolean(process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim());
  console.error(`[advisor-ui] ${u}`);
  console.error(
    keyOk
      ? '[advisor-ui] Ask AI: enabled (OPENAI_API_KEY is set).'
      : '[advisor-ui] Ask AI: off — add OPENAI_API_KEY to .env or .env.local in:\n         ' + root
  );
  console.error('[advisor-ui] Refresh from TV pulls Strategy Tester via the tv CLI (CDP).');
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    if (!existsSync(LATEST)) {
      writeFileSync(LATEST, JSON.stringify({ empty: true, note: 'Click Refresh from TradingView' }, null, 2));
    }
  } catch (e) {
    console.error('[advisor-ui] Could not create data/advisor-latest.json:', e.message || e);
    process.exit(1);
  }
  openBrowser(u);
});
