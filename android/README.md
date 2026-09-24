# Рация для Android

Это рация с ПК (`../radio-walkie`) как есть: в APK кладётся `radio-walkie/web` без единой правки —
та же страница, те же скрипты, то же меню, тот же протокол. Android-часть только заменяет
оболочку Electron:

| ПК (Electron) | Android |
|---|---|
| `preload.js` → `window.radioDesktop` | `assets/android/bridge.js` → тот же `window.radioDesktop` |
| страница с `app://radio` | страница из APK, WebSocket — из Java с тем же `Origin: app://radio` |
| окно 300×528 | рация растянута на экран телефона (`assets/android/android.css`) |

Для сервера эфира телефон ничем не отличается от ПК-рации, поэтому подключается к тем же серверам.

## Подключение

1. Включите рацию (щелчок по ручке).
2. **MENU → 1 → 2** (пункт 12 SERVER) → **MENU** («НОВЫЙ…») → **MENU** — откроется клавиатура.
3. Наберите адрес сервера так же, как на ПК (например `203.0.113.5:8765` или `radio.example.ru`),
   нажмите **Enter** на клавиатуре (или **MENU** на рации).
4. Загорится **NET** — связь есть. Тот же канал, что у собеседников, и держите **PTT**.
   При первой передаче Android спросит доступ к микрофону.

Если связи нет, внизу экрана появится сообщение Android с причиной: «порт закрыт или сервер
выключен», «сервер не отвечает», «адрес не найден», «сервер отказал (403)»…

## Отличия от ПК

- **14 HOST** (свой сервер), **15 TOP**, полоска поверх игр и горячие клавиши — только на ПК.
- Над рацией — «свернуть» и «закрыть», как у окна на ПК. Кнопка «Назад» тоже сворачивает.
- Свёрнутая рация остаётся на приёме, в шторке — уведомление «Рация».

## Сборка

APK собирает GitHub Actions (workflow «Android APK»): артефакт `walkie-android-apk` → `app-debug.apk`.

Сами: JDK 17+ и Android SDK (проще — Android Studio, открыть папку `android`), затем

```bash
./gradlew assembleDebug    # → app/build/outputs/apk/debug/app-debug.apk
```

Файлы рации копируются из `../radio-walkie/web` при каждой сборке.

## Файлы

| Файл | Что это |
|---|---|
| `app/src/main/java/ru/radio/walkie/MainActivity.java` | WebView с рацией, микрофон, «Назад», свернуть/закрыть |
| `app/src/main/java/ru/radio/walkie/AirSocket.java` | WebSocket к серверу эфира из Java (OkHttp), Origin как у ПК |
| `app/src/main/java/ru/radio/walkie/WalkieService.java` | Приём в фоне: уведомление, WakeLock, WifiLock |
| `app/src/main/assets/android/bridge.js` | `window.radioDesktop` вместо `preload.js`, WebSocket через Java, экран |
| `app/src/main/assets/android/android.css` | Рация на экране телефона |
