'use strict';

/*
 * Обновления станции (большое окно «Радио»): плашка «Что нового» после обновления и
 * «История изменений» по кнопке — из зашитого списка (changelog.js), без интернета.
 * Грузится до app.js, чтобы поймать «была ли уже станция» до того, как та сохранит своё.
 */
(() => {
  const SEEN = 'station.pc.seenVersion';
  const DATA = 'radio.v1'; // общее хранилище станции (app.js)

  // Была ли станция раньше — фиксируем ДО того, как app.js что-то сохранит
  let hadData = false;
  try {
    hadData = Boolean(localStorage.getItem(DATA) || localStorage.getItem('station.pc.look'));
  } catch {
    hadData = false;
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const changelog = () => (Array.isArray(window.WALKIE_CHANGELOG) ? window.WALKIE_CHANGELOG : []);
  const currentVersion = () => changelog()[0]?.ver || '';
  const verNum = (v) => {
    const p = String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
    return (p[0] || 0) * 1e6 + (p[1] || 0) * 1e3 + (p[2] || 0);
  };

  function inline(text) {
    const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return esc.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  }

  function showPlate(version, groups, heading) {
    const wrap = el('div', 'wn');
    const card = el('div', 'wn__card');
    const head = el('div', 'wn__head');
    const many = groups.length > 1;
    head.innerHTML = heading
      ? `<span>📋</span><b>${inline(heading)}</b>`
      : `<span>✨</span><b>Станция обновлена до ${inline(version)}</b>${many ? `<i class="wn__span">за ${groups.length} версий</i>` : ''}`;
    const list = el('ul', 'wn__list');
    list.innerHTML = groups.map((g) =>
      (many ? `<li class="wn__ver">${inline(g.ver)}</li>` : '')
      + g.items.map((it) => `<li class="${it.level ? 'is-sub' : ''}">${inline(it.text)}</li>`).join(''),
    ).join('');
    const ok = el('button', 'wn__ok', 'Понятно');
    ok.type = 'button';
    const close = () => { wrap.classList.add('is-out'); setTimeout(() => wrap.remove(), 250); };
    ok.addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    card.append(head, list, ok);
    wrap.append(card);
    document.body.append(wrap);
  }

  function openChangelog() {
    const groups = changelog().filter((g) => Array.isArray(g.items) && g.items.length);
    showPlate(currentVersion(), groups.length ? groups : [{ ver: currentVersion(), items: [{ level: 0, text: 'Список изменений пока пуст.' }] }], 'История изменений');
  }

  function whatsNew() {
    const cur = currentVersion();
    if (!cur) return;
    let seen = null;
    try {
      seen = localStorage.getItem(SEEN);
    } catch {
      return;
    }
    if (seen === cur) return;
    const store = () => {
      try { localStorage.setItem(SEEN, cur); } catch { /* покажем ещё раз */ }
    };
    if (!seen && !hadData) { store(); return; }
    const seenN = seen ? verNum(seen) : -1;
    const groups = changelog().filter((g) => Array.isArray(g.items) && g.items.length
      && (seenN < 0 ? g.ver === cur : verNum(g.ver) > seenN));
    store();
    if (groups.length) showPlate(cur, groups);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const ver = document.getElementById('version');
    if (ver && currentVersion()) ver.textContent = `Радио · версия ${currentVersion()}`;
    const updVer = document.getElementById('upd-ver');
    if (updVer && currentVersion()) updVer.textContent = `версия ${currentVersion()}`;
    const log = document.getElementById('upd-log');
    if (log) log.addEventListener('click', openChangelog);
    const lookBtn = document.getElementById('upd-look');
    if (lookBtn) lookBtn.addEventListener('click', () => window.StationLook?.open());
    setTimeout(whatsNew, 1200);
  });

  window.StationUpdates = { openChangelog };
})();
