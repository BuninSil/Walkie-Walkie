'use strict';

/*
 * Анонимность, как у настоящей рации (⚙ на рации):
 *   • Позывной — постоянный или случайный на каждый запуск (ЛИС-47, ГРОМ-12…).
 *   • Ключ канала (SCR) — ручной ввод или случайный ключ одной кнопкой. Ключ не идёт через интернет:
 *     его говорят или показывают лично. (На ПК сканировать QR нечем — только ручной ввод.)
 *   • Голос в эфире — исказитель (voice.js).
 * Грузится до скриптов рации: случайный позывной подставляется в её настройки до запуска.
 * Снаружи: window.WalkiePrivacy.sections(rerender) — разделы для панели настроек (pc-panel.js).
 */
(() => {
  const STORE = 'radio.widget.v1';  // настройки рации (widget.js)
  const APP_STORE = 'radio.v1';     // связка ключей SCR (widget.js)
  const KEY = 'walkie.callsign';
  const WORDS = ['ЛИС', 'ГРОМ', 'ВОЛК', 'КЕДР', 'БЕРКУТ', 'ТАЙФУН', 'ЯСТРЕБ', 'КОРСАР', 'ФАНТОМ', 'ШТОРМ', 'СОКОЛ', 'РЫСЬ',
    'ГРАНИТ', 'ОМЕГА', 'ТУМАН', 'СЕВЕР', 'БУРАН', 'ВЕТЕР', 'ДОЗОР', 'КОБРА', 'РУБИН', 'ОРЁЛ', 'ФИЛИН', 'ГЮРЗА', 'КАСКАД',
    'ВИХРЬ', 'ЗУБР', 'КРЕМЕНЬ', 'ПАМИР', 'ИРБИС'];
  const KEY_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих 0/O, 1/I/L

  const load = (k) => {
    try {
      return JSON.parse(localStorage.getItem(k)) || {};
    } catch {
      return {};
    }
  };
  const store = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* не запомним */
    }
  };
  const rand = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

  // Была ли уже рация на этом компьютере — проверяем ДО того, как рация (widget.js) сохранит своё
  // состояние. Нужно для плашки «Что нового»: на самом первом запуске её показывать не надо.
  try {
    if (window.__walkieHadData === undefined) window.__walkieHadData = Boolean(localStorage.getItem(STORE));
  } catch {
    window.__walkieHadData = false;
  }

  function randomName() {
    return `${WORDS[rand(WORDS.length)]}-${10 + rand(90)}`;
  }

  function randomKey() {
    let s = '';
    for (let i = 0; i < 16; i++) s += KEY_CHARS[rand(KEY_CHARS.length)] + (i % 4 === 3 && i < 15 ? '-' : '');
    return s;
  }

  /* ───────── Позывной: случайный подставляем до запуска рации ───────── */

  const callsign = load(KEY); // { mode: 'fixed' | 'random', fixed, current }
  if (callsign.mode === 'random') {
    const st = load(STORE);
    st.cfg = st.cfg || {};
    callsign.current = randomName();
    st.cfg.name = callsign.current;
    store(STORE, st);
    store(KEY, callsign);
  }

  const w = () => window.radioWidget;
  const busy = () => Boolean(w()?.tx?.active);

  // Поменять настройку рации и перезапустить её (секунда — и снова на связи)
  function applyAndRestart(change) {
    const r = w();
    const st = load(STORE);
    st.cfg = st.cfg || {};
    Object.assign(st.cfg, change);
    if (r) Object.assign(r.cfg, change); // её собственное сохранение запишет то же самое
    store(STORE, st);
    setTimeout(() => location.reload(), 150);
  }

  function setCallsignMode(mode) {
    if (busy()) return 'Отпустите PTT';
    if (mode === 'random') {
      if (callsign.mode !== 'random') callsign.fixed = w()?.cfg?.name || callsign.fixed || 'РАЦИЯ';
      callsign.mode = 'random';
      callsign.current = randomName();
      store(KEY, callsign);
      applyAndRestart({ name: callsign.current });
    } else {
      callsign.mode = 'fixed';
      store(KEY, callsign);
      applyAndRestart({ name: callsign.fixed || w()?.cfg?.name || 'РАЦИЯ' });
    }
    return null;
  }

  /* ───────── Ключ SCR ───────── */

  const currentKey = () => (w()?.cfg?.scr || '').trim().toUpperCase();

  function setKey(key) {
    if (busy()) return 'Отпустите PTT';
    const k = String(key || '').trim().toUpperCase();
    if (k) {
      const app = load(APP_STORE);
      app.keys = [...new Set([...(Array.isArray(app.keys) ? app.keys : []), k])];
      store(APP_STORE, app);
    }
    applyAndRestart({ scr: k });
    return null;
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const button = (cls, text, onClick) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  // Окно поверх настроек: подтверждение, ручной ввод
  let modal = null;
  function showModal(build) {
    closeModal();
    modal = el('div', 'pv-modal');
    const box = el('div', 'pv-modal__box');
    build(box);
    modal.append(box);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    document.body.append(modal);
  }
  function closeModal() {
    modal?.remove();
    modal = null;
  }

  function confirmKey(key, title) {
    showModal((box) => {
      box.append(el('h3', null, title));
      box.append(el('p', 'pv-key', key));
      box.append(el('p', 'pv-note', 'Включить этот ключ на передачу и приём? Рация перезапустится на секунду. Слышно будет только тех, у кого такой же ключ.'));
      const row = el('div', 'pv-row');
      row.append(button('pv-btn', 'Отмена', closeModal), button('pv-btn pv-btn--main', 'Включить', () => {
        const err = setKey(key);
        if (err) note(err);
        else closeModal();
      }));
      box.append(row);
    });
  }

  // Ручной ввод ключа (как в дефолтной версии) — вместо QR
  function enterKey() {
    showModal((box) => {
      box.append(el('h3', null, 'Ключ канала'));
      box.append(el('p', 'pv-note', 'Введите ключ, который вам назвали. Один и тот же ключ должен быть у всех в группе.'));
      const inp = el('input', 'pv-input');
      inp.type = 'text';
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.maxLength = 64;
      inp.value = currentKey();
      inp.placeholder = 'например ГРОЗА-2024';
      box.append(inp);
      const row = el('div', 'pv-row');
      row.append(button('pv-btn', 'Отмена', closeModal), button('pv-btn pv-btn--main', 'Включить', () => {
        const err = setKey(inp.value);
        if (err) note(err);
        else closeModal();
      }));
      box.append(row);
      setTimeout(() => inp.focus(), 30);
    });
  }

  let noteText = null;
  let rerenderPanel = () => {};
  function note(text) {
    noteText = text;
    rerenderPanel();
    setTimeout(() => {
      noteText = null;
      rerenderPanel();
    }, 2500);
  }

  /* ───────── Разделы для ⚙ ───────── */

  let showKey = false;
  let previewState = null;

  function seg(options, value, onPick) {
    const s = el('div', 'pv-seg');
    for (const [id, name] of options) {
      const b = button(null, name, () => onPick(id));
      b.setAttribute('aria-pressed', String(value === id));
      s.append(b);
    }
    return s;
  }

  function sections(rerender) {
    rerenderPanel = rerender;
    const out = [];
    const cfg = w()?.cfg || {};

    const sec = el('section', 'wk-sec pv');
    sec.append(el('h3', null, 'Анонимность'));
    if (noteText) sec.append(el('p', 'pv-warn', noteText));

    // Позывной
    const mode = callsign.mode === 'random' ? 'random' : 'fixed';
    const cs = el('div', 'pv-item');
    const head = el('div', 'pv-item__head');
    head.append(el('span', null, 'Позывной'), el('b', 'pv-value', cfg.name || '—'));
    cs.append(head, seg([['fixed', 'Постоянный'], ['random', 'Случайный']], mode, (m) => {
      if (m === mode) return;
      const err = setCallsignMode(m);
      if (err) note(err);
    }));
    cs.append(el('small', 'pv-hint', mode === 'random'
      ? 'Новый при каждом запуске рации — позывной не привязан к вам.'
      : 'Меняется в меню рации: MENU → 11 NAME.'));
    if (mode === 'random') {
      cs.append(button('pv-btn', '🎲 Другой позывной сейчас', () => {
        const err = setCallsignMode('random');
        if (err) note(err);
      }));
    }
    sec.append(cs);

    // Ключ канала — ручной ввод (без QR)
    const key = currentKey();
    const kc = el('div', 'pv-item');
    const kh = el('div', 'pv-item__head');
    const shown = key ? (showKey ? key : '•'.repeat(Math.min(key.length, 12))) : 'выключен';
    const kv = el('b', 'pv-value' + (key ? ' pv-value--key' : ''), shown);
    if (key) kv.addEventListener('click', () => { showKey = !showKey; rerender(); });
    kh.append(el('span', null, 'Ключ канала (SCR)'), kv);
    kc.append(kh);
    const kb = el('div', 'pv-btns');
    kb.append(button('pv-btn', '⌨ Ввести ключ', () => enterKey()));
    kb.append(button('pv-btn', '🎲 Случайный ключ', () => confirmKey(randomKey(), 'Новый случайный ключ')));
    if (key) {
      kb.append(button('pv-btn pv-btn--ghost', 'Выключить', () => {
        const err = setKey('');
        if (err) note(err);
      }));
    }
    kc.append(kb);
    kc.append(el('small', 'pv-hint', key
      ? 'Голос шифруется этим ключом. Нажмите на точки, чтобы увидеть ключ.'
      : 'Без ключа эфир слышат все на канале. Назовите ключ голосом при встрече — он не идёт через интернет.'));
    sec.append(kc);

    // Голос
    const v = window.WalkieVoice;
    if (v) {
      const vc = el('div', 'pv-item');
      const vh = el('div', 'pv-item__head');
      const cur = v.PRESETS[v.get()];
      vh.append(el('span', null, 'Голос в эфире'), el('b', 'pv-value', cur.name));
      vc.append(vh);
      const grid = el('div', 'pv-voices');
      for (const [id, p] of Object.entries(v.PRESETS)) {
        const b = button('pv-voice', null, () => {
          v.set(id);
          rerender();
        });
        b.append(el('b', null, p.name), el('small', null, p.note));
        b.setAttribute('aria-pressed', String(v.get() === id));
        grid.append(b);
      }
      vc.append(grid);
      const label = previewState === 'play' ? '🔊 Слушайте…'
        : typeof previewState === 'number' ? `🎙 Говорите… ${previewState}`
          : previewState === 'error' ? 'Нет доступа к микрофону' : '▶ Проверить: запишу 3 с и дам послушать';
      const pb = button('pv-btn pv-btn--wide', label, () => {
        v.preview((s, n) => {
          previewState = s === 'rec' ? n : s === 'done' ? null : s;
          rerender();
          if (s === 'error') setTimeout(() => { previewState = null; rerender(); }, 2500);
        });
      });
      pb.disabled = previewState != null && previewState !== 'error';
      vc.append(pb);
      vc.append(el('small', 'pv-hint', 'Голос меняется на этом компьютере до отправки — в эфир уходит уже изменённый.'));
      sec.append(vc);
    }
    out.push(sec);
    return out;
  }

  window.WalkiePrivacy = { sections, randomKey, randomName };
})();
