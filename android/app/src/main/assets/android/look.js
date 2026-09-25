'use strict';

/*
 * Внешний вид рации на телефоне: темы, корпус, кнопки, экран, фон, неон, шрифты.
 * Рация (widget.js/widget.css) не меняется: цвета уходят в её CSS-переменные, остальное —
 * атрибутами на <html> для look.css. Настройки — в localStorage, картинки — в IndexedDB.
 * Снаружи: window.WalkieLook.open() — редактор, .haptics — вибрация кнопок.
 */
(() => {
  const KEY = 'walkie.android.look2';
  const OLD_KEY = 'walkie.android.look'; // настройки первой версии (корпус, экран, надписи, вибрация)
  const root = document.documentElement;

  /* ───────── Что можно выбрать ───────── */

  const DEFAULTS = {
    finish: 'matte', body: '#26272b', keys: '#2e2f35',
    label: '#ecebe6', accent: '#ff9a3c', antenna: 'stock', antennaColor: '#2b2c31', knob: '#ff9a3c',
    lcdStyle: 'classic', lcd: '#c6d6b2', lcd2: '#8ad4ff', ink: 'auto', pattern: 'none', lcdBg: 'none', lcdTint: 55,
    bg: 'dark', bgColor: '#101114', bgImage: false, bgDim: 35,
    glow: false, glowLevel: 0.6,
    ledTx: '#ff3b2f', ledRx: '#37f06f',
    fontLcd: 'default', fontKeys: 'default',
    haptics: true,
  };

  const FINISHES = {
    matte: 'Матовый', gloss: 'Глянец', metal: 'Металл', carbon: 'Карбон', rubber: 'Резина',
    'skin-woodland': 'Камуфляж лес (эксп.)', 'skin-desert': 'Камуфляж пустыня (эксп.)',
    'skin-urban': 'Камуфляж город (эксп.)', 'skin-arctic': 'Камуфляж арктика (эксп.)',
    'skin-purple': 'Камуфляж фиолет (эксп.)', 'skin-red': 'Камуфляж красный (эксп.)',
  };

  // Фотоскины: фактура = готовый рендер корпуса и кнопок (skins/<цвет>_*.png). Живые элементы
  // (экран, кнопки, боковые, ручка) кладутся в вырезы — см. skins.css. Значение — префикс файлов.
  const SKINS = {
    'skin-woodland': 'woodland', 'skin-desert': 'desert', 'skin-urban': 'urban_gray',
    'skin-arctic': 'arctic', 'skin-purple': 'purple', 'skin-red': 'red',
  };
  const ANTENNAS = { stock: 'Родная', flat: 'Плоская', long: 'Длинная', tele: 'Телескоп', stubby: 'Короткая', off: 'Без антенны' };
  const LCD_STYLES = {
    classic: 'Классика', dark: 'Тёмный', oled: 'OLED', crt: 'ЭЛТ', glass: 'Стекло', gradient: 'Градиент',
  };
  const PATTERNS = { none: 'Нет', dots: 'Точки', grid: 'Сетка', scan: 'Строки', hex: 'Соты' };

  // Фоны экрана: поверх — полупрозрачная подсветка (ползунок), чтобы цифры читались
  const LCD_BACKGROUNDS = {
    none: { name: 'Без фона', css: null },
    sky: { name: 'Небо', css: 'linear-gradient(180deg, #7fc4ff 0%, #d9efff 70%, #ffffff 100%)' },
    sunset: { name: 'Закат', css: 'linear-gradient(160deg, #ffb36b 0%, #ff6f91 55%, #845ec2 100%)' },
    sea: { name: 'Море', css: 'linear-gradient(180deg, #05bfdb 0%, #088395 50%, #0a4d68 100%)' },
    mint: { name: 'Мята', css: 'linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)' },
    aurora: { name: 'Сияние', css: 'radial-gradient(ellipse at 20% 0%, #5cffb0 0%, transparent 55%), radial-gradient(ellipse at 90% 30%, #b86bff 0%, transparent 55%), linear-gradient(180deg, #0b1d2e, #06121c)' },
    stars: { name: 'Звёзды', css: 'radial-gradient(1px 1px at 12% 22%, #fff, transparent), radial-gradient(1px 1px at 38% 70%, #fff, transparent), radial-gradient(1.5px 1.5px at 66% 30%, #cfe6ff, transparent), radial-gradient(1px 1px at 85% 75%, #fff, transparent), radial-gradient(1px 1px at 52% 12%, #fff, transparent), radial-gradient(ellipse at 70% 90%, #2b1a55, transparent 60%), #070a18' },
    circuit: { name: 'Плата', css: 'linear-gradient(90deg, rgba(180, 255, 200, 0.35) 1px, transparent 1px) 0 0 / 18px 18px, linear-gradient(rgba(180, 255, 200, 0.35) 1px, transparent 1px) 0 0 / 18px 18px, radial-gradient(circle, #d9ffe5 1.5px, transparent 2px) 9px 9px / 18px 18px, #0f5132' },
    paper: { name: 'Бумага', css: 'repeating-linear-gradient(0deg, rgba(90, 70, 40, 0.08) 0 1px, transparent 1px 12px), linear-gradient(180deg, #f3ead6, #e6d8b8)' },
    carbon: { name: 'Карбон', css: 'repeating-linear-gradient(45deg, #1c1c20 0 3px, #26262b 3px 6px)' },
    waves: { name: 'Волны', css: 'repeating-radial-gradient(circle at 0% 100%, #4cc9f0 0 6px, #4361ee 6px 12px, #3a0ca3 12px 18px)' },
    camo: { name: 'Камуфляж', css: 'radial-gradient(40px 26px at 20% 25%, #3b4129 60%, transparent 62%) 0 0 / 110px 90px, radial-gradient(50px 30px at 70% 65%, #1f2416 60%, transparent 62%) 0 0 / 130px 100px, radial-gradient(36px 22px at 45% 80%, #6b6f45 60%, transparent 62%) 0 0 / 100px 80px, #4b5234' },
    image: { name: 'Своя картинка', css: null },
  };

  const COLORS = {
    body: ['#26272b', '#141417', '#d86b1c', '#4b5234', '#25324d', '#a38b5e', '#c9cbcf', '#6e1f23', '#2f3d33', '#3a3340'],
    keys: ['#2e2f35', '#1a1b1f', '#3b4129', '#2c3850', '#4a4234', '#3a3b40', '#4a1c1f'],
    label: ['#ecebe6', '#ffffff', '#c9c6be', '#ffd9a0'],
    accent: ['#ff9a3c', '#ffd23c', '#4cd2ff', '#6ee06e', '#ff5a4c', '#ecebe6'],
    lcd: ['#c6d6b2', '#ffcf7a', '#b8e3f5', '#eef0ea', '#ffb0a6', '#d5e8a8', '#d5b8ff', '#9bffc8', '#ffe08a'],
    glowLcd: ['#7dffb0', '#ffb000', '#5fd7ff', '#ecebe6', '#ff6f61', '#39ff14', '#ff2bd6', '#00e5ff', '#b86bff'],
    bg: ['#101114', '#000000', '#141a24', '#121a14', '#1c1214', '#1a1a1a'],
    led: ['#ff3b2f', '#37f06f', '#5fd7ff', '#ffb000', '#ffffff'],
    antenna: ['#2b2c31', '#121214', '#4b5234', '#8a7552', '#25324d', '#6e1f23'],
  };

  const BACKGROUNDS = {
    dark: { name: 'Тёмный', css: 'radial-gradient(ellipse at 50% 35%, #23252a 0%, #0d0e10 70%)' },
    graphite: { name: 'Графит', css: 'linear-gradient(180deg, #25272c, #121316)' },
    night: { name: 'Ночь', css: 'radial-gradient(ellipse at 50% 30%, #1d2636 0%, #0a0d13 75%)' },
    forest: { name: 'Хвоя', css: 'radial-gradient(ellipse at 50% 30%, #1d2a21 0%, #0a0f0b 75%)' },
    wine: { name: 'Бордо', css: 'radial-gradient(ellipse at 50% 30%, #2a1a1d 0%, #0f0a0b 75%)' },
    carbon: { name: 'Карбон', css: 'repeating-linear-gradient(45deg, #121214 0 4px, #18181b 4px 8px)' },
    color: { name: 'Свой цвет', css: null },
    image: { name: 'Своя картинка', css: null },
  };

  // Шрифты: семейство, масштаб крупных строк экрана, масштаб мелких
  const FONTS = {
    default: { name: 'Стандарт', family: null, fs: 1, small: 1, sample: 'Аа 12' },
    mono: { name: 'Моно', family: "'WK Mono', monospace", fs: 1, small: 1, sample: 'Аа 12' },
    seg7: { name: 'Сегменты', family: "'WK Seg7', 'WK Mono', monospace", fs: 0.92, small: 1, sample: '88.8' },
    techno: { name: 'Техно', family: "'WK Techno', sans-serif", fs: 1.02, small: 1.05, sample: 'Аа 12' },
    heavy: { name: 'Жирный', family: "'WK Heavy', sans-serif", fs: 0.96, small: 1, sample: 'Аа 12' },
  };
  const LCD_FONTS = ['default', 'mono', 'seg7', 'techno'];
  const KEY_FONTS = ['default', 'mono', 'techno', 'heavy'];

  // Темы — расцветки в родном стиле рации
  const THEMES = {
    classic: { name: 'Классика', sw: ['#26272b', '#c6d6b2'], set: {} },
    orange: { name: 'Оранжевая', sw: ['#d86b1c', '#c6d6b2'], set: { body: '#d86b1c', keys: '#26272b', accent: '#ffd23c', knob: '#26272b' } },
    olive: { name: 'Олива', sw: ['#4b5234', '#ffcf7a'], set: { body: '#4b5234', keys: '#3b4129', finish: 'rubber', lcd: '#ffcf7a', accent: '#ffd23c', knob: '#ffd23c', bg: 'forest' } },
    navy: { name: 'Синяя ночь', sw: ['#25324d', '#b8e3f5'], set: { body: '#25324d', keys: '#2c3850', lcd: '#b8e3f5', accent: '#4cd2ff', knob: '#4cd2ff', bg: 'night' } },
    sand: { name: 'Песок', sw: ['#a38b5e', '#ffcf7a'], set: { body: '#a38b5e', keys: '#4a4234', lcd: '#ffcf7a', accent: '#ff9a3c' } },
    white: { name: 'Белая', sw: ['#c9cbcf', '#b8e3f5'], set: { body: '#c9cbcf', keys: '#3a3b40', finish: 'gloss', lcd: '#b8e3f5', accent: '#1d9bf0', knob: '#1d9bf0', bg: 'graphite' } },
    desert: { name: 'Пустыня', sw: ['#c2a67a', '#c6d6b2'], set: { body: '#c2a67a', finish: 'desert', keys: '#2e2a24', label: '#f1e8d6', accent: '#ffb000', knob: '#ffb000', antenna: 'long', antennaColor: '#121214', bg: 'graphite' } },
    red: { name: 'Красная', sw: ['#6e1f23', '#eef0ea'], set: { body: '#6e1f23', keys: '#2e2f35', lcd: '#eef0ea', accent: '#ffd23c', bg: 'wine' } },
    carbon: { name: 'Карбон', sw: ['#141417', '#eef0ea'], set: { body: '#141417', keys: '#1a1b1f', finish: 'carbon', lcd: '#eef0ea', accent: '#ecebe6', knob: '#ecebe6', bg: 'carbon' } },
    nightGreen: { name: 'Ночной', sw: ['#141417', '#7dffb0'], set: { body: '#1c1d21', keys: '#1a1b1f', lcdStyle: 'dark', lcd: '#7dffb0', glow: true, accent: '#6ee06e', knob: '#6ee06e' } },
    nightAmber: { name: 'Ночной янтарь', sw: ['#141417', '#ffb000'], set: { body: '#1c1d21', keys: '#1a1b1f', lcdStyle: 'dark', lcd: '#ffb000', glow: true, accent: '#ffb000', knob: '#ffb000', ledRx: '#ffb000' } },
  };

  /* ───────── Хранение ───────── */

  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY));
    } catch {
      /* пусто */
    }
    if (!saved) {
      // Переносим то, что выбрали в первой версии настроек
      saved = {};
      try {
        const old = JSON.parse(localStorage.getItem(OLD_KEY)) || {};
        const bodies = { olive: '#4b5234', navy: '#25324d', orange: '#d86b1c', red: '#7d2226', sand: '#a38b5e' };
        const lcds = { amber: '#ffcf7a', ice: '#b8e3f5', white: '#eef0ea', red: '#ffb0a6' };
        const accents = { yellow: '#ffd23c', cyan: '#4cd2ff', green: '#6ee06e', red: '#ff5a4c' };
        if (bodies[old.body]) saved.body = bodies[old.body];
        if (lcds[old.screen]) saved.lcd = lcds[old.screen];
        if (accents[old.accent]) saved.accent = accents[old.accent];
        if (old.haptics === false) saved.haptics = false;
      } catch {
        /* нет старых — по умолчанию */
      }
    }
    const l = { ...DEFAULTS, ...saved };
    // Значения из прошлых версий редактора, которых больше нет, — к умолчаниям
    if (!FINISHES[l.finish]) l.finish = DEFAULTS.finish;
    if (!LCD_STYLES[l.lcdStyle]) l.lcdStyle = DEFAULTS.lcdStyle;
    if (!PATTERNS[l.pattern]) l.pattern = 'none';
    if (!LCD_BACKGROUNDS[l.lcdBg]) l.lcdBg = saved.lcdImage ? 'image' : 'none';
    if (!BACKGROUNDS[l.bg]) l.bg = DEFAULTS.bg;
    if (!LCD_FONTS.includes(l.fontLcd)) l.fontLcd = 'default';
    if (!KEY_FONTS.includes(l.fontKeys)) l.fontKeys = 'default';
    if (typeof l.glow !== 'boolean') l.glow = Boolean(saved.neon);
    if (l.antenna === true) l.antenna = 'stock';
    if (l.antenna === false) l.antenna = 'off';
    if (!ANTENNAS[l.antenna]) l.antenna = 'stock';
    for (const k of ['skin', 'keyShape', 'lcdImage', 'neon', 'neonColor', 'neon2', 'pulse']) delete l[k];
    return l;
  }

  let look = load();

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(look));
    } catch {
      /* не запомним — не страшно */
    }
  }

  // Картинки (фон, экран) — в IndexedDB: в localStorage им тесно
  const images = {};
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('walkie-look', 1);
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
      /* не сохранили — картинка будет до перезапуска */
    }
  }

  // Картинку из галереи ужимаем до 1280 px — быстро рисуется и мало весит
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
  // k > 0 — светлее, k < 0 — темнее
  const shade = (h, k) => toHex(hex(h).map((v) => (k >= 0 ? v + (255 - v) * k : v * (1 + k))));
  const mix = (a, b, k) => {
    const x = hex(a);
    const y = hex(b);
    return toHex(x.map((v, i) => v + (y[i] - v) * k));
  };
  const lum = (h) => {
    const [r, g, b] = hex(h).map((v) => v / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const rgba = (h, a) => `rgba(${hex(h).join(', ')}, ${a})`;

  /* ───────── Применение ───────── */

  const style = document.createElement('style');

  // Картинки в стилях — короткими blob:-ссылками, а не мегабайтными data:-строками
  const urls = {};
  function refreshUrls() {
    for (const name of ['bg', 'lcd']) {
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

  function apply() {
    const v = {};
    const bodyLight = lum(look.body) > 0.55;
    v['--plastic-hi'] = shade(look.body, 0.07);
    v['--plastic-lo'] = shade(look.body, -0.45);
    v['--edge'] = shade(look.body, -0.75);
    v['--key-hi'] = shade(look.keys, 0.06);
    v['--key-lo'] = shade(look.keys, -0.35);
    v['--key-side-hi'] = shade(look.keys, 0.18);
    v['--key-side-lo'] = shade(look.keys, -0.12);
    v['--label'] = look.label;
    v['--label-alt'] = look.accent;
    v['--wk-ant'] = look.antennaColor;
    v['--wk-ant-lo'] = shade(look.antennaColor, -0.65);
    v['--wk-ant-hi'] = shade(look.antennaColor, 0.25);
    v['--led-tx'] = look.ledTx;
    v['--led-rx'] = look.ledRx;

    // Фотоскины камуфляжа (экспериментальные): готовые рендеры корпуса, кнопок, боковых и ручки
    // кладутся картинками в CSS-переменные, а skins.css расставляет их по вырезам корпуса. Живые
    // элементы (экран, клавиши, боковые, ручка) сохраняют работу и анимацию.
    const skin = SKINS[look.finish];
    if (skin) {
      const base = `skins/${skin}_`;
      v['--skin-body'] = `url("${base}body.png")`;
      v['--skin-btn'] = `url("${base}button_normal.png")`;
      v['--skin-btn-p'] = `url("${base}button_pressed.png")`;
      v['--skin-sl'] = `url("${base}side_long_normal.png")`;
      v['--skin-sl-p'] = `url("${base}side_long_pressed.png")`;
      v['--skin-ss'] = `url("${base}side_small_normal.png")`;
      v['--skin-ss-p'] = `url("${base}side_small_pressed.png")`;
      v['--skin-knob'] = `url("${base}knob.png")`;
    }

    // Экран: светлые стили — тёмные буквы на подсветке; тёмные — светящиеся буквы на чёрном
    const darkLcd = ['dark', 'oled', 'crt'].includes(look.lcdStyle);
    if (darkLcd) {
      const base = look.lcdStyle === 'oled' ? '#000000' : mix('#050706', look.lcd, 0.06);
      v['--lcd-lit'] = base;
      v['--lcd-lit-lo'] = look.lcdStyle === 'oled' ? '#000000' : shade(base, -0.4);
      v['--lcd-dim'] = shade(base, -0.3);
      v['--lcd-dim-lo'] = '#000000';
      v['--lcd-off'] = '#050505';
      const ink = look.ink === 'auto' ? look.lcd : look.ink;
      v['--ink'] = ink;
      v['--ink-soft'] = rgba(ink, 0.65);
      v['--ink-ghost'] = rgba(ink, 0.14);
    } else {
      v['--lcd-lit'] = look.lcd;
      v['--lcd-lit-lo'] = shade(look.lcd, -0.13);
      v['--lcd-dim'] = mix(shade(look.lcd, -0.3), '#808080', 0.25);
      v['--lcd-dim-lo'] = mix(shade(look.lcd, -0.38), '#707070', 0.25);
      const ink = look.ink === 'auto' ? (lum(look.lcd) > 0.45 ? '#152013' : '#f2f2f2') : look.ink;
      v['--ink'] = ink;
      v['--ink-soft'] = rgba(ink, 0.55);
      v['--ink-ghost'] = rgba(ink, 0.1);
    }
    v['--wk-lcd2'] = look.lcd2;
    v['--wk-lcd-tint'] = String(look.lcdTint);
    v['--wk-glow'] = String(look.glowLevel);

    const lf = FONTS[look.fontLcd] || FONTS.default;
    const kf = FONTS[look.fontKeys] || FONTS.default;
    if (lf.family) v['--lcd-font'] = lf.family;
    v['--wk-fs'] = String(lf.fs);
    v['--wk-fs-small'] = String(lf.small);
    if (kf.family) v['--wk-key-font'] = kf.family;

    const bg = BACKGROUNDS[look.bg] || BACKGROUNDS.dark;
    if (look.bg === 'color') v['--wk-bg'] = look.bgColor;
    else if (look.bg === 'image' && urls.bg) {
      // Картинка — прямо фоном страницы, затемнение — полупрозрачным слоем поверх
      const dim = look.bgDim / 100;
      v['--wk-bg'] = `linear-gradient(rgba(0, 0, 0, ${dim}), rgba(0, 0, 0, ${dim})), url("${urls.bg}") center / cover no-repeat, #000`;
    } else if (look.bg === 'image') v['--wk-bg'] = '#000';
    else v['--wk-bg'] = bg.css;

    let css = `html:root { ${Object.entries(v).map(([k, x]) => `${k}: ${x};`).join(' ')} }`;
    css += ` .knob__mark { background: ${look.knob} !important; }`;
    if (bodyLight) css += ' .brand { color: #3b3a36 !important; }';
    const lcdBg = lcdBackground();
    if (lcdBg) css += ` html:root { --wk-lcd-image: ${lcdBg}; }`;
    style.textContent = css;

    const d = root.dataset;
    d.finish = look.finish;
    d.lcd = look.lcdStyle;
    d.pattern = look.pattern;
    d.antenna = look.antenna;
    if (skin) d.skin = skin;
    else delete d.skin;
    toggleAttr('glow', look.glow);
    toggleAttr('lcdImage', Boolean(lcdBg));
    if (document.body) window.__walkieFit?.();
    save();
  }

  // Фон экрана: готовый или своя картинка
  function lcdBackground() {
    if (look.lcdBg === 'image') return urls.lcd ? `url("${urls.lcd}") center / cover` : null;
    return LCD_BACKGROUNDS[look.lcdBg]?.css || null;
  }

  function toggleAttr(name, on) {
    if (on) root.dataset[name] = '';
    else delete root.dataset[name];
  }

  function set(change) {
    look = { ...look, ...change };
    apply();
    render();
  }

  function applyTheme(id) {
    const keepHaptics = look.haptics;
    look = { ...DEFAULTS, ...THEMES[id].set, haptics: keepHaptics };
    apply();
    render();
  }

  function reset() {
    look = { ...DEFAULTS, haptics: look.haptics };
    delete images.bg;
    delete images.lcd;
    refreshUrls();
    imageSet('bg', null);
    imageSet('lcd', null);
    apply();
    render();
  }

  /* ───────── Редактор ───────── */

  const TABS = [
    ['themes', 'Темы'], ['body', 'Корпус'], ['keys', 'Кнопки'], ['screen', 'Экран'], ['bg', 'Фон'], ['fonts', 'Шрифты'],
  ];
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
    const frag = document.createDocumentFragment();
    frag.append(el('h3', null, title));
    const grid = el('div', 'lk__grid');
    for (const [id, name] of Object.entries(map)) grid.append(option(name, look[key] === id, () => set({ [key]: id })));
    frag.append(grid);
    return frag;
  }

  function colors(title, key, palette) {
    const frag = document.createDocumentFragment();
    frag.append(el('h3', null, title));
    const grid = el('div', 'lk__grid lk__grid--colors');
    for (const c of palette) grid.append(option('', look[key].toLowerCase() === c, () => set({ [key]: c }), c, 'lk__opt--color'));
    // Свой цвет — системная палитра Android
    const custom = option('', !palette.includes(look[key].toLowerCase()), () => {}, '', 'lk__opt--color lk__custom');
    const input = el('input');
    input.type = 'color';
    input.value = look[key];
    input.addEventListener('input', () => set({ [key]: input.value }));
    custom.append(input);
    grid.append(custom);
    frag.append(grid);
    return frag;
  }

  function slider(label, key, min, max, step) {
    const row = el('label', 'lk__row');
    row.append(el('span', null, label));
    const r = el('input');
    r.type = 'range';
    r.min = String(min);
    r.max = String(max);
    r.step = String(step);
    r.value = String(look[key]);
    r.addEventListener('input', () => {
      look = { ...look, [key]: Number(r.value) };
      apply();
    });
    row.append(r);
    return row;
  }

  function toggle(label, key, invert) {
    const row = el('div', 'lk__row');
    row.append(el('span', null, label));
    const on = invert ? !look[key] : look[key];
    const b = el('button', 'wk-switch');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(Boolean(on)));
    b.append(el('span'));
    b.addEventListener('click', () => set({ [key]: invert ? on : !on }));
    row.append(b);
    return row;
  }

  function fonts(title, key, ids) {
    const frag = document.createDocumentFragment();
    frag.append(el('h3', null, title));
    const grid = el('div', 'lk__grid');
    for (const id of ids) {
      const f = FONTS[id];
      const b = option(f.name, look[key] === id, () => set({ [key]: id }));
      const sample = el('b', null, f.sample);
      if (f.family) sample.style.fontFamily = f.family;
      b.prepend(sample);
      grid.append(b);
    }
    frag.append(grid);
    return frag;
  }

  function imageButtons(name, onKey, maxSide) {
    const row = el('div', 'lk__row');
    const pick = el('button', 'lk__btn lk__btn--accent', images[name] ? 'Другая картинка' : 'Выбрать из галереи');
    pick.type = 'button';
    pick.addEventListener('click', async () => {
      const data = await pickImage(maxSide);
      if (!data) return;
      images[name] = data;
      refreshUrls();
      await imageSet(name, data);
      set(onKey);
    });
    row.append(pick);
    if (images[name]) {
      const del = el('button', 'lk__btn lk__btn--danger', 'Убрать');
      del.type = 'button';
      del.addEventListener('click', async () => {
        delete images[name];
        refreshUrls();
        await imageSet(name, null);
        set(name === 'bg' ? { bg: 'dark' } : { lcdBg: 'none' });
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
          grid.append(option(t.name, false, () => applyTheme(id), `linear-gradient(135deg, ${t.sw[0]} 55%, ${t.sw[1]} 55%)`, 'lk__opt--theme'));
        }
        f.append(grid);
        f.append(el('p', 'lk__note', 'Тема — готовая расцветка. Дальше можно подстроить любую мелочь на других вкладках.'));
        break;
      }
      case 'body':
        f.append(choices('Фактура', FINISHES, 'finish'));
        f.append(colors('Цвет корпуса', 'body', COLORS.body));
        f.append(colors('Ручка громкости', 'knob', COLORS.accent));
        f.append(choices('Антенна', ANTENNAS, 'antenna'));
        if (look.antenna !== 'off' && look.antenna !== 'tele') f.append(colors('Цвет антенны', 'antennaColor', COLORS.antenna));
        f.append(colors('Светодиод: передача', 'ledTx', COLORS.led));
        f.append(colors('Светодиод: приём', 'ledRx', COLORS.led));
        break;
      case 'keys':
        f.append(colors('Цвет кнопок', 'keys', COLORS.keys));
        f.append(colors('Цифры и надписи', 'label', COLORS.label));
        f.append(colors('Надписи F-функций', 'accent', COLORS.accent));
        f.append(toggle('Вибрация кнопок', 'haptics'));
        break;
      case 'screen': {
        const dark = ['dark', 'oled', 'crt'].includes(look.lcdStyle);
        f.append(choices('Стиль экрана', LCD_STYLES, 'lcdStyle'));
        f.append(colors(dark ? 'Цвет цифр' : 'Подсветка', 'lcd', dark ? COLORS.glowLcd : COLORS.lcd));
        if (look.lcdStyle === 'gradient') f.append(colors('Второй цвет градиента', 'lcd2', COLORS.lcd));
        f.append(el('h3', null, 'Фон экрана'));
        const grid = el('div', 'lk__grid');
        for (const [id, b] of Object.entries(LCD_BACKGROUNDS)) {
          if (id === 'image' && !images.lcd) continue;
          const sw = id === 'image' ? `url("${images.lcd}") center / cover` : b.css || 'linear-gradient(135deg, #3a3b42, #1a1b1f)';
          grid.append(option(b.name, look.lcdBg === id, () => set({ lcdBg: id }), sw));
        }
        f.append(grid);
        f.append(imageButtons('lcd', { lcdBg: 'image' }, 640));
        if (look.lcdBg !== 'none') f.append(slider('Подсветка поверх фона', 'lcdTint', 0, 90, 5));
        f.append(choices('Узор', PATTERNS, 'pattern'));
        f.append(toggle('Мягкое свечение', 'glow'));
        if (look.glow) f.append(slider('Сила свечения', 'glowLevel', 0.2, 1, 0.1));
        break;
      }
      case 'bg': {
        f.append(el('h3', null, 'Фон за рацией'));
        const grid = el('div', 'lk__grid');
        for (const [id, b] of Object.entries(BACKGROUNDS)) {
          if (id === 'image' && !images.bg) continue;
          const sw = id === 'color' ? look.bgColor : id === 'image' ? `center / cover url("${images.bg}")` : b.css;
          grid.append(option(b.name, look.bg === id, () => set({ bg: id }), sw));
        }
        f.append(grid);
        if (look.bg === 'color') f.append(colors('Цвет фона', 'bgColor', COLORS.bg));
        f.append(el('h3', null, 'Своя картинка'));
        f.append(imageButtons('bg', { bg: 'image' }, 1280));
        if (look.bg === 'image') f.append(slider('Затемнение', 'bgDim', 0, 80, 5));
        break;
      }
      case 'fonts':
        f.append(fonts('Шрифт экрана', 'fontLcd', LCD_FONTS));
        f.append(fonts('Шрифт кнопок', 'fontKeys', KEY_FONTS));
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
    // Верх прозрачный — рацию видно, пока выбираете
    const preview = el('div', 'lk__preview');
    preview.addEventListener('click', () => open(false));
    const sheet = el('div', 'lk__sheet');
    const head = el('div', 'lk__head');
    head.append(el('h2', null, 'Внешний вид'));
    const resetBtn = el('button', 'lk__btn lk__btn--danger', 'Сбросить');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => {
      if (confirm('Вернуть рации вид по умолчанию? Свои картинки тоже удалятся.')) reset();
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

  /* ───────── Старт ───────── */

  document.head.append(style);
  apply(); // цвета — сразу, до первой отрисовки рации
  document.addEventListener('DOMContentLoaded', async () => {
    images.bg = await imageGet('bg');
    images.lcd = await imageGet('lcd');
    refreshUrls();
    apply();
  });

  window.WalkieLook = {
    open,
    reset,
    get haptics() {
      return look.haptics !== false;
    },
  };
})();
