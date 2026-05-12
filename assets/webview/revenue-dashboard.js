// v2.89.137 — Revenue Dashboard webview script.
// state schema: {
//   loading: bool, error: string|null,
//   data: {
//     totals: { by_currency: {USD: {gross, refunds, fees, count}}, by_period: {today, week, month} },
//     by_project: { 'neon-survivor': {gross, count, currency, items: {...}} },
//     by_day: { '2026-05-12': {USD: {gross, count}} },
//     transactions: [{id, ts, ts_epoch, value, currency, subject, event_code, is_refund}]
//   }
// }

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const fmtNum = (n) => Number(n||0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmtInt = (n) => Number(n||0).toLocaleString();

let lastData = null;
let firstRender = true;

// ───────── Glyph rain (background) ─────────
function spawnGlyphRain() {
  const wrap = $('glyphRain');
  if (!wrap) return;
  const W = window.innerWidth;
  const cols = Math.min(40, Math.floor(W / 28));
  const glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿ$01_-アエ◆◇⬢⬡';
  for (let i = 0; i < cols; i++) {
    const col = document.createElement('div');
    col.className = 'col';
    col.style.left = (i / cols * 100) + '%';
    col.style.animationDuration = (10 + Math.random() * 25) + 's';
    col.style.animationDelay = (-Math.random() * 20) + 's';
    let txt = '';
    for (let r = 0; r < 30; r++) txt += glyphs[Math.floor(Math.random()*glyphs.length)] + '\n';
    col.textContent = txt;
    wrap.appendChild(col);
  }
}

// ───────── Count-up animation ─────────
function countUp(el, target, opts = {}) {
  const duration = opts.duration || 1100;
  const decimals = opts.decimals != null ? opts.decimals : 2;
  const startVal = parseFloat(el.dataset.last || '0');
  const t0 = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    const v = startVal + (target - startVal) * eased;
    el.textContent = v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    if (p < 1) requestAnimationFrame(tick);
    else {
      el.dataset.last = String(target);
      // v2.89.150 — 완료 시 부모 .kpi 카드에 burst 효과
      if (target > 0 && target !== startVal) {
        const card = el.closest('.kpi');
        if (card) {
          card.classList.add('complete-burst');
          setTimeout(() => card.classList.remove('complete-burst'), 800);
        }
      }
    }
  }
  requestAnimationFrame(tick);
}

// ───────── Sparkline (daily revenue) ─────────
function renderSparkline(byDay, primaryCur) {
  const svg = $('sparkSvg');
  if (!svg) return;
  const days = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const day = byDay[key];
    const v = day && day[primaryCur] ? day[primaryCur].gross : 0;
    days.push({ key, value: v, date: d });
  }
  const maxV = Math.max(...days.map(d => d.value), 1);
  const W = 800, H = 160, padL = 36, padR = 8, padT = 16, padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xOf = (i) => padL + (i / (days.length - 1)) * innerW;
  const yOf = (v) => padT + innerH - (v / maxV) * innerH;

  const pts = days.map((d, i) => `${xOf(i).toFixed(1)},${yOf(d.value).toFixed(1)}`).join(' ');
  const areaPts = `${padL},${padT + innerH} ${pts} ${xOf(days.length-1)},${padT + innerH}`;

  const peakIdx = days.reduce((acc, d, i) => d.value > days[acc].value ? i : acc, 0);

  const dots = days.map((d, i) => {
    if (d.value <= 0) return '';
    const isPeak = i === peakIdx && d.value > 0;
    return `<circle class="spark-dot${isPeak?' peak':''}" cx="${xOf(i).toFixed(1)}" cy="${yOf(d.value).toFixed(1)}" r="${isPeak?5:3}"></circle>`;
  }).join('');

  // Y-axis labels (3 levels)
  const yLabels = [maxV, maxV/2, 0].map((v, i) => {
    const y = yOf(v) + 4;
    return `<text class="spark-label" x="${padL - 6}" y="${y.toFixed(1)}" text-anchor="end">${v.toFixed(0)}</text>`;
  }).join('');

  // X-axis labels (start, middle, end)
  const xTicks = [0, Math.floor(days.length/2), days.length-1].map(i => {
    const d = days[i].date;
    const label = (d.getMonth()+1) + '/' + d.getDate();
    return `<text class="spark-label" x="${xOf(i).toFixed(1)}" y="${H-6}" text-anchor="middle">${label}</text>`;
  }).join('');

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="gradArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.45"></stop>
        <stop offset="100%" stop-color="#22d3ee" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    <polygon class="spark-area" points="${areaPts}"></polygon>
    <polyline class="spark-line" points="${pts}"></polyline>
    ${dots}
    ${yLabels}
    ${xTicks}
  `;
}

// ───────── Donut (project mix) ─────────
const PROJECT_COLORS = ['#22d3ee', '#a78bfa', '#fbbf24', '#34d399', '#f0abfc', '#fb923c', '#67e8f9'];

function renderDonut(byProject, primaryCur) {
  const svg = $('donutSvg');
  const legend = $('donutLegend');
  const centerVal = $('donutCenterVal');
  if (!svg || !legend) return;

  const entries = Object.entries(byProject || {})
    .map(([name, p]) => ({ name, gross: p.gross || 0, count: p.count || 0 }))
    .filter(p => p.gross > 0)
    .sort((a, b) => b.gross - a.gross);

  const total = entries.reduce((s, p) => s + p.gross, 0);
  if (centerVal) {
    centerVal.dataset.last = centerVal.dataset.last || '0';
    countUp(centerVal, total, { decimals: 2 });
  }

  if (entries.length === 0) {
    svg.innerHTML = `<circle cx="100" cy="100" r="80" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="18"></circle>`;
    legend.innerHTML = '<div style="color: var(--text-3); font-size: 0.85rem; padding: 10px 0;">결제 0건</div>';
    return;
  }

  const R = 80, CX = 100, CY = 100;
  const C = 2 * Math.PI * R;
  let accum = 0;
  const segs = entries.map((p, i) => {
    const frac = p.gross / total;
    const dash = C * frac;
    const gap = C - dash;
    const offset = -accum * C;
    accum += frac;
    return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none"
            stroke="${PROJECT_COLORS[i % PROJECT_COLORS.length]}"
            stroke-width="18"
            stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
            stroke-dashoffset="${offset.toFixed(2)}"
            transform="rotate(-90 ${CX} ${CY})"
            style="filter: drop-shadow(0 0 6px ${PROJECT_COLORS[i % PROJECT_COLORS.length]}); transition: stroke-dashoffset 0.6s ease;"></circle>`;
  }).join('');

  svg.setAttribute('viewBox', '0 0 200 200');
  svg.innerHTML = segs;

  legend.innerHTML = entries.map((p, i) => {
    const pct = (p.gross / total * 100).toFixed(1);
    const color = PROJECT_COLORS[i % PROJECT_COLORS.length];
    return `<div class="item">
      <div class="swatch" style="background:${color}; color:${color};"></div>
      <div class="name">${esc(p.name)}</div>
      <div class="pct">${pct}%</div>
    </div>`;
  }).join('');
}

// ───────── Project bars (detailed breakdown) ─────────
function renderProjectBars(byProject) {
  const wrap = $('projBars');
  if (!wrap) return;
  const entries = Object.entries(byProject || {})
    .map(([name, p]) => ({ name, gross: p.gross || 0, count: p.count || 0, items: p.items || {} }))
    .filter(p => p.gross > 0)
    .sort((a, b) => b.gross - a.gross);

  if (entries.length === 0) {
    wrap.innerHTML = '';
    return;
  }
  const maxV = Math.max(...entries.map(p => p.gross), 1);
  wrap.innerHTML = entries.map(p => {
    const w = (p.gross / maxV * 100).toFixed(1);
    const items = Object.entries(p.items || {}).sort((a,b) => b[1].gross - a[1].gross).slice(0, 3);
    const itemsTxt = items.map(([k,v]) => `${esc(k)} ×${v.count}`).join(' · ');
    return `<div class="proj-bar">
      <div class="name">${esc(p.name)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
      <div class="val">${fmtNum(p.gross)}</div>
    </div>
    <div style="font-size: 0.72rem; color: var(--text-3); padding: 0 0 8px 154px;">${itemsTxt}</div>`;
  }).join('');
}

// ───────── Transaction feed ─────────
const KNOWN_TX_IDS = new Set();
function renderTransactions(txs) {
  const feed = $('feed');
  if (!feed) return;
  if (!txs || txs.length === 0) {
    feed.innerHTML = `<div class="empty">
      <div class="emoji">📭</div>
      <h3>아직 거래가 없어요</h3>
      <p>EZER 카탈로그를 공유하고 첫 결제를 기다리는 중...</p>
    </div>`;
    return;
  }

  feed.innerHTML = txs.slice(0, 30).map(tx => {
    const isNew = !firstRender && !KNOWN_TX_IDS.has(tx.id);
    KNOWN_TX_IDS.add(tx.id);
    const cls = tx.is_refund ? 'refund' : 'payment';
    const icon = tx.is_refund ? '↩' : '＄';
    const sign = tx.is_refund ? '-' : '+';
    const subj = tx.subject || '(설명 없음)';
    const ts = tx.ts ? new Date(tx.ts) : null;
    const tsStr = ts ? `${ts.getMonth()+1}/${ts.getDate()} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}` : '?';
    return `<div class="tx${isNew?' new':''}" data-id="${esc(tx.id)}">
      <div class="tx-icon ${cls}">${icon}</div>
      <div class="tx-body">
        <div class="tx-subject">${esc(subj)}</div>
        <div class="tx-meta">${tsStr} · ${esc(tx.currency)} · ${esc(tx.event_code || '')}</div>
      </div>
      <div class="tx-amount ${cls}">${sign}${fmtNum(Math.abs(tx.value))}</div>
    </div>`;
  }).join('');

  if (!firstRender) {
    // 새 거래가 있으면 burst alert
    const newOnes = txs.slice(0, 30).filter(tx => {
      const known = feed.querySelector(`[data-id="${tx.id}"]`);
      return known && known.classList.contains('new');
    });
    if (newOnes.length > 0) showBurst(newOnes[0]);
  }
}

// ───────── New payment burst alert ─────────
function showBurst(tx) {
  const burst = $('burst');
  if (!burst) return;
  const isRefund = tx.is_refund;
  const sign = isRefund ? '-' : '+';
  burst.innerHTML = `
    <div class="big">${sign}$${Math.abs(tx.value).toFixed(2)}</div>
    <div class="sub">${esc(tx.subject || '새 결제')}</div>
  `;
  burst.classList.remove('show');
  void burst.offsetWidth;
  burst.classList.add('show');
}

// ───────── KPI strip render ─────────
function renderKPI(data) {
  const totals = data?.totals || {};
  const period = totals.by_period || { today: 0, week: 0, month: 0 };
  const byCur = totals.by_currency || {};

  // primary currency (largest gross)
  const primaryCur = Object.entries(byCur).sort((a,b) => (b[1].gross||0)-(a[1].gross||0))[0]?.[0] || 'USD';
  $('curLabel').textContent = primaryCur;

  const cur = byCur[primaryCur] || {gross:0, refunds:0, fees:0, count:0};
  const net = cur.gross - cur.refunds - cur.fees;
  const txCount = cur.count || 0;

  countUp($('kpiToday'), period.today);
  countUp($('kpiWeek'), period.week);
  countUp($('kpiMonth'), period.month);
  countUp($('kpiNet'), net);
  countUp($('kpiCount'), txCount, { decimals: 0 });

  $('kpiMonthSub').textContent = `${txCount}건 · 환불 ${fmtNum(cur.refunds)} · 수수료 ${fmtNum(cur.fees)}`;

  return primaryCur;
}

// ───────── Master render ─────────
function render(state) {
  if (state.loading) {
    $('emptyArea')?.classList.add('hidden');
    return;
  }
  if (state.error) {
    $('emptyArea').classList.remove('hidden');
    $('emptyArea').innerHTML = `<div class="empty">
      <div class="emoji">⚠️</div>
      <h3>매출 데이터 가져오기 실패</h3>
      <p>${esc(state.error)}</p>
      <p style="margin-top:10px;">
        외부 연결 패널에서 <code>PayPal Client ID</code> + <code>Secret</code> 설정 필요.<br>
        또는 <code>connectAiLab.apiConnections.open</code> 명령으로 직접.
      </p>
    </div>`;
    return;
  }
  const data = state.data;
  if (!data) return;
  lastData = data;
  $('emptyArea').classList.add('hidden');

  const primaryCur = renderKPI(data);
  renderSparkline(data.by_day || {}, primaryCur);
  renderDonut(data.by_project || {}, primaryCur);
  renderProjectBars(data.by_project || {});
  renderTransactions(data.transactions || []);

  $('generated').textContent = data.generated_at ? new Date(data.generated_at).toLocaleString() : '';
  firstRender = false;
}

// ───────── Wire UI ─────────
$('refreshBtn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
  $('refreshBtn').textContent = '⏳ 새로고침 중...';
  setTimeout(() => $('refreshBtn').textContent = '🔄 새로고침', 800);
});
$('settingsBtn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'openSettings' });
});

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'state') render(m);
});

spawnGlyphRain();
vscode.postMessage({ type: 'ready' });
