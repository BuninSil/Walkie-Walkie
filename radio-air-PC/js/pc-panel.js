'use strict';

/*
 * Настройки ПК-рации в одном месте (шестерёнка на рации):
 *   • Внешний вид — редактор look.js (темы, корпус, кнопки, экран, антенны, шрифты).
 *   • Канал — тоновый шумодав и «не перебивать» (channel.js).
 *   • Анонимность — позывной, ключ канала, исказитель голоса (privacy.js + voice.js).
 *   • Обновления — «Что нового» после обновления и история изменений (changelog.js).
 * Плюс плашка «Нет связи», пока рация не подключилась к серверу.
 * Ничего в самой рации не меняем — работаем поверх её кода.
 */
(() => {
  const SEEN = 'walkie.pc.seenVersion';

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const changelog = () => (Array.isArray(window.WALKIE_CHANGELOG) ? window.WALKIE_CHANGELOG : []);
  const currentVersion = () => changelog()[0]?.ver || '';
  // Версию вида 0.2.0 → сравнимое число (0*1e6 + 2*1e3 + 0)
  const verNum = (v) => {
    const p = String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
    return (p[0] || 0) * 1e6 + (p[1] || 0) * 1e3 + (p[2] || 0);
  };

  /* ───────── Плашка «Что нового» / история изменений ───────── */

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
      : `<span>✨</span><b>Обновлено до ${inline(version)}</b>${many ? `<i class="wn__span">за ${groups.length} версий</i>` : ''}`;
    const list = el('ul', 'wn__list');
    list.innerHTML = groups.map((g) =>
      (many ? `<li class="wn__ver">${inline(g.ver)}</li>` : '')
      + g.items.map((it) => `<li class="${it.level ? 'is-sub' : ''}">${inline(it.text)}</li>`).join(''),
    ).join('');
    const ok = el('button', 'wn__ok', 'Понятно');
    ok.type = 'button';
    const close = () => {
      wrap.classList.add('is-out');
      setTimeout(() => wrap.remove(), 250);
    };
    ok.addEventListener('click', close);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close();
    });
    card.append(head, list, ok);
    wrap.append(card);
    document.body.append(wrap);
  }

  function openChangelog() {
    const groups = changelog().filter((g) => Array.isArray(g.items) && g.items.length);
    showPlate(currentVersion(), groups.length ? groups : [{ ver: currentVersion(), items: [{ level: 0, text: 'Список изменений пока пуст.' }] }], 'История изменений');
  }

  // Версия поменялась — показать, что появилось нового (без интернета, из зашитого списка)
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
    // hadData зафиксирован в privacy.js ДО того, как рация сохранила своё состояние
    let hadData = window.__walkieHadData;
    if (hadData === undefined) {
      try {
        hadData = Boolean(localStorage.getItem('radio.widget.v1'));
      } catch {
        hadData = false;
      }
    }
    const store = () => {
      try {
        localStorage.setItem(SEEN, cur);
      } catch {
        /* покажем ещё раз — не страшно */
      }
    };
    // Первый запуск на чистой рации — молча запоминаем версию
    if (!seen && !hadData) {
      store();
      return;
    }
    const seenN = seen ? verNum(seen) : -1;
    const groups = changelog().filter((g) => Array.isArray(g.items) && g.items.length
      && (seenN < 0 ? g.ver === cur : verNum(g.ver) > seenN));
    store();
    if (groups.length) showPlate(cur, groups);
  }

  /* ───────── Панель настроек ───────── */

  let panel = null;
  let sheet = null;

  function rerender() {
    if (!panel || panel.hidden || !sheet) return;
    const scroll = sheet.scrollTop;
    sheet.replaceChildren(...content());
    sheet.scrollTop = scroll;
  }

  function content() {
    const out = [];
    out.push(el('h2', null, 'Настройки'));

    // Внешний вид
    if (window.WalkieLook) {
      const look = el('button', 'wk-look', '🎨  Внешний вид и темы');
      look.type = 'button';
      look.addEventListener('click', () => window.WalkieLook.open());
      out.push(look);
    }

    // Канал (CTCSS + BCL)
    if (window.WalkieChannel?.section) out.push(window.WalkieChannel.section(rerender));

    // Анонимность (позывной, ключ, голос)
    if (window.WalkiePrivacy?.sections) out.push(...window.WalkiePrivacy.sections(rerender));

    // Обновления
    const upd = el('section', 'wk-sec');
    upd.append(el('h3', null, 'Обновления'));
    // Автообновление из релизов GitHub — только в установленном приложении (Electron)
    const u = window.RadioUpdater;
    if (window.radioDesktop?.onUpdaterStatus && u) {
      const st = u.get();
      const ver = String(st.version || '').replace(/-walkie\.\d+$/, '');
      const map = { checking: 'проверяю…', downloading: `загрузка ${st.percent || 0}%`, ready: `обновление ${ver} готово`, none: 'установлена последняя версия', error: 'не удалось проверить', idle: '' };
      const status = map[st.state] || '';
      const row = el('div', 'pv-item');
      const head = el('div', 'pv-item__head');
      head.append(el('span', null, 'Автообновление'), el('b', 'pv-value', u.auto ? 'вкл' : 'выкл'));
      row.append(head);
      if (status) row.append(el('small', 'pv-hint', status));
      const btns = el('div', 'pv-btns');
      const toggle = el('button', 'pv-btn', u.auto ? 'Выключить авто' : 'Включить авто');
      toggle.type = 'button';
      toggle.addEventListener('click', async () => { await u.setAuto(!u.auto); rerender(); });
      btns.append(toggle);
      if (st.state === 'ready') {
        const install = el('button', 'pv-btn pv-btn--main', 'Установить сейчас');
        install.type = 'button';
        install.addEventListener('click', () => u.install());
        btns.append(install);
      } else {
        const check = el('button', 'pv-btn', 'Проверить сейчас');
        check.type = 'button';
        check.addEventListener('click', () => { u.check(); setTimeout(rerender, 500); });
        btns.append(check);
      }
      row.append(btns);
      upd.append(row);
    }
    const hist = el('button', 'wk-btn wk-btn--wide', '📋  История изменений');
    hist.type = 'button';
    hist.addEventListener('click', openChangelog);
    upd.append(hist);
    out.push(upd);

    // Готово + версия
    const done = el('button', 'wk-done', 'Готово');
    done.type = 'button';
    done.addEventListener('click', () => toggle(false));
    out.push(done);
    out.push(el('p', 'wk-ver', currentVersion() ? `Радио · версия ${currentVersion()}` : 'Радио'));
    return out;
  }

  function build() {
    panel = el('div', 'wk-panel');
    panel.hidden = true;
    sheet = el('div', 'wk-sheet');
    panel.append(sheet);
    panel.addEventListener('click', (e) => {
      if (e.target === panel) toggle(false);
    });
    document.body.append(panel);
  }

  function toggle(show) {
    if (!panel) build();
    panel.hidden = !show;
    if (show) rerender();
  }

  // Шестерёнка на рации (слева сверху, в стиле оконных кнопок)
  function addGear() {
    if (document.getElementById('wk-gear')) return;
    const rig = document.getElementById('rig');
    if (!rig) return;
    const gear = el('button', 'wk-gear');
    gear.id = 'wk-gear';
    gear.type = 'button';
    gear.title = 'Настройки: канал, анонимность, внешний вид';
    gear.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 1h2.4l.4 1.9 1.2.5 1.6-1.1 1.7 1.7-1.1 1.6.5 1.2 1.9.4v2.4l-1.9.4-.5 1.2 1.1 1.6-1.7 1.7-1.6-1.1-1.2.5-.4 1.9H6.8l-.4-1.9-1.2-.5-1.6 1.1-1.7-1.7 1.1-1.6-.5-1.2L.6 9.2V6.8l1.9-.4.5-1.2-1.1-1.6 1.7-1.7 1.6 1.1 1.2-.5zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8"/></svg>';
    gear.addEventListener('click', () => toggle(panel ? panel.hidden : true));
    rig.append(gear);
  }

  /* ───────── Плашка «Нет связи» ───────── */

  function setupConnError() {
    let box = null;
    let offSince = 0;
    let dismissed = false;

    const remove = () => {
      box?.remove();
      box = null;
    };
    const addr = (url) => (url || '').replace(/^wss?:\/\//, '').replace(/\/ws.*$/, '').replace(/\?.*$/, '');

    setInterval(() => {
      const link = window.radioWidget?.link;
      // Нет выбранного сервера — рация покажет это сама, плашку не рисуем
      if (!link || !link.url) {
        offSince = 0;
        dismissed = false;
        remove();
        return;
      }
      if (link.online) {
        offSince = 0;
        dismissed = false;
        remove();
        return;
      }
      // Оффлайн: даём паре секунд на подключение, потом показываем плашку
      if (!offSince) offSince = performance.now();
      if (dismissed || performance.now() - offSince < 2500) return;
      if (box) return;
      const a = addr(link.url);
      box = el('div', 'wk-err');
      const t = el('div', 'wk-err__text');
      t.append(el('b', null, a ? `Нет связи с ${a}` : 'Нет связи с сервером'),
        el('span', null, 'Рация не подключается. Проверьте адрес сервера и что он запущен, а на мобильном интернете — VPN. Как связь появится, плашка сама исчезнет.'));
      const x = el('button', 'wk-err__x', '✕');
      x.type = 'button';
      x.addEventListener('click', () => {
        dismissed = true; // закрыли вручную — не показываем, пока не подключимся и не отвалимся снова
        remove();
      });
      box.append(t, x);
      document.body.append(box);
    }, 700);
  }

  document.addEventListener('DOMContentLoaded', () => {
    addGear();
    // Рация могла перерисовать корпус — вернуть шестерёнку, если пропала
    setInterval(addGear, 1500);
    setupConnError();
    setTimeout(whatsNew, 1200);
    // Пока панель открыта — обновляем раздел «Обновления» вслед за состоянием загрузки
    window.RadioUpdater?.onChange(() => rerender());
  });

  window.WalkiePanel = { open: () => toggle(true), openChangelog };
})();
