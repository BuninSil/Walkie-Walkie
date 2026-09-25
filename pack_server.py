"""
Собирает архив «Сервер эфира» — чтобы поднять свой эфир на другом компьютере или VPS с Windows.

    python pack_server.py   — файлы сервера в release/radio-server и архив release/radio-server-<версия>.zip

В архив попадают только файлы из списка ниже: сервер, автозапуск, страницы приёмника и рации,
инструкция. Журналы, настройки HTTPS, приложение и прочее из папки проекта не попадают.
Перед упаковкой всё проверяется на секреты и личные данные — так же, как в pack_walkie.py.
"""

import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

from pack_walkie import scan

ROOT = Path(__file__).resolve().parent
RELEASE = ROOT / 'release'
OUT = RELEASE / 'radio-server'
NAME = 'radio-server'

FILES = {
    'README.md': ROOT / 'server-README.md',
    'server.py': ROOT / 'server.py',
    'autostart.py': ROOT / 'autostart.py',
    'index.html': ROOT / 'index.html',
    'widget.html': ROOT / 'widget.html',
    'css/style.css': ROOT / 'css' / 'style.css',
    'css/widget.css': ROOT / 'css' / 'widget.css',
    **{f'js/{p.name}': p for p in sorted((ROOT / 'js').glob('*.js'))},
    'js/worklets/capture.js': ROOT / 'js' / 'worklets' / 'capture.js',
}


def check_web_refs():
    """Всё, что подключают страницы, должно быть в списке FILES."""
    refs = set()
    for page in ('index.html', 'widget.html'):
        refs |= set(re.findall(r'(?:src|href)="((?:css|js)/[^"]+)"', (ROOT / page).read_text(encoding='utf-8')))
    for script in (ROOT / 'js').glob('*.js'):
        refs |= set(re.findall(r'[\'"`]((?:css|js)/[\w./-]+\.(?:js|css))[\'"`]', script.read_text(encoding='utf-8')))
    missing = sorted(refs - set(FILES))
    if missing:
        sys.exit('Страницы подключают файлы, которых нет в списке FILES: ' + ', '.join(missing))


def stage():
    if OUT.exists():
        shutil.rmtree(OUT)
    for rel, src in FILES.items():
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    (OUT / 'tools').mkdir()  # сюда кладётся caddy.exe, если понадобится HTTPS
    return sorted(FILES)


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    version = json.loads((ROOT / 'desktop' / 'package.json').read_text(encoding='utf-8'))['version']
    check_web_refs()
    files = stage()
    problems = scan(files, OUT)
    if problems:
        print('Найдено то, что не стоит отправлять — архив не создан:')
        for p in problems:
            print('  ' + p)
        sys.exit(1)
    print(f'Проверено файлов: {len(files)} — секретов и личных данных нет.')
    target = RELEASE / f'{NAME}-{version}.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:
            z.write(OUT / rel, f'{NAME}/{rel}')
        z.writestr(f'{NAME}/tools/', '')
    print(f'Архив сервера: {target} ({target.stat().st_size // 1024} КБ)')


if __name__ == '__main__':
    main()
