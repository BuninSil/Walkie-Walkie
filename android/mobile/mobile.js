'use strict';

/*
 * Мост рации для Android. Грузится до widget.js.
 * radioMobile включает в меню пункты SERVER и AUTO: сервер эфира выбирают сами,
 * как в приложении для ПК (своего сервера — пункт HOST — на телефоне нет).
 */
window.radioMobile = { platform: 'android' };

(() => {
  // Рация сделана под 300 px шириной — на экране телефона увеличиваем её целиком
  function fit() {
    const rig = document.getElementById('rig');
    if (!rig) return;
    rig.style.zoom = '1';
    const w = rig.offsetWidth + 20;
    const h = rig.offsetHeight;
    const zoom = Math.min(window.innerWidth / w, window.innerHeight / h);
    rig.style.zoom = String(Math.max(0.5, zoom));
  }

  window.addEventListener('resize', fit);
  document.addEventListener('DOMContentLoaded', fit);

  // Долгое нажатие не должно открывать меню «копировать / выделить» и лупу
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
