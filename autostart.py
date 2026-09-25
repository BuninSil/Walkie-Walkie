#!/usr/bin/env python3
"""
Автозапуск сервера эфира вместе с Windows и HTTPS через Caddy.

    python autostart.py on       — запускать при входе в Windows (и запустить сейчас)
    python autostart.py off      — убрать из автозапуска (и остановить)
    python autostart.py status   — что включено, что работает, получен ли сертификат
    python autostart.py restart  — перезапустить всё, например после обновления server.py

    python autostart.py https radio.example.ru   — включить HTTPS для этого домена
    python autostart.py https off                — выключить HTTPS

Сервер работает в фоне без окна и принимает подключения из сети (--host 0.0.0.0).
HTTPS обеспечивает Caddy (tools/caddy.exe): сам получает бесплатный сертификат
Let's Encrypt, продлевает его и передаёт запросы серверу.
Журналы — server.log и caddy.log рядом со скриптом.
Выключить автозапуск можно и в Диспетчере задач → «Автозагрузка приложений».
Права администратора не нужны: запись делается только для текущего пользователя.

Для сервера, на который никто не входит (VPS), — режим службы. Нужны права администратора:

    python autostart.py service on   — запускать при старте Windows, ещё до входа в систему,
                                       поднимать сервер, если он упал, и открыть порт в брандмауэре
    python autostart.py service off  — убрать службу и правило брандмауэра
"""

import argparse
import base64
import ctypes
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / 'server.py'
LOG = ROOT / 'server.log'
CADDYFILE = ROOT / 'Caddyfile'
CADDY_LOG = ROOT / 'caddy.log'
PORT = int(os.environ.get('RADIO_PORT', 8765))  # другой порт — только для проверок
RUN_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'
APPROVED_KEY = r'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
ENTRY = 'Radio Air Server'
TASK = 'Radio Air Server'       # задача планировщика в режиме службы
FIREWALL_GROUP = 'Radio Air'    # группа правил брандмауэра, чтобы легко найти и убрать
DOMAIN_RE = re.compile(r'^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$')


def pythonw():
    # pythonw.exe запускает скрипт без окна консоли
    candidate = Path(sys.executable).with_name('pythonw.exe')
    return candidate if candidate.exists() else Path(sys.executable)


def server_args():
    return [str(pythonw()), str(SERVER), '--host', '0.0.0.0', '--port', str(PORT), '--log', str(LOG)]


def caddy_exe():
    local = ROOT / 'tools' / 'caddy.exe'
    if local.exists():
        return local
    found = shutil.which('caddy')
    return Path(found) if found else None


def caddy_args():
    return [str(caddy_exe()), 'run', '--config', str(CADDYFILE), '--adapter', 'caddyfile']


def https_domain():
    if not CADDYFILE.exists():
        return None
    match = re.search(r'^(\S+)\s*\{', CADDYFILE.read_text(encoding='utf-8'), re.MULTILINE)
    return match.group(1) if match and match.group(1) != '{' else None


# ───────── Автозапуск (реестр текущего пользователя) ─────────

def boot_command():
    # При входе в Windows запускается «autostart.py boot», а он поднимает сервер и Caddy.
    # Пути — всегда в кавычках, как у других программ в автозагрузке: запись без кавычек
    # Windows пропускала молча (в журнале Shell-Core не было ни одной попытки запуска).
    return f'"{pythonw()}" "{Path(__file__).resolve()}" boot'


def autostart_state():
    """'on', 'off' или 'blocked' — запись есть, но отключена в Диспетчере задач."""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.QueryValueEx(key, ENTRY)
    except FileNotFoundError:
        return 'off'
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, APPROVED_KEY) as key:
            flags, _ = winreg.QueryValueEx(key, ENTRY)
            if flags and flags[0] & 1:  # нечётный первый байт — отключено пользователем
                return 'blocked'
    except FileNotFoundError:
        pass
    return 'on'


def enable_autostart():
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        winreg.SetValueEx(key, ENTRY, 0, winreg.REG_SZ, boot_command())
    # Если раньше отключали в Диспетчере задач — снимаем запрет
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, APPROVED_KEY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, ENTRY)
    except FileNotFoundError:
        pass


def disable_autostart():
    import winreg
    for path in (RUN_KEY, APPROVED_KEY):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, ENTRY)
        except FileNotFoundError:
            pass


# ───────── Фоновые процессы ─────────

def port_busy(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def wait_port(port, busy, seconds=5):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if port_busy(port) == busy:
            return True
        time.sleep(0.2)
    return False


def find_processes(name_like, marker):
    """Номера процессов, у которых в командной строке есть marker (путь к нашему файлу)."""
    script = (
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
        f"Get-CimInstance Win32_Process -Filter \"Name like '{name_like}'\" | "
        'Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress'
    )
    result = subprocess.run(
        ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
        capture_output=True, encoding='utf-8', errors='replace',
    )
    try:
        found = json.loads(result.stdout) if result.stdout.strip() else []
    except ValueError:
        return []
    if isinstance(found, dict):
        found = [found]
    target = str(marker).lower()
    return [p['ProcessId'] for p in found if target in (p.get('CommandLine') or '').lower()]


def spawn(args, log=None):
    # Отдельно от родителя и без окна, чтобы процесс жил после закрытия консоли
    flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    out = open(log, 'a', encoding='utf-8') if log else subprocess.DEVNULL
    options = dict(cwd=ROOT, stdin=subprocess.DEVNULL, stdout=out, stderr=out, close_fds=True)
    try:
        subprocess.Popen(args, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **options)
    except OSError:
        subprocess.Popen(args, creationflags=flags, **options)


def kill(pids):
    for pid in pids:
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)


def start_server(quiet=False):
    if port_busy(PORT):
        if not quiet:
            print(f'Сервер уже работает: http://localhost:{PORT}')
        return True
    spawn(server_args())
    if wait_port(PORT, busy=True):
        if not quiet:
            print(f'Сервер запущен в фоне: http://localhost:{PORT}')
        return True
    if not quiet:
        print(f'Сервер не запустился. Подробности в журнале: {LOG}')
    return False


def stop_server():
    pids = find_processes('python%', SERVER)
    kill(pids)
    if pids:
        wait_port(PORT, busy=False)
        print('Сервер остановлен.')
    elif port_busy(PORT):
        print(f'Порт {PORT} занят, но фоновый сервер не найден — возможно, он запущен вручную в окне консоли.')


def start_caddy(quiet=False):
    domain = https_domain()
    if not domain:
        return False
    if not caddy_exe():
        if not quiet:
            print('HTTPS настроен, но Caddy не найден: положите caddy.exe в папку tools.')
        return False
    if find_processes('caddy%', CADDYFILE):
        if not quiet:
            print(f'HTTPS уже работает: https://{domain}')
        return True
    spawn(caddy_args(), CADDY_LOG)
    if wait_port(443, busy=True, seconds=8):
        if not quiet:
            print(f'HTTPS запущен: https://{domain}')
        return True
    if not quiet:
        print(f'Caddy не запустился. Подробности в журнале: {CADDY_LOG}')
    return False


def stop_caddy():
    pids = find_processes('caddy%', CADDYFILE)
    kill(pids)
    if pids:
        wait_port(443, busy=False)
        print('HTTPS остановлен.')


# ───────── Служба: запуск при старте Windows, без входа в систему (VPS) ─────────
#
# Задача планировщика от имени SYSTEM запускает «autostart.py supervise», а он держит сервер
# (и Caddy, если включён HTTPS) запущенными и поднимает их, если они упали.

def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


def powershell(script):
    """Выполняет скрипт PowerShell. Через -EncodedCommand, чтобы пути с кириллицей дошли как есть."""
    full = '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + script
    encoded = base64.b64encode(full.encode('utf-16-le')).decode('ascii')
    return subprocess.run(
        ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        capture_output=True, encoding='utf-8', errors='replace',
    )


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def task_script():
    argument = f'"{Path(__file__).resolve()}" supervise'
    return (
        f'$action = New-ScheduledTaskAction -Execute {ps_quote(pythonw())} -Argument {ps_quote(argument)} '
        f'-WorkingDirectory {ps_quote(ROOT)}; '
        # Через полминуты после старта Windows — к этому времени сеть уже поднята
        '$trigger = New-ScheduledTaskTrigger -AtStartup; $trigger.Delay = "PT30S"; '
        "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; "
        # Без предела времени (по умолчанию Windows останавливает задачу через 3 дня) и с перезапуском
        '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 '
        '-RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries '
        '-DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew; '
        f'Register-ScheduledTask -TaskName {ps_quote(TASK)} -Description {ps_quote("Сервер эфира «Радио»")} '
        '-Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null'
    )


def firewall_ports():
    return [PORT, 80, 443] if https_domain() else [PORT]


def firewall_script(ports):
    listed = ','.join(map(str, ports))
    return (
        f'Get-NetFirewallRule -Group {ps_quote(FIREWALL_GROUP)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule; '
        f'New-NetFirewallRule -DisplayName {ps_quote(f"Радио: эфир (TCP {listed})")} -Group {ps_quote(FIREWALL_GROUP)} '
        f'-Direction Inbound -Protocol TCP -LocalPort {listed} -Action Allow -Profile Any | Out-Null'
    )


def service_state():
    """None — службы нет; иначе состояние задачи: Ready, Running, Disabled…"""
    result = powershell(f'(Get-ScheduledTask -TaskName {ps_quote(TASK)} -ErrorAction SilentlyContinue).State')
    return result.stdout.strip() or None


def firewall_state():
    result = powershell(
        f'(Get-NetFirewallRule -Group {ps_quote(FIREWALL_GROUP)} -ErrorAction SilentlyContinue | '
        'Get-NetFirewallPortFilter).LocalPort -join ","'
    )
    return result.stdout.strip() if result.returncode == 0 else None


def last_error(result):
    lines = [line.strip() for line in (result.stderr or result.stdout).splitlines() if line.strip()]
    return lines[0] if lines else f'код {result.returncode}'


def need_admin():
    if is_admin():
        return False
    print('Нужны права администратора: откройте PowerShell «от имени администратора» и повторите команду.')
    return True


def update_firewall():
    result = powershell(firewall_script(firewall_ports()))
    if result.returncode != 0:
        print(f'Не удалось открыть порт в брандмауэре: {last_error(result)}')
        return False
    print(f'Брандмауэр: открыт TCP {", ".join(map(str, firewall_ports()))}.')
    return True


def start_service():
    powershell(f'Start-ScheduledTask -TaskName {ps_quote(TASK)}')
    if wait_port(PORT, busy=True, seconds=15):
        print(f'Сервер работает: http://localhost:{PORT}')
        return True
    print(f'Сервер не запустился. Подробности в журнале: {LOG}')
    return False


def stop_service():
    powershell(f'Stop-ScheduledTask -TaskName {ps_quote(TASK)} -ErrorAction SilentlyContinue')
    stop_caddy()
    stop_server()


def enable_service():
    if need_admin():
        return 1
    if 'WindowsApps' in str(pythonw()):
        print('Python из Microsoft Store не подходит для службы. Поставьте Python с python.org и повторите.')
        return 1
    result = powershell(task_script())
    if result.returncode != 0:
        print(f'Не удалось создать задачу автозапуска: {last_error(result)}')
        return 1
    print('Служба настроена: сервер будет стартовать вместе с Windows, даже если никто не входит в систему.')
    if not update_firewall():
        return 1
    # Запуск при входе больше не нужен, а сервер, запущенный от вашего имени, уступает место службе
    disable_autostart()
    stop_caddy()
    stop_server()
    return 0 if start_service() else 1


def disable_service():
    if need_admin():
        return 1
    stop_service()
    powershell(
        f'Unregister-ScheduledTask -TaskName {ps_quote(TASK)} -Confirm:$false -ErrorAction SilentlyContinue; '
        f'Get-NetFirewallRule -Group {ps_quote(FIREWALL_GROUP)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule'
    )
    print('Служба и правило брандмауэра убраны.')
    return 0


def note(message):
    with open(LOG, 'a', encoding='utf-8') as log:
        log.write(f'{time.strftime("%Y-%m-%d %H:%M:%S")}  {message}\n')


def supervise():
    """Работает внутри службы: держит сервер и Caddy запущенными, упавшие поднимает снова."""
    children = {}  # имя → (процесс, когда запущен)
    delay = {}     # имя → пауза перед следующей попыткой, если процесс сразу падает
    next_try = {}
    note('Служба запущена.')
    while True:
        wanted = {'сервер': (server_args(), None, PORT)}
        if https_domain() and caddy_exe():
            wanted['Caddy'] = (caddy_args(), CADDY_LOG, 443)
        for name in [n for n in children if n not in wanted]:
            children.pop(name)  # HTTPS выключили — Caddy остановлен командой «https off»
        for name, (args, log, port) in wanted.items():
            proc, started = children.get(name, (None, 0))
            if proc and proc.poll() is None:
                continue
            now = time.time()
            if proc:
                # Упал сразу после запуска — пробуем реже, чтобы не засорять журнал
                delay[name] = min(300, delay.get(name, 5) * 2) if now - started < 30 else 5
                next_try[name] = now + delay[name]
                note(f'{name} остановился (код {proc.returncode}), перезапуск через {delay[name]} с.')
                children.pop(name)
                continue
            if now < next_try.get(name, 0):
                continue
            if port_busy(port):
                continue  # порт уже занят — например, сервер запущен вручную
            out = open(log, 'a', encoding='utf-8') if log else subprocess.DEVNULL
            children[name] = (subprocess.Popen(
                args, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                creationflags=subprocess.CREATE_NO_WINDOW,
            ), now)
            if log:
                out.close()  # у процесса своя копия
        time.sleep(5)


# ───────── HTTPS ─────────

def write_caddyfile(domain, email):
    options = ['\t# Ничего не добавлять в системное хранилище сертификатов', '\tskip_install_trust']
    if email:
        options.append(f'\temail {email}')
    CADDYFILE.write_text(
        '# Создано autostart.py: HTTPS для эфира через Caddy\n'
        '{\n' + '\n'.join(options) + '\n}\n\n'
        f'{domain} {{\n'
        f'\treverse_proxy 127.0.0.1:{PORT}\n'
        '}\n',
        encoding='utf-8',
    )


def certificate_state(domain):
    """Что Caddy отдаёт по этому домену: (True, 'Let's Encrypt, до 20.12.2026') или (False, причина)."""
    context = ssl.create_default_context()
    try:
        with socket.create_connection(('127.0.0.1', 443), timeout=3) as raw:
            with context.wrap_socket(raw, server_hostname=domain) as tls:
                cert = tls.getpeercert()
    except ssl.SSLCertVerificationError:
        return False, 'ещё не получен (Caddy пока отдаёт временный)'
    except ssl.SSLError:
        return False, 'ещё не получен'
    except OSError:
        return False, 'Caddy не отвечает'
    issuer = dict(item[0] for item in cert.get('issuer', ())).get('organizationName', '?')
    until = time.strftime('%d.%m.%Y', time.gmtime(ssl.cert_time_to_seconds(cert['notAfter'])))
    return True, f'{issuer}, действует до {until}'


def enable_https(domain, email):
    try:
        domain = domain.strip().lower().rstrip('.').encode('idna').decode('ascii')
    except UnicodeError:
        domain = ''
    if not DOMAIN_RE.match(domain):
        print('Это не похоже на домен. Пример: python autostart.py https radio.example.ru')
        return 1
    if email and '@' not in email:
        print('Почта указана с ошибкой.')
        return 1
    if not caddy_exe():
        print('Сначала положите caddy.exe в папку tools (см. README, раздел HTTPS).')
        return 1
    service = service_state()
    if service and need_admin():
        return 1
    stop_caddy()
    write_caddyfile(domain, email)
    if service:
        # Caddy запустит сама служба, нужно только открыть для него порты
        if not update_firewall():
            return 1
        if not wait_port(443, busy=True, seconds=15):
            print(f'Caddy не запустился. Подробности в журнале: {CADDY_LOG}')
            return 1
        print(f'HTTPS запущен: https://{domain}')
    else:
        if autostart_state() == 'on':
            enable_autostart()  # обновляем команду автозапуска — теперь она поднимает и Caddy
        start_server()
        if not start_caddy():
            return 1
    print()
    print('Caddy получает сертификат, обычно это меньше минуты. Для этого из интернета должны быть доступны')
    print('порты 80 и 443 (на VPS — открыты в панели провайдера, дома — проброшены в роутере),')
    print('а домен должен указывать на IP сервера.')
    print('Проверить: python autostart.py status')
    return 0


def disable_https():
    stop_caddy()
    if CADDYFILE.exists():
        CADDYFILE.unlink()
    if service_state() and is_admin():
        update_firewall()  # порты 80 и 443 больше не нужны
    print(f'HTTPS выключен. Эфир по-прежнему доступен по http://localhost:{PORT}.')
    return 0


# ───────── Команды ─────────

def show_status():
    service = service_state()
    if service:
        print(f'Автозапуск: служба — при старте Windows, без входа в систему (задача: {service})')
        ports = firewall_state()
        if ports:
            print(f'Брандмауэр: открыт TCP {ports}')
        elif ports is not None:
            print('Брандмауэр: правила нет (python autostart.py service on от имени администратора)')
    else:
        print({
            'on': 'Автозапуск: при входе в Windows',
            'off': 'Автозапуск: выключен',
            'blocked': 'Автозапуск: отключён в Диспетчере задач (python autostart.py on снова включит)',
        }[autostart_state()])
    if port_busy(PORT):
        pids = find_processes('python%', SERVER)
        where = f'в фоне, процесс {", ".join(map(str, pids))}' if pids else 'вручную, в окне консоли'
        print(f'Сервер: работает ({where}) — http://localhost:{PORT}')
    else:
        print('Сервер: не работает')

    domain = https_domain()
    if not domain:
        print('HTTPS: выключен')
    elif not caddy_exe():
        print(f'HTTPS: https://{domain} — но caddy.exe не найден в папке tools')
    elif not find_processes('caddy%', CADDYFILE):
        print(f'HTTPS: https://{domain} — Caddy не запущен (python autostart.py restart)')
    else:
        ok, detail = certificate_state(domain)
        print(f'HTTPS: https://{domain} — сертификат {detail}')
        if not ok:
            print(f'       Подробности в журнале: {CADDY_LOG}')
    print(f'Журналы: {LOG.name}, {CADDY_LOG.name}')


def main():
    if sys.platform != 'win32':
        print('Этот скрипт — для Windows. На Linux сервер удобнее запускать через systemd.')
        return 1
    if sys.stdout is not None:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')

    parser = argparse.ArgumentParser(description='Автозапуск сервера эфира и HTTPS')
    parser.add_argument('action', choices=['on', 'off', 'status', 'start', 'stop', 'restart', 'https', 'service', 'boot', 'supervise'])
    parser.add_argument('domain', nargs='?', help='для https: домен или off; для service: on или off')
    parser.add_argument('email', nargs='?', help='для https: почта для Let\'s Encrypt (необязательно)')
    args = parser.parse_args()

    if args.action == 'supervise':
        supervise()
        return 0
    if args.action == 'service':
        if args.domain == 'on':
            return enable_service()
        if args.domain == 'off':
            return disable_service()
        print('Укажите: python autostart.py service on   или   python autostart.py service off')
        return 1

    # Если сервер работает как служба, запуском и остановкой управляет она
    service = args.action in ('on', 'off', 'start', 'stop', 'restart') and service_state()
    if service:
        if args.action == 'on':
            print('Сервер уже запускается как служба — при старте Windows. Отдельный автозапуск не нужен.')
            return 0
        if args.action == 'off':
            print('Сервер работает как служба. Убрать её: python autostart.py service off')
            return 1
        if need_admin():
            return 1
        if args.action in ('stop', 'restart'):
            stop_service()
        if args.action in ('start', 'restart'):
            return 0 if start_service() else 1
        return 0

    if args.action == 'on':
        enable_autostart()
        print('Автозапуск включён: сервер будет стартовать при входе в Windows.')
        start_server()
        start_caddy()
    elif args.action == 'off':
        disable_autostart()
        print('Автозапуск выключен.')
        stop_caddy()
        stop_server()
    elif args.action == 'status':
        show_status()
    elif args.action in ('start', 'boot'):
        quiet = args.action == 'boot'  # при входе в Windows печатать некуда
        start_server(quiet)
        start_caddy(quiet)
    elif args.action == 'stop':
        stop_caddy()
        stop_server()
    elif args.action == 'restart':
        stop_caddy()
        stop_server()
        start_server()
        start_caddy()
    elif args.action == 'https':
        if not args.domain:
            print('Укажите домен: python autostart.py https radio.example.ru')
            return 1
        if args.domain == 'off':
            return disable_https()
        return enable_https(args.domain, args.email)
    return 0


if __name__ == '__main__':
    sys.exit(main())
