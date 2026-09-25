'use strict';

/*
 * Автообновление в интерфейсе (и рация, и станция). Работает только в установленном приложении
 * (Electron): main.js через electron-updater качает новую версию из релизов GitHub и сообщает сюда
 * состояние. Показываем плашку снизу и, когда обновление скачано, кнопку «Установить». На сайте и в
 * dev-режиме модуль тихо ничего не делает.
 * Снаружи: window.RadioUpdater { get, check, install, setAuto, onChange, state }.
 */
(() => {
  const desktop = window.radioDesktop;
  let state = { state: 'idle', version: null, percent: 0, message: null };
  let auto = true;
  const listeners = new Set();

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const emit = () => { for (const cb of listeners) { try { cb(state); } catch { /* пусто */ } } };

  // Версию показываем без служебного ярлыка канала: 0.2.3-walkie.0 → 0.2.3
  const cleanVer = (v) => String(v || '').replace(/-walkie\.\d+$/, '');

  /* ───────── Плашка снизу ───────── */

  let banner = null;
  let dismissed = false;

  function busy() {
    // Не перезапускать посреди передачи (рация) — установим при выходе или позже
    return Boolean(window.radioWidget?.tx?.active);
  }

  function ensureStyles() {
    if (document.getElementById('ru-upd-style')) return;
    const s = el('style');
    s.id = 'ru-upd-style';
    s.textContent = `
      .ru-upd { position: fixed; left: 50%; bottom: 14px; z-index: 70; display: flex; align-items: center; gap: 10px;
        width: min(94vw, 440px); padding: 10px 10px 10px 14px; border: 1px solid color-mix(in srgb, var(--amber, #ffb547) 55%, #2c2d33);
        border-radius: 14px; background: rgba(24, 25, 29, 0.97); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        color: #ecebe6; font: 13px system-ui, 'Segoe UI', sans-serif; transform: translateX(-50%); animation: ru-in 0.2s ease-out; }
      @keyframes ru-in { from { opacity: 0; transform: translate(-50%, 10px); } }
      .ru-upd__text { flex: 1; display: grid; gap: 1px; min-width: 0; }
      .ru-upd__text b { font-size: 13.5px; }
      .ru-upd__text small { color: #8f8d86; font-size: 12px; }
      .ru-upd__go { flex: none; padding: 8px 12px; border: 0; border-radius: 10px; background: var(--amber, #ffb547); color: #151515; font: 700 13px system-ui, sans-serif; cursor: pointer; }
      .ru-upd__go:disabled { opacity: 0.6; }
      .ru-upd__x { flex: none; width: 30px; height: 30px; border: 0; border-radius: 50%; background: transparent; color: #8f8d86; font-size: 14px; cursor: pointer; }
      .ru-upd__bar { position: absolute; left: 0; bottom: 0; height: 3px; border-radius: 0 0 14px 14px; background: var(--amber, #ffb547); transition: width 0.3s; }
    `;
    document.head.append(s);
  }

  function renderBanner() {
    const s = state.state;
    const show = (s === 'downloading' || s === 'ready') && !dismissed;
    if (!show) { banner?.remove(); banner = null; return; }
    ensureStyles();
    if (!banner) {
      banner = el('div', 'ru-upd');
      document.body.append(banner);
    }
    banner.replaceChildren();
    const text = el('div', 'ru-upd__text');
    if (s === 'downloading') {
      text.append(el('b', null, state.version ? `Загрузка обновления ${cleanVer(state.version)}` : 'Загрузка обновления'),
        el('small', null, `${state.percent || 0}%`));
      banner.append(text);
      const bar = el('div', 'ru-upd__bar');
      bar.style.width = `${state.percent || 0}%`;
      banner.append(bar);
    } else {
      text.append(el('b', null, state.version ? `Обновление ${cleanVer(state.version)} готово` : 'Обновление готово'),
        el('small', null, busy() ? 'Идёт передача — установлю после' : 'Приложение перезапустится'));
      const go = el('button', 'ru-upd__go', 'Установить');
      go.type = 'button';
      go.disabled = busy();
      go.addEventListener('click', () => desktop.updaterInstall());
      const x = el('button', 'ru-upd__x', '✕');
      x.type = 'button';
      x.addEventListener('click', () => { dismissed = true; renderBanner(); });
      banner.append(text, go, x);
    }
  }

  /* ───────── Раздел «Обновления» на станции (index.html) ───────── */

  function wireStation() {
    const autoBtn = document.getElementById('upd-auto');
    const checkBtn = document.getElementById('upd-check');
    const ver = document.getElementById('upd-ver');

    const paint = () => {
      if (autoBtn) {
        autoBtn.setAttribute('aria-pressed', String(auto));
        autoBtn.textContent = auto ? '✓ Обновлять автоматически' : 'Обновлять автоматически';
      }
      if (ver) {
        const map = { checking: 'проверяю…', downloading: `загрузка ${state.percent || 0}%`, ready: 'готово к установке', none: 'актуальная версия', error: 'не удалось проверить' };
        const extra = map[state.state];
        const v = state.version ? `версия ${cleanVer(state.version)}` : '';
        ver.textContent = [v, extra].filter(Boolean).join(' · ');
      }
    };

    if (autoBtn) {
      autoBtn.addEventListener('click', async () => {
        auto = !(autoBtn.getAttribute('aria-pressed') === 'true');
        auto = await desktop.setAutoUpdate(auto);
        paint();
      });
    }
    if (checkBtn) {
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        await desktop.updaterCheck();
        setTimeout(() => { checkBtn.disabled = false; }, 3000);
      });
    }
    listeners.add(paint);
    paint();
  }

  /* ───────── Пуск ───────── */

  const api = {
    get: () => state,
    get state() { return state; },
    check: () => desktop?.updaterCheck(),
    install: () => desktop?.updaterInstall(),
    setAuto: async (on) => { auto = await desktop.setAutoUpdate(on); emit(); return auto; },
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    get auto() { return auto; },
  };
  window.RadioUpdater = api;

  if (!desktop || !desktop.onUpdaterStatus) return; // сайт или старая оболочка — молчим

  desktop.onUpdaterStatus((s) => {
    if (s && typeof s === 'object') {
      if (state.state !== s.state) dismissed = false; // новое состояние — плашку снова покажем
      state = s;
      renderBanner();
      emit();
    }
  });

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      auto = await desktop.autoUpdate();
      state = await desktop.updaterGet() || state;
    } catch {
      /* нет связи с оболочкой */
    }
    wireStation();
    renderBanner();
    emit();
  });
})();
