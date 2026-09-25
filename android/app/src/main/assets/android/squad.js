'use strict';

/*
 * Отряд: карта своих, короткие сообщения на канал и SOS с координатами — как GPS/APRS
 * на тактических рациях. Кнопка 📍 над рацией.
 *
 * Как ходят данные. Сервер эфира пересылает пакеты станций, не заглядывая внутрь, но старые рации
 * (ПК и прошлые версии) на любой пакет своей частоты приоткрывают шумоподавитель. Поэтому данные
 * идут не по голосовому каналу, а отдельным служебным подключением на частоте 470.000, куда
 * рации не настроены: отряд их видит, эфир — нет. Сервер для этого менять не нужно.
 *
 * Пакет данных (после 4 байт номера станции, как у звука):
 *   открытый     [2][1][JSON UTF-8]
 *   шифрованный  [3][1][номер ключа 8 байт][IV 12 байт][AES-GCM(JSON)] — ключ SCR рации, как у звука
 * Что внутри: pos — где я; msg — сообщение на канал; sos — SOS вкл/выкл с точкой; bye — перестал делиться.
 */
(() => {
  const shell = window.WalkieShell;
  const DATA_FREQ = 470.0;
  const DATA_NAME = '⌁ДАННЫЕ ОТРЯДА';
  const T_OPEN = 2;
  const T_SEALED = 3;
  const HEAD = 22;
  const CHANNEL = 0.006;             // как у сервера: один канал рации
  const POS_MIN_MS = 5000;           // чаще не шлём
  const POS_BEAT_MS = 45000;         // стоим на месте — всё равно напоминаем о себе
  const STALE_MS = 3 * 60000;        // давно не было точки — серым
  const GONE_MS = 30 * 60000;        // совсем пропал — убираем
  const SOS_REPEAT_MS = 10000;
  const QUICK = ['На точке', 'Иду', 'Жду', 'Принял', 'Нужна помощь', 'Отбой'];

  const w = () => window.radioWidget;
  const net = () => window.__walkieNet;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const uid = (() => {
    try {
      let id = localStorage.getItem('squad.uid');
      if (!id) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('squad.uid', id);
      }
      return id;
    } catch {
      return Math.random().toString(16).slice(2, 14);
    }
  })();

  const state = {
    me: null,               // { lat, lon, acc, hdg, spd, ts }
    people: new Map(),      // uid → { uid, name, ch, lat, lon, acc, hdg, spd, at, sos }
    msgs: [],               // { id, uid, name, ch, text, at, mine }
    seenMsg: new Set(),
    unread: 0,
    sosOn: false,
    tab: 'radar',
    scope: 'channel',       // channel | all
    alarms: new Map(),      // uid → SOS, который ещё не подтвердили
    foreign: 0,             // пакеты с чужим ключом — прочитать нельзя
  };

  /* ───────── Настройки из Android ───────── */

  function native() {
    try {
      return JSON.parse(shell?.options?.() || '{}');
    } catch {
      return {};
    }
  }
  const sharing = () => native().shareLocation === true;
  const myName = () => w()?.cfg?.name || net()?.myName || 'РАЦИЯ';
  const myChannel = () => net()?.myFreqs?.[0] ?? null;
  const onMyChannel = (ch) => Number.isFinite(ch) && (net()?.myFreqs || []).some((f) => Math.abs(f - ch) <= (ch < 300 ? 0.2 : CHANNEL));

  /* ───────── Ключ SCR — тот же, что у звука (crypto.js рации) ───────── */

  const keys = new Map();
  function keyFor(phrase) {
    if (!keys.has(phrase)) keys.set(phrase, deriveAirKey(phrase)); // eslint-disable-line no-undef
    return keys.get(phrase);
  }
  const scr = () => (w()?.cfg?.scr || '').trim().toUpperCase();

  async function pack(obj) {
    const body = enc.encode(JSON.stringify(obj));
    const phrase = scr();
    if (!phrase || !window.crypto?.subtle) {
      const out = new Uint8Array(2 + body.length);
      out[0] = T_OPEN;
      out[1] = 1;
      out.set(body, 2);
      return out;
    }
    const entry = await keyFor(phrase);
    const head = new Uint8Array(HEAD);
    head[0] = T_SEALED;
    head[1] = 1;
    head.set(entry.id, 2);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    head.set(iv, 10);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: head.subarray(0, 10) }, entry.key, body));
    const out = new Uint8Array(HEAD + sealed.length);
    out.set(head);
    out.set(sealed, HEAD);
    return out;
  }

  async function unpack(p) {
    if (p[0] === T_OPEN && p.length > 2) return JSON.parse(dec.decode(p.subarray(2)));
    if (p[0] !== T_SEALED || p.length <= HEAD + 16) return null;
    const phrase = scr();
    if (!phrase) {
      state.foreign++;
      return null;
    }
    const entry = await keyFor(phrase);
    const kid = p.subarray(2, 10);
    if (!entry.id.every((b, i) => b === kid[i])) {
      state.foreign++;
      return null;
    }
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.subarray(10, HEAD), additionalData: p.subarray(0, 10) }, entry.key, p.subarray(HEAD));
    return JSON.parse(dec.decode(plain));
  }

  /* ───────── Служебное подключение на 470.000 ───────── */

  let sock = null;
  let sockUrl = null;
  let retryAt = 0;
  let retry = 0;

  function wantedUrl() {
    const link = w()?.link;
    if (!link?.url || !link.online) return null;
    return link.url + (link.url.includes('?') ? '&' : '?') + 'data=1';
  }

  function keepSocket() {
    const url = wantedUrl();
    if (url === sockUrl && sock) return;
    if (sock) {
      const old = sock;
      sock = null;
      old.onclose = null;
      old.close();
    }
    sockUrl = url;
    if (!url || Date.now() < retryAt) return;
    const s = new WebSocket(url);
    s.binaryType = 'arraybuffer';
    sock = s;
    s.onopen = () => {
      retry = 0;
      s.send(JSON.stringify({ type: 'tune', freq: DATA_FREQ, freqs: [DATA_FREQ] }));
      s.send(JSON.stringify({ type: 'onair', freq: DATA_FREQ, name: DATA_NAME }));
      lastPosSent = 0; // переподключились — сразу сказать, где мы
      tick();
    };
    s.onmessage = (e) => {
      if (typeof e.data === 'string') {
        // В отряд пришёл новенький — сказать ему, где мы, не дожидаясь очередной отправки
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'station-on' && String(m.station?.name).startsWith('⌁')) {
            setTimeout(() => {
              lastPosSent = 0;
              tick();
            }, 300 + Math.random() * 1500);
          }
        } catch {
          /* не JSON */
        }
        return;
      }
      const p = new Uint8Array(e.data);
      if (p.length > 6) receive(p.subarray(4));
    };
    s.onclose = () => {
      if (sock !== s) return;
      sock = null;
      sockUrl = null;
      retry = Math.min(retry + 1, 5);
      retryAt = Date.now() + retry * 2000;
    };
  }

  const ready = () => sock && sock.readyState === 1;

  async function send(obj) {
    if (!ready()) return false;
    try {
      const bytes = await pack({ ...obj, u: uid, n: myName(), ch: myChannel() });
      if (ready()) sock.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  /* ───────── Что пришло ───────── */

  async function receive(p) {
    let m;
    try {
      m = await unpack(p);
    } catch {
      return; // повреждён или не тот ключ
    }
    if (!m || typeof m !== 'object' || typeof m.u !== 'string' || m.u === uid) return;
    const name = String(m.n || 'Без позывного').slice(0, 24);
    const ch = Number(m.ch);
    const who = state.people.get(m.u) || { uid: m.u };
    Object.assign(who, { name, ch });
    switch (m.k) {
      case 'pos':
        if (!validPoint(m)) return;
        Object.assign(who, { lat: m.lat, lon: m.lon, acc: m.acc, hdg: m.hdg, spd: m.spd, at: Date.now() });
        state.people.set(m.u, who);
        break;
      case 'bye':
        if (!who.sos) state.people.delete(m.u);
        break;
      case 'msg': {
        if (typeof m.id !== 'string' || state.seenMsg.has(m.id)) return;
        state.seenMsg.add(m.id);
        const text = String(m.text || '').slice(0, 140);
        if (!text || !onMyChannel(ch)) return; // сообщения — только своему каналу, как в эфире
        addMsg({ id: m.id, uid: m.u, name, ch, text, at: Date.now(), mine: false });
        break;
      }
      case 'sos':
        if (m.on) {
          if (validPoint(m)) Object.assign(who, { lat: m.lat, lon: m.lon, acc: m.acc, at: Date.now() });
          const fresh = !who.sos;
          who.sos = true;
          state.people.set(m.u, who);
          if (fresh || !state.alarms.has(m.u)) raiseSos(who, fresh);
        } else if (who.sos) {
          who.sos = false;
          state.people.set(m.u, who);
          sosCleared(who);
        }
        break;
      default:
        return;
    }
    render();
  }

  const validPoint = (m) => Number.isFinite(m.lat) && Number.isFinite(m.lon) && Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180;

  /* ───────── Моё место ───────── */

  let lastPosSent = 0;
  let lastSentPoint = null;

  window.__walkieGps = (fix) => {
    if (!fix || !validPoint(fix)) return;
    state.me = fix;
    tick();
    render();
  };

  function tick() {
    keepSocket();
    const now = Date.now();
    // Пропавшие — убрать, давно молчащие — посереют сами при отрисовке
    for (const [id, p] of state.people) if (!p.sos && now - (p.at || 0) > GONE_MS) state.people.delete(id);
    if (!sharing() || !state.me || !ready()) return;
    const moved = lastSentPoint ? distance(lastSentPoint, state.me) : Infinity;
    const turned = lastSentPoint && state.me.hdg >= 0 && lastSentPoint.hdg >= 0 ? Math.abs(((state.me.hdg - lastSentPoint.hdg + 540) % 360) - 180) : 0;
    const due = now - lastPosSent >= POS_BEAT_MS || ((moved > 8 || turned > 30) && now - lastPosSent >= POS_MIN_MS);
    if (!due) return;
    lastPosSent = now;
    lastSentPoint = { ...state.me };
    const { lat, lon, acc, hdg, spd } = state.me;
    send({ k: 'pos', lat: round6(lat), lon: round6(lon), acc, hdg, spd });
  }
  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  let wasSharing = false;
  setInterval(() => {
    const on = sharing();
    if (wasSharing && !on) send({ k: 'bye' }); // выключили — пусть у других пропадём сразу
    wasSharing = on;
    tick();
    if (panel && !panel.hidden) render();
  }, 2000);

  /* ───────── Геометрия ───────── */

  const RAD = Math.PI / 180;
  function distance(a, b) {
    const dLat = (b.lat - a.lat) * RAD;
    const dLon = (b.lon - a.lon) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
    const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  const COMPASS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
  function fmtDist(m) {
    if (m < 1000) return `${Math.round(m / 5) * 5} м`;
    if (m < 10000) return `${(m / 1000).toFixed(1).replace('.', ',')} км`;
    return `${Math.round(m / 1000)} км`;
  }
  function ago(ms) {
    const s = Math.round(ms / 1000);
    if (s < 10) return 'сейчас';
    if (s < 60) return `${s} с назад`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} мин назад` : `${Math.round(m / 60)} ч назад`;
  }
  const fmtCh = (f) => (!Number.isFinite(f) ? '—' : f < 300 ? `${f.toFixed(1)} FM` : f.toFixed(5).replace(/0{1,2}$/, ''));

  /* ───────── Сообщения ───────── */

  function addMsg(msg) {
    state.msgs.push(msg);
    if (state.msgs.length > 200) state.msgs.shift();
    if (msg.mine) return;
    const looking = panel && !panel.hidden && state.tab === 'chat';
    if (!looking) {
      state.unread++;
      toast(`💬 ${msg.name}`, msg.text, () => open('chat'));
    }
    blip();
    if (!shell?.appVisible?.()) shell?.squadAlert?.(`💬 ${msg.name}`, msg.text, false);
  }

  function say(text) {
    const t = String(text).trim().slice(0, 140);
    if (!t) return;
    const id = `${uid}-${Date.now().toString(36)}`;
    state.seenMsg.add(id);
    const ok = ready();
    send({ k: 'msg', id, text: t });
    addMsg({ id, uid, name: myName(), ch: myChannel(), text: t, at: Date.now(), mine: true, failed: !ok });
    render();
  }

  /* ───────── SOS ───────── */

  let sosTimer = 0;
  window.__walkieSquadSos = (on) => {
    state.sosOn = on;
    clearInterval(sosTimer);
    const shout = () => {
      const p = state.me;
      send({ k: 'sos', on: true, ...(p ? { lat: round6(p.lat), lon: round6(p.lon), acc: p.acc } : {}) });
    };
    if (on) {
      shout();
      sosTimer = setInterval(shout, SOS_REPEAT_MS); // кто подключился позже — тоже узнает
    } else {
      send({ k: 'sos', on: false });
    }
    render();
  };

  let siren = null;
  function raiseSos(who, fresh) {
    state.alarms.set(who.uid, who);
    if (fresh) {
      startSiren();
      shell?.vibratePattern?.('0,600,300,600,300,600');
      const where = whereText(who);
      shell?.squadAlert?.(`🆘 SOS · ${who.name}`, where || 'Место неизвестно — откройте рацию', true);
    }
    showAlarm();
  }

  function sosCleared(who) {
    state.alarms.delete(who.uid);
    toast(`✅ ${who.name}`, 'SOS снят', () => open('radar'));
    if (!state.alarms.size) {
      stopSiren();
      shell?.squadAlertClear?.();
    }
    showAlarm();
  }

  function whereText(p) {
    if (!Number.isFinite(p.lat)) return '';
    if (!state.me) return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
    return `${fmtDist(distance(state.me, p))} на ${compass(bearing(state.me, p))} от вас`;
  }

  // Сирена — прямо в динамик, мимо эфира: две ноты, пока не нажмут «Принял»
  function startSiren() {
    if (siren) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.18;
      osc.type = 'square';
      osc.connect(gain).connect(ctx.destination);
      const t0 = ctx.currentTime;
      for (let i = 0; i < 240; i++) osc.frequency.setValueAtTime(i % 2 ? 660 : 880, t0 + i * 0.45);
      osc.start();
      siren = { ctx, osc };
    } catch {
      siren = null;
    }
  }
  function stopSiren() {
    if (!siren) return;
    try {
      siren.osc.stop();
      siren.ctx.close();
    } catch {
      /* уже тихо */
    }
    siren = null;
  }

  /* ───────── Интерфейс ───────── */

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let panel = null;
  let btn = null;
  let alarmBox = null;
  let toastBox = null;

  function setup() {
    const chrome = document.getElementById('chrome');
    btn = el('button', 'chrome__btn sq-btn');
    btn.id = 'win-squad';
    btn.type = 'button';
    btn.title = 'Отряд: карта, сообщения, SOS';
    btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0a5.5 5.5 0 0 0-5.5 5.5C2.5 9.6 8 16 8 16s5.5-6.4 5.5-10.5A5.5 5.5 0 0 0 8 0m0 7.8a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6"/></svg><b class="sq-dot" hidden></b>';
    btn.addEventListener('click', () => open(state.alarms.size ? 'radar' : state.tab));
    const after = document.getElementById('win-net') || document.getElementById('win-settings');
    if (after) after.after(btn);
    else chrome?.prepend(btn);

    panel = el('div', 'sq');
    panel.hidden = true;
    document.body.append(panel);
    alarmBox = el('div', 'sq-alarm');
    alarmBox.hidden = true;
    document.body.append(alarmBox);
    toastBox = el('div', 'sq-toasts');
    document.body.append(toastBox);

    const start = shell?.lastGps?.();
    if (start) {
      try {
        window.__walkieGps(JSON.parse(start));
      } catch {
        /* нет точки */
      }
    }
    const from = shell?.squadIntent?.();
    if (from) setTimeout(() => open(from === 'sos' ? 'radar' : 'chat'), 600);
    render();
  }

  window.__walkieSquadOpen = (what) => open(what === 'sos' ? 'radar' : 'chat');

  function open(tab) {
    if (tab) state.tab = tab;
    if (state.tab === 'chat') state.unread = 0;
    panel.hidden = false;
    render();
  }
  function close() {
    panel.hidden = true;
    render();
  }

  function visiblePeople() {
    const now = Date.now();
    return [...state.people.values()]
      .filter((p) => Number.isFinite(p.lat) && (state.scope === 'all' || onMyChannel(p.ch) || p.sos))
      .map((p) => ({ ...p, stale: now - (p.at || 0) > STALE_MS, dist: state.me ? distance(state.me, p) : null, brg: state.me ? bearing(state.me, p) : null }))
      .sort((a, b) => (b.sos - a.sos) || ((a.dist ?? 1e12) - (b.dist ?? 1e12)));
  }

  function render() {
    if (!btn) return;
    const dot = btn.querySelector('.sq-dot');
    dot.hidden = !(state.alarms.size || state.unread || state.sosOn);
    dot.classList.toggle('is-sos', Boolean(state.alarms.size || state.sosOn));
    dot.textContent = state.alarms.size ? '!' : state.unread ? String(Math.min(state.unread, 9)) : '';
    btn.classList.toggle('is-sos', Boolean(state.alarms.size));
    if (panel.hidden) return;

    // Пишут сообщение — не трогаем поле ввода, обновляем только ленту
    const typing = state.tab === 'chat' && panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (typing) {
      const old = panel.querySelector('.sq-chat__list');
      if (old) {
        const tmp = el('div');
        renderChat(tmp);
        const fresh = tmp.querySelector('.sq-chat__list');
        old.replaceWith(fresh);
        if (chatStick) fresh.scrollTop = fresh.scrollHeight;
      }
      return;
    }

    const sheet = el('div', 'sq__sheet');
    const head = el('div', 'sq__head');
    const tabs = el('div', 'sq__tabs');
    for (const [id, name] of [['radar', 'Радар'], ['map', 'Карта'], ['chat', state.unread ? `Чат · ${state.unread}` : 'Чат']]) {
      const b = el('button', null, name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.tab === id));
      b.addEventListener('click', () => open(id));
      tabs.append(b);
    }
    const x = el('button', 'sq__close', '✕');
    x.type = 'button';
    x.addEventListener('click', close);
    head.append(tabs, x);
    sheet.append(head);

    if (!ready()) sheet.append(el('p', 'sq__warn', w()?.link?.online ? 'Подключаю канал данных…' : 'Нет связи с сервером — отряд не виден.'));
    if (state.tab === 'radar') renderRadar(sheet);
    else if (state.tab === 'map') renderMap(sheet);
    else renderChat(sheet);

    const scrollers = panel.querySelector('.sq__body');
    const keep = scrollers ? scrollers.scrollTop : 0;
    // Карту не пересоздаём — только переносим, чтобы не мигала
    if (state.tab === 'map' && mapBox) {
      const holder = sheet.querySelector('.sq__maphold');
      holder.replaceWith(mapBox);
    }
    panel.replaceChildren(sheet);
    const body = panel.querySelector('.sq__body');
    if (body) body.scrollTop = keep;
    if (state.tab === 'map') updateMap();
    if (state.tab === 'chat') {
      const list = panel.querySelector('.sq-chat__list');
      if (list && chatStick) list.scrollTop = list.scrollHeight;
    }
  }

  function shareRow() {
    const on = sharing();
    const row = el('div', 'sq-share');
    const text = el('span', null, on
      ? (state.me ? `Вы на карте · точность ${state.me.acc > 0 ? `±${state.me.acc} м` : '—'}` : 'Ищу спутники…')
      : 'Вас не видно отряду');
    const b = el('button', on ? 'sq-share__btn is-on' : 'sq-share__btn', on ? 'Не делиться' : 'Делиться местом');
    b.type = 'button';
    b.addEventListener('click', () => {
      shell?.setOption?.('shareLocation', !on);
      setTimeout(render, 400);
    });
    row.append(el('i', on ? 'sq-share__dot is-on' : 'sq-share__dot'), text, b);
    return row;
  }

  function scopeRow() {
    const seg = el('div', 'sq-seg');
    for (const [id, name] of [['channel', `Мой канал${myChannel() ? ` · ${fmtCh(myChannel())}` : ''}`], ['all', 'Все каналы']]) {
      const b = el('button', null, name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.scope === id));
      b.addEventListener('click', () => {
        state.scope = id;
        render();
      });
      seg.append(b);
    }
    return seg;
  }

  /* Радар: вы в центре, север вверху, кольца — расстояние */
  const NICE = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 25000, 50000, 100000, 250000, 500000, 1000000];

  function renderRadar(sheet) {
    const body = el('div', 'sq__body');
    body.append(shareRow(), scopeRow());
    const people = visiblePeople();
    const size = 300;
    const c = size / 2;
    const far = Math.max(0, ...people.map((p) => p.dist ?? 0));
    const range = NICE.find((n) => n >= far * 1.15) || NICE[NICE.length - 1];
    const svg = [`<svg class="sq-radar" viewBox="0 0 ${size} ${size}" aria-label="Радар">`,
      `<defs><radialGradient id="sqg"><stop offset="0" stop-color="rgba(94,240,196,.10)"/><stop offset="1" stop-color="rgba(94,240,196,0)"/></radialGradient></defs>`,
      `<circle cx="${c}" cy="${c}" r="${c - 2}" class="sq-radar__bg"/>`];
    for (let i = 1; i <= 4; i++) svg.push(`<circle cx="${c}" cy="${c}" r="${((c - 14) * i) / 4}" class="sq-radar__ring"/>`);
    svg.push(`<line x1="${c}" y1="8" x2="${c}" y2="${size - 8}" class="sq-radar__axis"/><line x1="8" y1="${c}" x2="${size - 8}" y2="${c}" class="sq-radar__axis"/>`);
    svg.push(`<text x="${c}" y="20" class="sq-radar__n">С</text>`);
    svg.push(`<text x="${c + (c - 14) + 2}" y="${c - 4}" class="sq-radar__scale" text-anchor="end">${fmtDist(range)}</text>`);
    svg.push(`<text x="${c + (c - 14) / 2 + 2}" y="${c - 4}" class="sq-radar__scale" text-anchor="end">${fmtDist(range / 2)}</text>`);
    svg.push(`<g class="sq-radar__sweep"><path d="M${c} ${c} L${c} 12 A${c - 12} ${c - 12} 0 0 1 ${c + (c - 12) * Math.sin(Math.PI / 5)} ${c - (c - 12) * Math.cos(Math.PI / 5)} Z" fill="url(#sqg)"/></g>`);
    if (state.me) {
      for (const p of people) {
        if (p.dist == null) continue;
        const r = Math.min(1, p.dist / range) * (c - 14);
        const x = c + r * Math.sin(p.brg * RAD);
        const y = c - r * Math.cos(p.brg * RAD);
        const cls = p.sos ? 'is-sos' : p.stale ? 'is-stale' : onMyChannel(p.ch) ? 'is-mine' : 'is-other';
        if (p.hdg >= 0 && !p.stale) {
          svg.push(`<g transform="translate(${x} ${y}) rotate(${p.hdg})"><path d="M0 -13 L4 -6 L-4 -6 Z" class="sq-radar__hdg ${cls}"/></g>`);
        }
        if (p.sos) svg.push(`<circle cx="${x}" cy="${y}" r="10" class="sq-radar__pulse"/>`);
        svg.push(`<circle cx="${x}" cy="${y}" r="5" class="sq-radar__dot ${cls}"/>`);
        const anchor = x > c + 60 ? 'end' : 'start';
        svg.push(`<text x="${x + (anchor === 'end' ? -8 : 8)}" y="${y + 4}" text-anchor="${anchor}" class="sq-radar__label ${cls}">${escapeXml(p.name)}</text>`);
      }
      const hdg = state.me.hdg >= 0 ? state.me.hdg : null;
      if (hdg != null) svg.push(`<g transform="translate(${c} ${c}) rotate(${hdg})"><path d="M0 -15 L5 -5 L-5 -5 Z" class="sq-radar__me-hdg"/></g>`);
      svg.push(`<circle cx="${c}" cy="${c}" r="6" class="sq-radar__me"/>`);
    } else {
      svg.push(`<text x="${c}" y="${c + 4}" class="sq-radar__none">${sharing() ? 'жду спутники…' : 'нужно ваше место'}</text>`);
    }
    svg.push('</svg>');
    const wrap = el('div', 'sq-radar__wrap');
    wrap.innerHTML = svg.join('');
    body.append(wrap);

    const list = el('div', 'sq-list');
    if (!people.length) {
      list.append(el('p', 'sq__note', state.scope === 'channel'
        ? 'На вашем канале никто не делится местом. Попросите включить 📍 → «Делиться местом», или смотрите «Все каналы».'
        : 'Никто на сервере не делится местом.'));
    }
    for (const p of people) {
      const row = el('button', `sq-person${p.sos ? ' is-sos' : ''}${p.stale ? ' is-stale' : ''}`);
      row.type = 'button';
      const arrow = el('i', 'sq-person__arrow', p.brg != null ? '➤' : '•');
      if (p.brg != null) arrow.style.transform = `rotate(${p.brg - 90}deg)`;
      const text = el('span', 'sq-person__text');
      text.append(el('b', null, `${p.sos ? '🆘 ' : ''}${p.name}`));
      const bits = [fmtCh(p.ch)];
      if (p.spd > 0.7) bits.push(`${Math.round(p.spd * 3.6)} км/ч${p.hdg >= 0 ? ` на ${compass(p.hdg)}` : ''}`);
      bits.push(ago(Date.now() - (p.at || 0)));
      text.append(el('small', null, bits.join(' · ')));
      const where = el('span', 'sq-person__where', p.dist != null ? fmtDist(p.dist) : '—');
      if (p.brg != null) where.append(el('small', null, compass(p.brg)));
      row.append(arrow, text, where);
      row.addEventListener('click', () => {
        focusUid = p.uid;
        open('map');
      });
      list.append(row);
    }
    body.append(list);
    if (state.foreign) body.append(el('p', 'sq__note', 'Есть данные с другим ключом SCR — их не прочитать.'));
    sheet.append(body);
  }

  const escapeXml = (s) => String(s).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]);

  /* Карта (Leaflet, грузится при первом открытии) */
  let mapBox = null;
  let map = null;
  let markers = new Map();
  let meMarker = null;
  let focusUid = null;
  let fitted = false;
  let leafletLoading = null;

  const LAYERS = {
    dark: { name: 'Тёмная', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', attr: '© OpenStreetMap, © CARTO' },
    osm: { name: 'Обычная', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© OpenStreetMap' },
    sat: { name: 'Спутник', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: '© Esri' },
  };
  let layerId = (() => {
    try {
      return localStorage.getItem('squad.layer') || 'dark';
    } catch {
      return 'dark';
    }
  })();
  let tiles = null;

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/assets/android/leaflet/leaflet.css';
      document.head.append(css);
      const s = document.createElement('script');
      s.src = '/assets/android/leaflet/leaflet.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });
    return leafletLoading;
  }

  function renderMap(sheet) {
    const body = el('div', 'sq__body sq__body--map');
    body.append(shareRow());
    const tools = el('div', 'sq-maptools');
    for (const [id, l] of Object.entries(LAYERS)) {
      const b = el('button', null, l.name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(layerId === id));
      b.addEventListener('click', () => {
        layerId = id;
        try {
          localStorage.setItem('squad.layer', id);
        } catch {
          /* не запомним */
        }
        setLayer();
        render();
      });
      tools.append(b);
    }
    const all = el('button', 'sq-maptools__fit', '⤢ Все');
    all.type = 'button';
    all.addEventListener('click', () => fitAll());
    const me = el('button', 'sq-maptools__fit', '◎ Я');
    me.type = 'button';
    me.addEventListener('click', () => state.me && map?.setView([state.me.lat, state.me.lon], Math.max(map.getZoom(), 15)));
    tools.append(all, me);
    body.append(tools, scopeRow(), el('div', 'sq__maphold'));
    sheet.append(body);
    if (!mapBox) {
      mapBox = el('div', 'sq-map');
      loadLeaflet().then(() => {
        map = window.L.map(mapBox, { zoomControl: true, attributionControl: true }).setView(state.me ? [state.me.lat, state.me.lon] : [55.75, 37.62], state.me ? 14 : 5);
        setLayer();
        updateMap();
      }, () => {
        mapBox.textContent = 'Не загрузилась карта';
      });
    }
  }

  function setLayer() {
    if (!map) return;
    if (tiles) tiles.remove();
    const l = LAYERS[layerId] || LAYERS.dark;
    tiles = window.L.tileLayer(l.url, { maxZoom: 19, subdomains: 'abcd', attribution: l.attr, crossOrigin: true }).addTo(map);
  }

  function icon(p, cls) {
    return window.L.divIcon({
      className: 'sq-mark',
      html: `<div class="sq-mark__pin ${cls}">${p.hdg >= 0 && !p.stale ? `<i style="transform:rotate(${p.hdg}deg)"></i>` : ''}</div><div class="sq-mark__name ${cls}">${escapeXml(p.name)}</div>`,
      iconSize: [0, 0],
    });
  }

  function updateMap() {
    if (!map) return;
    setTimeout(() => map.invalidateSize(), 50);
    const people = visiblePeople();
    const seen = new Set();
    for (const p of people) {
      seen.add(p.uid);
      const cls = p.sos ? 'is-sos' : p.stale ? 'is-stale' : onMyChannel(p.ch) ? 'is-mine' : 'is-other';
      let m = markers.get(p.uid);
      if (!m) {
        m = window.L.marker([p.lat, p.lon], { icon: icon(p, cls) }).addTo(map);
        markers.set(p.uid, m);
      } else {
        m.setLatLng([p.lat, p.lon]);
        m.setIcon(icon(p, cls));
      }
      const text = [p.name, fmtCh(p.ch), p.dist != null ? `${fmtDist(p.dist)} на ${compass(p.brg)}` : '', ago(Date.now() - (p.at || 0))].filter(Boolean).join(' · ');
      m.bindTooltip(text, { direction: 'top', offset: [0, -14] });
    }
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        m.remove();
        markers.delete(id);
      }
    }
    if (state.me) {
      const ll = [state.me.lat, state.me.lon];
      if (!meMarker) meMarker = window.L.marker(ll, { icon: icon({ name: 'Вы', hdg: state.me.hdg }, 'is-me'), zIndexOffset: 1000 }).addTo(map);
      else {
        meMarker.setLatLng(ll);
        meMarker.setIcon(icon({ name: 'Вы', hdg: state.me.hdg }, 'is-me'));
      }
    }
    if (focusUid && markers.has(focusUid)) {
      map.setView(markers.get(focusUid).getLatLng(), Math.max(map.getZoom(), 15));
      focusUid = null;
      fitted = true;
    } else if (!fitted) {
      fitAll();
    }
  }

  function fitAll() {
    if (!map) return;
    const pts = visiblePeople().map((p) => [p.lat, p.lon]);
    if (state.me) pts.push([state.me.lat, state.me.lon]);
    if (!pts.length) return;
    fitted = true;
    if (pts.length === 1) map.setView(pts[0], 15);
    else map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
  }

  /* Чат канала */
  let chatStick = true;
  function renderChat(sheet) {
    const body = el('div', 'sq__body sq__body--chat');
    const ch = myChannel();
    body.append(el('p', 'sq__note', `Канал ${fmtCh(ch)}: сообщения видят все на нём${scr() ? ' с вашим ключом SCR' : ''}.`));
    const list = el('div', 'sq-chat__list');
    const msgs = state.msgs.filter((m) => m.mine || onMyChannel(m.ch));
    if (!msgs.length) list.append(el('p', 'sq__note', 'Пока тихо. Кнопки ниже — быстрые сообщения.'));
    for (const m of msgs) {
      const b = el('div', `sq-msg${m.mine ? ' is-mine' : ''}`);
      b.append(el('b', null, m.mine ? 'Вы' : m.name), el('span', null, m.text));
      const t = new Date(m.at);
      b.append(el('small', null, `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}${m.failed ? ' · не отправлено' : ''}`));
      list.append(b);
    }
    list.addEventListener('scroll', () => {
      chatStick = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;
    });
    const quick = el('div', 'sq-quick');
    for (const q of QUICK) {
      const b = el('button', null, q);
      b.type = 'button';
      b.addEventListener('click', () => {
        chatStick = true;
        say(q);
      });
      quick.append(b);
    }
    const form = el('form', 'sq-input');
    const input = el('input');
    input.maxLength = 140;
    input.placeholder = 'Сообщение на канал';
    input.value = draft;
    input.addEventListener('input', () => { draft = input.value; });
    const go = el('button', null, 'Отправить');
    go.type = 'submit';
    form.append(input, go);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      chatStick = true;
      say(input.value);
      draft = '';
      render();
    });
    body.append(list, quick, form);
    sheet.append(body);
  }
  let draft = '';

  /* Тревога SOS — поверх всего */
  function showAlarm() {
    const list = [...state.alarms.values()];
    alarmBox.hidden = !list.length;
    if (!list.length) return;
    const box = el('div', 'sq-alarm__box');
    box.append(el('div', 'sq-alarm__title', '🆘 SOS'));
    for (const p of list) {
      const row = el('div', 'sq-alarm__who');
      row.append(el('b', null, p.name), el('span', null, whereText(p) || 'место неизвестно'), el('small', null, `канал ${fmtCh(p.ch)}`));
      box.append(row);
    }
    const acts = el('div', 'sq-alarm__acts');
    const mapBtn = el('button', null, 'Показать на карте');
    mapBtn.type = 'button';
    mapBtn.addEventListener('click', () => {
      stopSiren();
      focusUid = list[0].uid;
      alarmBox.hidden = true;
      open('map');
    });
    const ack = el('button', 'is-main', 'Принял');
    ack.type = 'button';
    ack.addEventListener('click', () => {
      stopSiren();
      shell?.squadAlertClear?.();
      for (const p of list) say(`Принял SOS ${p.name}`);
      state.alarms.clear();
      alarmBox.hidden = true;
      render();
    });
    acts.append(mapBtn, ack);
    box.append(acts);
    alarmBox.replaceChildren(box);
  }

  /* Всплывашки и звук сообщения */
  function toast(title, text, onTap) {
    const t = el('button', 'sq-toast');
    t.type = 'button';
    t.append(el('b', null, title), el('span', null, text));
    const drop = () => {
      t.classList.add('is-gone');
      setTimeout(() => t.remove(), 250);
    };
    t.addEventListener('click', () => {
      drop();
      onTap?.();
    });
    toastBox.append(t);
    while (toastBox.children.length > 3) toastBox.firstChild.remove();
    setTimeout(drop, 5000);
  }

  function blip() {
    try {
      shell?.vibrate?.();
      const ctx = w()?.engine?.ctx;
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.08, t);
      g.gain.setValueAtTime(0, t + 0.18);
      o.frequency.setValueAtTime(1320, t);
      o.frequency.setValueAtTime(1760, t + 0.09);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.2);
    } catch {
      /* без звука */
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(setup, 0));
  else setup();
  window.__walkieSquad = { state, say, open, uid }; // для отладки
})();
