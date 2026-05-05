const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
function toast(msg, err){ const t=$('toast'); t.textContent=msg; t.classList.toggle('err',!!err); t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 2400); }
function render(s){
  const grid = $('grid');
  grid.innerHTML = s.services.map(svc => {
    const connected = !svc.comingSoon && svc.fields.every(f => (svc.values[f.key] || '').trim().length > 0);
    let status;
    if (svc.comingSoon) status = '<span class="svc-status coming">준비 중</span>';
    else if (connected) status = '<span class="svc-status connected">연결됨</span>';
    else status = '<span class="svc-status">미설정</span>';
    const fieldsHtml = svc.fields.map(f => {
      const val = svc.values[f.key] || '';
      const inputType = f.type === 'password' ? 'password' : 'text';
      const dis = svc.comingSoon ? ' disabled' : '';
      return '<div class="svc-field" data-key="' + esc(f.key) + '">'
        + '<label>' + esc(f.label) + '</label>'
        + '<div class="svc-input-wrap">'
        +   '<input type="' + inputType + '" value="' + esc(val) + '" placeholder="' + esc(f.placeholder || '') + '"' + dis + '>'
        +   (f.type === 'password' && !svc.comingSoon ? '<button class="svc-eye" data-eye="1" title="표시/숨김">👁</button>' : '')
        + '</div>'
        + (f.help ? '<div class="svc-help">' + esc(f.help) + '</div>' : '')
        + '</div>';
    }).join('');
    let actions = '';
    if (svc.comingSoon) {
      actions = '<div class="svc-coming-banner">곧 합류합니다 · 다음 업데이트에서 풀려요</div>';
    } else {
      actions = '<button class="btn primary" data-act="save">💾 저장</button>';
      if (svc.wizardCommand) actions += '<button class="btn" data-act="wizard">⚡ 자동 연결</button>';
      if (svc.helpUrl) actions += '<button class="btn ghost" data-act="help">📘 도움말</button>';
      actions = '<div class="svc-actions">' + actions + '</div>';
    }
    return '<div class="svc-card ' + (svc.comingSoon ? 'coming' : connected ? 'connected' : '') + '" data-svc="' + esc(svc.id) + '">'
      + '<div class="svc-head">'
      +   '<div class="svc-icon">' + esc(svc.icon) + '</div>'
      +   '<div><div class="svc-name">' + esc(svc.name) + '</div></div>'
      +   status
      + '</div>'
      + '<div class="svc-summary">' + esc(svc.summary) + '</div>'
      + '<div class="svc-fields">' + fieldsHtml + '</div>'
      + actions
      + '</div>';
  }).join('');
  /* Wire up handlers per card. */
  grid.querySelectorAll('.svc-card').forEach(card => {
    const id = card.dataset.svc;
    const svc = s.services.find(x => x.id === id);
    if (!svc) return;
    card.querySelectorAll('button[data-eye]').forEach(btn => {
      btn.onclick = () => {
        const inp = btn.previousElementSibling;
        inp.type = inp.type === 'password' ? 'text' : 'password';
      };
    });
    card.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'save') {
          const values = {};
          card.querySelectorAll('.svc-field').forEach(fEl => {
            values[fEl.dataset.key] = fEl.querySelector('input').value;
          });
          vscode.postMessage({ type: 'save', serviceId: id, values });
        } else if (act === 'wizard') {
          vscode.postMessage({ type: 'wizard', command: svc.wizardCommand });
        } else if (act === 'help') {
          vscode.postMessage({ type: 'openHelp', url: svc.helpUrl });
        }
      };
    });
  });
}
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'state') render(m);
  else if (m.type === 'saved') toast(m.ok ? (m.note ? '✅ 저장됨 — ' + m.note : '✅ 저장됨') : ('⚠️ ' + (m.error || '저장 실패')), !m.ok);
});
vscode.postMessage({ type: 'load' });