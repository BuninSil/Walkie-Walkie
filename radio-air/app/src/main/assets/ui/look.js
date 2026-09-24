'use strict';

/*
 * Внешний вид станции: темы, акцент, дисплей (стиль, цвет цифр, фон, узор, свечение),
 * фон приложения, шрифты, сброс. Настройки — в localStorage, свои картинки — в IndexedDB.
 * Снаружи: window.StationLook.open().
 */
(() => {
  const KEY = 'station.look';
  const root = document.documentElement;

  const DEFAULTS = {
    accent: '#ffb547', digits: '#5ef0c4', disp: 'classic', lcd: '#c6d6b2', pattern: 'none',
    dispBg: 'none', dispTint: 55, glow: false, glowLevel: 0.7,
    bg: 'dark', bgColor: '#0b0c0f', bgDim: 40,
    fontDisp: 'default', fontUi: 'default',
  };

  const DISP_STYLES = { classic: 'Классика', oled: 'OLED', crt: 'ЭЛТ', glass: 'Стекло', lcd: 'Светлый ЖК' };
  const PATTERNS = { none: 'Нет', dots: 'Точки', grid: 'Сетка', scan: 'Строки' };

  const COLORS = {
    accent: ['#ffb547', '#ff9a3c', '#ffd23c', '#4cd2ff', '#6ee06e', '#ff5a4c', '#b86bff', '#ff2bd6', '#ecebe6'],
    digits: ['#5ef0c4', '#ffb000', '#7fdcff', '#ff6b6b', '#39ff88', '#f2f2f2', '#d5b8ff', '#ff2bd6', '#c8ff00'],
    lcd: ['#c6d6b2', '#ffcf7a', '#b8e3f5', '#eef0ea', '#ffb0a6', '#d5e8a8'],
    bg: ['#0b0c0f', '#000000', '#141a24', '#121a14', '#1c1214', '#1a1a1a'],
  };

  const DISP_BACKGROUNDS = {
    none: { name: 'Без фона', css: null },
    sky: { name: 'Небо', css: 'linear-gradient(180deg, #7fc4ff 0%, #d9efff 70%, #ffffff 100%)' },
    sunset: { name: 'Закат', css: 'linear-gradient(160deg, #ffb36b 0%, #ff6f91 55%, #845ec2 100%)' },
    sea: { name: 'Море', css: 'linear-gradient(180deg, #05bfdb 0%, #088395 50%, #0a4d68 100%)' },
    aurora: { name: 'Сияние', css: 'radial-gradient(ellipse at 20% 0%, #5cffb0 0%, transparent 55%), radial-gradient(ellipse at 90% 30%, #b86bff 0%, transparent 55%), linear-gradient(180deg, #0b1d2e, #06121c)' },
    stars: { name: 'Звёзды', css: 'radial-gradient(1px 1px at 12% 22%, #fff, transparent), radial-gradient(1px 1px at 38% 70%, #fff, transparent), radial-gradient(1.5px 1.5px at 66% 30%, #cfe6ff, transparent), radial-gradient(1px 1px at 85% 75%, #fff, transparent), radial-gradient(1px 1px at 52% 12%, #fff, transparent), radial-gradient(ellipse at 70% 90%, #2b1a55, transparent 60%), #070a18' },
    circuit: { name: 'Плата', css: 'linear-gradient(90deg, rgba(180, 255, 200, 0.35) 1px, transparent 1px) 0 0 / 18px 18px, linear-gradient(rgba(180, 255, 200, 0.35) 1px, transparent 1px) 0 0 / 18px 18px, radial-gradient(circle, #d9ffe5 1.5px, transparent 2px) 9px 9px / 18px 18px, #0f5132' },
    vinyl: { name: 'Винил', css: 'repeating-radial-gradient(circle at 85% 50%, #111 0 2px, #1c1c1c 2px 4px), #111' },
    waves: { name: 'Волны', css: 'repeating-radial-gradient(circle at 0% 100%, #4cc9f0 0 6px, #4361ee 6px 12px, #3a0ca3 12px 18px)' },
    carbon: { name: 'Карбон', css: 'repeating-linear-gradient(45deg, #1c1c20 0 3px, #26262b 3px 6px)' },
    image: { name: 'Своя картинка', css: null },
  };

  const BACKGROUNDS = {
    dark: { name: 'Тёмный', css: '#0b0c0f' },
    graphite: { name: 'Графит', css: 'linear-gradient(180deg, #1c1d22, #0c0d10)' },
    night: { name: 'Ночь', css: 'radial-gradient(ellipse at 50% 0%, #1d2636 0%, #0a0d13 70%)' },
    forest: { name: 'Хвоя', css: 'radial-gradient(ellipse at 50% 0%, #1d2a21 0%, #0a0f0b 70%)' },
    wine: { name: 'Бордо', css: 'radial-gradient(ellipse at 50% 0%, #2a1a1d 0%, #0f0a0b 70%)' },
    carbon: { name: 'Карбон', css: 'repeating-linear-gradient(45deg, #111113 0 4px, #17171a 4px 8px)' },
    color: { name: 'Свой цвет', css: null },
    image: { name: 'Своя картинка', css: null },
  };

  const FONTS = {
    default: { name: 'Стандарт', family: null, sample: '100.0' },
    mono: { name: 'Моно', family: "'WK Mono', monospace", sample: '100.0' },
    seg7: { name: 'Сегменты', family: "'WK Seg7', 'WK Mono', monospace", sample: '100.0' },
    techno: { name: 'Техно', family: "'WK Techno', sans-serif", sample: 'Аа 12' },
    heavy: { name: 'Жирный', family: "'WK Heavy', sans-serif", sample: 'Аа 12' },
  };
  const DISP_FONTS = ['default', 'mono', 'seg7', 'techno'];
  const UI_FONTS = ['default', 'techno', 'heavy', 'mono'];

  const THEMES = {
    classic: { name: 'Классика', sw: ['#ffb547', '#5ef0c4'], set: {} },
    amber: { name: 'Янтарь', sw: ['#ff9a3c', '#ffb000'], set: { accent: '#ff9a3c', digits: '#ffb000', glow: true } },
    ice: { name: 'Лёд', sw: ['#4cd2ff', '#7fdcff'], set: { accent: '#4cd2ff', digits: '#7fdcff', bg: 'night' } },
    ruby: { name: 'Рубин', sw: ['#ff5a4c', '#ff6b6b'], set: { accent: '#ff5a4c', digits: '#ff6b6b', bg: 'wine' } },
    emerald: { name: 'Изумруд', sw: ['#6ee06e', '#39ff88'], set: { accent: '#6ee06e', digits: '#39ff88', bg: 'forest', pattern: 'scan' } },
    mono: { name: 'Монохром', sw: ['#ecebe6', '#f2f2f2'], set: { accent: '#ecebe6', digits: '#f2f2f2', disp: 'oled', bg: 'carbon' } },
    lcdGreen: { name: 'Ламповый ЖК', sw: ['#ffb547', '#c6d6b2'], set: { disp: 'lcd', lcd: '#c6d6b2', pattern: 'dots', fontDisp: 'seg7' } },
    lcdBlue: { name: 'Синий ЖК', sw: ['#4cd2ff', '#b8e3f5'], set: { accent: '#4cd2ff', disp: 'lcd', lcd: '#b8e3f5', pattern: 'dots', bg: 'night' } },
    night: { name: 'Ночной эфир', sw: ['#b86bff', '#d5b8ff'], set: { accent: '#b86bff', digits: '#d5b8ff', disp: 'crt', glow: true, bg: 'night' } },
  };

  function load() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      /* по умолчанию */
    }
    const l = { ...DEFAULTS, ...saved };
    if (!DISP_STYLES[l.disp]) l.disp = 'classic';
    if (!PATTERNS[l.pattern]) l.pattern = 'none';
    if (!DISP_BACKGROUNDS[l.dispBg]) l.dispBg = 'none';
    if (!BACKGROUNDS[l.bg]) l.bg = 'dark';
    if (!DISP_FONTS.includes(l.fontDisp)) l.fontDisp = 'default';
    if (!UI_FONTS.includes(l.fontUi)) l.fontUi = 'default';
    return l;
  }

  let look = load();
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(look));
    } catch {
      /* не запомним */
    }
  };

  /* ───────── Картинки (IndexedDB) ───────── */

  const images = {};
  const urls = {};
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('station-look', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function imageGet(name) {
    try {
      const d = await db();
      return await new Promise((resolve) => {
        const r = d.transaction('images').objectStore('images').get(name);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }
  async function imageSet(name, value) {
    try {
      const d = await db();
      await new Promise((resolve) => {
        const tx = d.transaction('images', 'readwrite');
        if (value) tx.objectStore('images').put(value, name);
        else tx.objectStore('images').delete(name);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch {
      /* картинка будет до перезапуска */
    }
  }
  function refreshUrls() {
    for (const name of ['bg', 'disp']) {
      if (urls[name]) URL.revokeObjectURL(urls[name]);
      urls[name] = null;
      const data = images[name];
      if (!data) continue;
      const [head, body] = data.split(',');
      const bytes = atob(body);
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      urls[name] = URL.createObjectURL(new Blob([buf], { type: /data:([^;]+)/.exec(head)?.[1] || 'image/jpeg' }));
    }
  }
  function pickImage(maxSide) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, maxSide / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k);
          c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = () => resolve(null);
        img.src = url;
      };
      input.click();
    });
  }

  /* ───────── Цвета ───────── */

  const hex = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
  const shade = (h, k) => toHex(hex(h).map((v) => (k >= 0 ? v + (255 - v) * k : v * (1 + k))));
  const mix = (a, b, k) => {
    const x = hex(a);
    const y = hex(b);
    return toHex(x.map((v, i) => v + (y[i] - v) * k));
  };
  const rgba = (h, a) => `rgba(${hex(h).join(', ')}, ${a})`;

  /* ───────── Применение ───────── */

  const style = document.createElement('style');

  function apply() {
    const v = {};
    v['--amber'] = look.accent;
    v['--orange'] = shade(look.accent, -0.08);

    const light = look.disp === 'lcd';
    const digits = light ? '#152013' : look.digits;
    v['--teal'] = digits;
    v['--teal-dim'] = rgba(digits, light ? 0.12 : 0.18);
    let base;
    if (light) {
      base = look.lcd;
      v['--disp-bg'] = `linear-gradient(180deg, ${look.lcd}, ${shade(look.lcd, -0.13)})`;
      v['--disp-edge'] = shade(look.lcd, -0.45);
      v['--disp-ink-mix'] = '#000000';
    } else if (look.disp === 'oled') {
      base = '#000000';
      v['--disp-bg'] = '#000';
      v['--disp-edge'] = mix('#000000', look.digits, 0.2);
    } else {
      base = mix('#050807', look.digits, 0.08);
      v['--disp-bg'] = `radial-gradient(ellipse at 30% 0%, ${mix('#050807', look.digits, 0.14)}, ${mix('#030504', look.digits, 0.04)} 70%)`;
      v['--disp-edge'] = mix('#0b0c0f', look.digits, 0.22);
    }
    v['--disp-base'] = base;
    v['--disp-tint'] = String(look.dispTint);
    v['--glow'] = String(look.glowLevel);

    const df = FONTS[look.fontDisp];
    if (df?.family) v['--mono'] = df.family;
    const uf = FONTS[look.fontUi];
    if (uf?.family) v['--ui-font'] = uf.family;

    if (look.bg === 'color') v['--app-bg'] = look.bgColor;
    else if (look.bg === 'image' && urls.bg) {
      const dim = look.bgDim / 100;
      v['--app-bg'] = `linear-gradient(rgba(0, 0, 0, ${dim}), rgba(0, 0, 0, ${dim})), url("${urls.bg}") center / cover no-repeat, #000`;
    } else v['--app-bg'] = (BACKGROUNDS[look.bg] || BACKGROUNDS.dark).css || '#0b0c0f';

    const dispImg = look.dispBg === 'image' ? (urls.disp ? `url("${urls.disp}") center / cover` : null) : DISP_BACKGROUNDS[look.dispBg]?.css;
    if (dispImg) v['--disp-image'] = dispImg;

    style.textContent = `html:root { ${Object.entries(v).map(([k, x]) => `${k}: ${x};`).join(' ')} }`;
    root.dataset.disp = look.disp;
    root.dataset.pattern = look.pattern;
    if (look.glow) root.dataset.glow = '';
    else delete root.dataset.glow;
    if (dispImg) root.dataset.dispImage = '';
    else delete root.dataset.dispImage;
    save();
  }

  function set(change) {
    look = { ...look, ...change };
    apply();
    render();
  }

  /* ───────── Редактор ───────── */

  const TABS = [['themes', 'Темы'], ['display', 'Дисплей'], ['colors', 'Цвета'], ['bg', 'Фон'], ['fonts', 'Шрифты']];
  let tab = 'themes';
  let panel = null;
  let body = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function option(label, pressed, onClick, sw, extra) {
    const b = el('button', `lk__opt${extra ? ` ${extra}` : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(Boolean(pressed)));
    if (sw !== undefined) {
      const i = el('i');
      i.style.setProperty('--sw', sw);
      b.append(i);
    }
    b.append(el('span', null, label));
    b.addEventListener('click', onClick);
    return b;
  }

  function choices(title, map, key) {
    const f = document.createDocumentFragment();
    f.append(el('h3', null, title));
    const grid = el('div', 'lk__grid');
    for (const [id, name] of Object.entries(map)) grid.append(option(name, look[key] === id, () => set({ [key]: id })));
    f.append(grid);
    return f;
  }

  function colors(title, key, palette) {
    const f = document.createDocumentFragment();
    f.append(el('h3', null, title));
    const grid = el('div', 'lk__grid lk__grid--colors');
    for (const c of palette) grid.append(option('', look[key].toLowerCase() === c, () => set({ [key]: c }), c, 'lk__opt--color'));
    const custom = option('', !palette.includes(look[key].toLowerCase()), () => {}, '', 'lk__opt--color lk__custom');
    const input = el('input');
    input.type = 'color';
    input.value = look[key];
    input.addEventListener('input', () => set({ [key]: input.value }));
    custom.append(input);
    grid.append(custom);
    f.append(grid);
    return f;
  }

  function slider(label, key, min, max, step) {
    const row = el('label', 'lk__row');
    row.append(el('span', null, label));
    const r = el('input');
    r.type = 'range';
    Object.assign(r, { min: String(min), max: String(max), step: String(step), value: String(look[key]) });
    r.addEventListener('input', () => {
      look = { ...look, [key]: Number(r.value) };
      apply();
    });
    row.append(r);
    return row;
  }

  function toggle(label, key) {
    const row = el('div', 'lk__row');
    row.append(el('span', null, label));
    const b = el('button', 'wk-switch');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(Boolean(look[key])));
    b.append(el('span'));
    b.addEventListener('click', () => set({ [key]: !look[key] }));
    row.append(b);
    return row;
  }

  function fonts(title, key, ids) {
    const f = document.createDocumentFragment();
    f.append(el('h3', null, title));
    const grid = el('div', 'lk__grid');
    for (const id of ids) {
      const ft = FONTS[id];
      const b = option(ft.name, look[key] === id, () => set({ [key]: id }));
      const sample = el('b', null, ft.sample);
      if (ft.family) sample.style.fontFamily = ft.family;
      b.prepend(sample);
      grid.append(b);
    }
    f.append(grid);
    return f;
  }

  function imageButtons(name, onPick, maxSide, onDrop) {
    const row = el('div', 'lk__row');
    const pick = el('button', 'lk__btn lk__btn--accent', images[name] ? 'Другая картинка' : 'Выбрать из галереи');
    pick.type = 'button';
    pick.addEventListener('click', async () => {
      const data = await pickImage(maxSide);
      if (!data) return;
      images[name] = data;
      refreshUrls();
      await imageSet(name, data);
      set(onPick);
    });
    row.append(pick);
    if (images[name]) {
      const del = el('button', 'lk__btn lk__btn--danger', 'Убрать');
      del.type = 'button';
      del.addEventListener('click', async () => {
        delete images[name];
        refreshUrls();
        await imageSet(name, null);
        set(onDrop);
      });
      row.append(del);
    }
    return row;
  }

  function renderTab() {
    const f = document.createDocumentFragment();
    switch (tab) {
      case 'themes': {
        f.append(el('h3', null, 'Готовые темы'));
        const grid = el('div', 'lk__grid');
        for (const [id, t] of Object.entries(THEMES)) {
          grid.append(option(t.name, false, () => set({ ...DEFAULTS, ...THEMES[id].set }), `linear-gradient(135deg, ${t.sw[0]} 50%, ${t.sw[1]} 50%)`, 'lk__opt--theme'));
        }
        f.append(grid);
        f.append(el('p', 'lk__note', 'Тема — готовый набор цветов. Дальше можно подстроить всё на других вкладках.'));
        break;
      }
      case 'display': {
        f.append(choices('Стиль дисплея', DISP_STYLES, 'disp'));
        if (look.disp === 'lcd') f.append(colors('Подсветка ЖК', 'lcd', COLORS.lcd));
        else f.append(colors('Цвет цифр', 'digits', COLORS.digits));
        f.append(el('h3', null, 'Фон дисплея'));
        const grid = el('div', 'lk__grid');
        for (const [id, b] of Object.entries(DISP_BACKGROUNDS)) {
          if (id === 'image' && !urls.disp) continue;
          const sw = id === 'image' ? `url("${urls.disp}") center / cover` : b.css || 'linear-gradient(135deg, #3a3b42, #1a1b1f)';
          grid.append(option(b.name, look.dispBg === id, () => set({ dispBg: id }), sw));
        }
        f.append(grid);
        f.append(imageButtons('disp', { dispBg: 'image' }, 900, { dispBg: 'none' }));
        if (look.dispBg !== 'none') f.append(slider('Подложка под цифрами', 'dispTint', 0, 90, 5));
        f.append(choices('Узор', PATTERNS, 'pattern'));
        f.append(toggle('Мягкое свечение', 'glow'));
        if (look.glow) f.append(slider('Сила свечения', 'glowLevel', 0.2, 1.5, 0.1));
        break;
      }
      case 'colors':
        f.append(colors('Акцент: кнопки, шкала, переключатели', 'accent', COLORS.accent));
        if (look.disp !== 'lcd') f.append(colors('Цифры на дисплее', 'digits', COLORS.digits));
        break;
      case 'bg': {
        f.append(el('h3', null, 'Фон приложения'));
        const grid = el('div', 'lk__grid');
        for (const [id, b] of Object.entries(BACKGROUNDS)) {
          if (id === 'image' && !urls.bg) continue;
          const sw = id === 'color' ? look.bgColor : id === 'image' ? `url("${urls.bg}") center / cover` : b.css;
          grid.append(option(b.name, look.bg === id, () => set({ bg: id }), sw));
        }
        f.append(grid);
        if (look.bg === 'color') f.append(colors('Цвет фона', 'bgColor', COLORS.bg));
        f.append(el('h3', null, 'Своя картинка'));
        f.append(imageButtons('bg', { bg: 'image' }, 1280, { bg: 'dark' }));
        if (look.bg === 'image') f.append(slider('Затемнение', 'bgDim', 0, 85, 5));
        break;
      }
      case 'fonts':
        f.append(fonts('Шрифт дисплея', 'fontDisp', DISP_FONTS));
        f.append(fonts('Шрифт интерфейса', 'fontUi', UI_FONTS));
        break;
      default:
        break;
    }
    return f;
  }

  function render() {
    if (!panel || panel.hidden) return;
    for (const b of panel.querySelectorAll('.lk__tabs button')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    const scroll = body.scrollTop;
    body.replaceChildren(renderTab());
    body.scrollTop = scroll;
  }

  function build() {
    panel = el('div', 'lk');
    panel.hidden = true;
    const preview = el('div', 'lk__preview');
    preview.addEventListener('click', () => open(false));
    const sheet = el('div', 'lk__sheet');
    const head = el('div', 'lk__head');
    head.append(el('h2', null, 'Внешний вид'));
    const resetBtn = el('button', 'lk__btn lk__btn--danger', 'Сбросить');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Вернуть станции вид по умолчанию? Свои картинки тоже удалятся.')) return;
      delete images.bg;
      delete images.disp;
      refreshUrls();
      await imageSet('bg', null);
      await imageSet('disp', null);
      set({ ...DEFAULTS });
    });
    const done = el('button', 'lk__btn lk__btn--accent', 'Готово');
    done.type = 'button';
    done.addEventListener('click', () => open(false));
    head.append(resetBtn, done);
    const tabs = el('div', 'lk__tabs');
    for (const [id, name] of TABS) {
      const b = el('button', null, name);
      b.type = 'button';
      b.dataset.tab = id;
      b.addEventListener('click', () => {
        tab = id;
        body.scrollTop = 0;
        render();
      });
      tabs.append(b);
    }
    body = el('div', 'lk__body');
    sheet.append(head, tabs, body);
    panel.append(preview, sheet);
    document.body.append(panel);
  }

  function open(show = true) {
    if (!panel) build();
    panel.hidden = !show;
    if (show) render();
  }

  document.head.append(style);
  apply();
  document.addEventListener('DOMContentLoaded', async () => {
    const btn = document.getElementById('look-btn');
    if (btn) btn.addEventListener('click', () => open());
    images.bg = await imageGet('bg');
    images.disp = await imageGet('disp');
    refreshUrls();
    apply();
  });

  window.StationLook = { open };
})();
