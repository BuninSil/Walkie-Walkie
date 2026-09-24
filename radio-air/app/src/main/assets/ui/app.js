'use strict';

/*
 * Экран радиостанции. Всё, что звучит и уходит в эфир, делает приложение (Station.java);
 * здесь — только показ состояния и кнопки. Состояние приходит в window.__station ~4 раза в секунду,
 * список треков — в window.__tracks, когда меняется.
 */
(() => {
  const app = window.StationApp;
  const $ = (id) => document.getElementById(id);
  const FM_MIN = 87.5;
  const FM_MAX = 108;

  let st = {};
  let tracks = [];
  let editing = null; // поле, которое сейчас правят, — его не перезаписываем состоянием
  let freqDraft = null;

  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmt = (f) => Number(f).toFixed(1);
  const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'трек' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'трека' : 'треков');

  /* ───────── Шкала FM ───────── */

  const scale = $('scale');
  const ticks = $('ticks');
  const pct = (f) => ((f - FM_MIN) / (FM_MAX - FM_MIN)) * 94 + 3; // поля по краям — под подписи

  for (let f = 88; f <= 108; f += 0.5) {
    const big = Number.isInteger(f / 2);
    const t = document.createElement('i');
    t.className = big ? 'big' : '';
    t.style.left = `${pct(f)}%`;
    ticks.append(t);
    if (big && f % 4 === 0) {
      const label = document.createElement('span');
      label.textContent = String(f);
      label.style.left = `${pct(f)}%`;
      ticks.append(label);
    }
  }

  function freqFromX(x) {
    const r = scale.getBoundingClientRect();
    const p = ((x - r.left) / r.width) * 100;
    const f = FM_MIN + ((p - 3) / 94) * (FM_MAX - FM_MIN);
    return Math.round(Math.max(FM_MIN, Math.min(FM_MAX, f)) * 10) / 10;
  }

  scale.addEventListener('pointerdown', (e) => {
    scale.setPointerCapture(e.pointerId);
    freqDraft = freqFromX(e.clientX);
    render();
  });
  scale.addEventListener('pointermove', (e) => {
    if (freqDraft === null) return;
    freqDraft = freqFromX(e.clientX);
    render();
  });
  const commitScale = () => {
    if (freqDraft === null) return;
    const f = freqDraft;
    freqDraft = null;
    sendStation({ freq: f });
  };
  scale.addEventListener('pointerup', commitScale);
  scale.addEventListener('pointercancel', commitScale);

  const stepFreq = (d) => sendStation({ freq: Math.round(Math.max(FM_MIN, Math.min(FM_MAX, (st.freq ?? 100) + d)) * 10) / 10 });
  $('down').addEventListener('click', () => stepFreq(-0.1));
  $('up').addEventListener('click', () => stepFreq(0.1));

  /* ───────── Настройки станции ───────── */

  function sendStation(change) {
    const next = { name: st.name ?? '', freq: st.freq ?? 100, key: st.key ?? '', rds: st.rds ?? true, ...change };
    Object.assign(st, next);
    app?.setStation(JSON.stringify(next));
    render();
  }

  for (const id of ['name', 'key', 'address']) {
    const el = $(id);
    el.addEventListener('focus', () => { editing = id; });
    el.addEventListener('blur', () => {
      editing = null;
      if (id === 'address') return;
      if (el.value.trim() !== (st[id] ?? '')) sendStation({ [id]: el.value.trim() });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.blur();
    });
  }

  $('connect').addEventListener('click', () => {
    const a = $('address').value.trim();
    st.address = a;
    app?.setServer(a);
  });
  $('address').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('connect').click();
  });

  $('rds').addEventListener('click', () => sendStation({ rds: !st.rds }));
  $('monitor').addEventListener('click', () => {
    st.monitor = !st.monitor;
    app?.setMonitor(st.monitor);
    render();
  });
  $('music').addEventListener('input', (e) => app?.setMusic(Number(e.target.value)));

  /* ───────── Эфир ───────── */

  $('go').addEventListener('click', () => (st.onAir ? app?.stop() : app?.start()));
  $('next').addEventListener('click', () => app?.next());

  const talk = $('talk');
  const talkOn = (e) => {
    talk.setPointerCapture?.(e.pointerId);
    talk.classList.add('is-on');
    app?.mic(true);
  };
  const talkOff = () => {
    if (!talk.classList.contains('is-on')) return;
    talk.classList.remove('is-on');
    app?.mic(false);
  };
  talk.addEventListener('pointerdown', talkOn);
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) talk.addEventListener(t, talkOff);
  talk.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ───────── Плейлист ───────── */

  $('pick').addEventListener('click', () => app?.pickFolder());
  $('rescan').addEventListener('click', () => app?.rescan());
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      st.mode = b.dataset.mode;
      app?.setMode(b.dataset.mode);
      render();
    });
  }

  function renderList() {
    const list = $('list');
    list.replaceChildren();
    if (!tracks.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = st.folder ? 'В папке нет музыки (mp3, m4a, flac, ogg, wav…)' : 'Выберите папку с музыкой';
      list.append(li);
      return;
    }
    tracks.forEach((title, i) => {
      const li = document.createElement('li');
      const n = document.createElement('b');
      n.textContent = String(i + 1);
      const t = document.createElement('span');
      t.textContent = title;
      li.append(n, t);
      li.addEventListener('click', () => app?.play(i));
      list.append(li);
    });
  }

  /* ───────── Обновления ───────── */

  $('upd-btn').addEventListener('click', () => app?.update());
  $('upd-auto').addEventListener('click', () => app?.setUpdateAuto(!(st.update?.auto !== false)));

  function renderUpdate() {
    const u = st.update || {};
    const texts = {
      checking: 'Проверяю…',
      latest: 'Последняя версия',
      available: `Есть версия ${u.latest}`,
      downloading: `Скачиваю ${u.latest}: ${u.progress || 0}%`,
      ready: `Версия ${u.latest} скачана${st.onAir ? ' — поставлю после эфира' : ''}`,
      installing: `Ставлю ${u.latest}…`,
      error: 'Не получилось',
    };
    $('upd-ver').textContent = u.current ? `версия ${u.current}` : '';
    $('upd-text').textContent = texts[u.state] || 'Нажмите «Проверить»';
    const btn = $('upd-btn');
    btn.textContent = u.state === 'available' ? 'Скачать' : u.state === 'ready' ? (u.canInstall ? 'Установить' : 'Разрешить') : 'Проверить';
    btn.disabled = ['checking', 'downloading', 'installing'].includes(u.state);
    $('upd-error').hidden = !u.error;
    $('upd-error').textContent = u.error || '';
    $('upd-auto').classList.toggle('is-on', u.auto !== false);
  }

  /* ───────── Показ ───────── */

  const meter = $('meter');
  for (let i = 0; i < 16; i++) meter.append(document.createElement('i'));

  let lastCurrent = -2;

  function render() {
    const f = freqDraft ?? st.freq ?? 100;
    $('freq').textContent = fmt(f);
    $('needle').style.left = `${pct(f)}%`;

    const lamp = $('lamp');
    const lost = st.onAir && !st.online;
    lamp.className = `lamp${st.onAir ? (lost ? ' is-lost' : ' is-on') : ''}`;
    $('lamp-text').textContent = st.onAir ? (lost ? 'НЕТ СВЯЗИ' : 'В ЭФИРЕ') : 'НЕ В ЭФИРЕ';

    $('b-rds').classList.toggle('is-on', Boolean(st.rds));
    $('b-key').classList.toggle('is-on', Boolean(st.key));
    $('b-mic').classList.toggle('is-on', Boolean(st.mic));
    $('airname').textContent = st.onAir ? st.airName : (st.name || 'РАДИО');
    $('now').textContent = st.mic ? '🎙 Голос поверх музыки' : st.title ? `▶ ${st.title}` : tracks.length ? 'Нажмите «Выйти в эфир»' : 'Выберите папку с музыкой';
    const p = st.duration > 0 ? Math.min(1, st.position / st.duration) : 0;
    $('progress').style.width = `${(st.onAir ? p : 0) * 100}%`;
    $('pos').textContent = clock(st.onAir ? st.position : 0);
    $('dur').textContent = clock(st.duration || 0);

    const lit = Math.round(Math.min(1, (st.level || 0) * 1.1) * 16);
    meter.querySelectorAll('i').forEach((el, i) => {
      el.className = i < lit ? `is-on${i >= 14 ? ' is-peak' : i >= 11 ? ' is-hot' : ''}` : '';
    });

    const go = $('go');
    go.textContent = st.onAir ? 'Закончить эфир' : 'Выйти в эфир';
    go.classList.toggle('is-on', Boolean(st.onAir));

    let status;
    if (st.problem) status = st.problem;
    else if (st.onAir && st.keyPending) status = 'Считаю ключ канала… звук пойдёт через секунду.';
    else if (st.onAir) status = `В эфире на ${fmt(st.freq)} МГц · слушателей: ${st.listeners ?? 0}.${st.online ? '' : ' Нет связи с сервером — переподключаюсь.'}`;
    else status = 'Не в эфире.';
    $('status').textContent = status;

    const srv = $('srv-state');
    srv.className = `dot${st.online ? ' is-on' : st.address ? ' is-lost' : ''}`;
    srv.textContent = st.online ? 'на связи' : st.address ? 'нет связи' : 'не подключено';
    const err = $('srv-error');
    err.hidden = !st.serverError || st.online;
    err.textContent = st.serverError ? `Нет связи: ${st.serverError}` : '';

    if (editing !== 'address') $('address').value = st.address ?? '';
    if (editing !== 'name') $('name').value = st.name ?? '';
    if (editing !== 'key') $('key').value = st.key ?? '';
    $('rds').classList.toggle('is-on', Boolean(st.rds));
    $('monitor').classList.toggle('is-on', Boolean(st.monitor));
    if (document.activeElement !== $('music')) $('music').value = String(st.music ?? 90);

    $('folder').textContent = st.folder ? `📁 ${st.folder}` : 'Папка не выбрана';
    $('count').textContent = st.scanning ? 'ищу музыку…' : `${tracks.length} ${plural(tracks.length)}`;
    for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('is-on', b.dataset.mode === (st.mode || 'loop'));

    if (st.current !== lastCurrent) {
      lastCurrent = st.current;
      document.querySelectorAll('.list li').forEach((li, i) => li.classList.toggle('is-current', i === st.current && st.onAir));
      document.querySelector('.list li.is-current')?.scrollIntoView({ block: 'nearest' });
    }
    renderUpdate();
    $('version').textContent = `Радиостанция${st.version ? ` ${st.version}` : ''} · Авторы: BuninSil и Valex`;
  }

  window.__station = (s) => {
    const wasOn = st.onAir;
    st = s;
    if (wasOn !== s.onAir) lastCurrent = -2;
    render();
  };
  window.__tracks = (t) => {
    tracks = Array.isArray(t) ? t : [];
    lastCurrent = -2;
    renderList();
    render();
  };

  try {
    st = JSON.parse(app?.state() ?? '{}');
    tracks = JSON.parse(app?.tracks() ?? '[]');
  } catch {
    /* первый показ — без данных */
  }
  renderList();
  render();
})();
