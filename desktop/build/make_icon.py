"""
Рисует значок приложения (icon.png, 256×256) без внешних библиотек.
Фигуры заданы функциями расстояния — так края получаются сглаженными.
Запуск: python make_icon.py
"""

import math
import struct
import zlib
from pathlib import Path

SIZE = 256


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(len(a)))


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


def rounded_rect(x, y, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    dx, dy = abs(x - cx) - hx, abs(y - cy) - hy
    return math.hypot(max(dx, 0), max(dy, 0)) + min(max(dx, dy), 0) - r


def circle(x, y, cx, cy, r):
    return math.hypot(x - cx, y - cy) - r


def segment(x, y, ax, ay, bx, by, w):
    px, py, vx, vy = x - ax, y - ay, bx - ax, by - ay
    t = max(0.0, min(1.0, (px * vx + py * vy) / (vx * vx + vy * vy)))
    return math.hypot(px - vx * t, py - vy * t) - w / 2


def cover(d):
    return max(0.0, min(1.0, 0.5 - d))


def pixel(x, y):
    rgb, alpha = (0.0, 0.0, 0.0), 0.0

    def paint(d, color, a=1.0):
        nonlocal rgb, alpha
        c = cover(d) * a
        if c <= 0:
            return
        rgb = mix(rgb, color, c / max(alpha + c * (1 - alpha), 1e-6)) if alpha else color
        alpha = alpha + c * (1 - alpha)

    # Корпус
    body = rounded_rect(x, y, 14, 14, 242, 242, 46)
    paint(body, mix(hex_rgb('#2c2d34'), hex_rgb('#141519'), y / SIZE))
    paint(abs(body + 1.5) - 1.2, hex_rgb('#3a3b43'), 0.8)

    # Окно шкалы с тёплой подсветкой
    scale = rounded_rect(x, y, 36, 46, 220, 114, 14)
    glow = max(0.0, 1 - math.hypot((x - 128) / 110, (y - 128) / 60))
    paint(scale, mix(hex_rgb('#1c1207'), hex_rgb('#8a5a1c'), glow ** 1.5))
    for i in range(14):
        tx = 52 + i * 11.7
        h = 20 if i % 2 == 0 else 11
        paint(segment(x, y, tx, 58, tx, 58 + h, 2.6), hex_rgb('#ffcf8a'), 0.95)

    # Стрелка
    paint(segment(x, y, 150, 52, 150, 108, 5), hex_rgb('#ff4b3e'))

    # Решётка динамика
    for gy in range(0, 8):
        for gx in range(0, 7):
            paint(circle(x, y, 44 + gx * 10, 138 + gy * 10, 3.1), hex_rgb('#0a0a0c'), 0.9)

    # Ручка настройки
    paint(circle(x, y, 174, 178, 46), hex_rgb('#101114'))
    ang = math.atan2(y - 178, x - 174)
    knurl = 0.5 + 0.5 * math.cos(ang * 40)
    paint(circle(x, y, 174, 178, 43), mix(hex_rgb('#1d1e23'), hex_rgb('#3a3b43'), knurl))
    shade = max(0.0, 1 - math.hypot(x - 160, y - 162) / 48)
    paint(circle(x, y, 174, 178, 34), mix(hex_rgb('#1d1e22'), hex_rgb('#5a5b63'), shade))
    paint(circle(x, y, 174, 152, 5.5), hex_rgb('#ffb547'))

    return rgb, alpha


def render(size, draw=None):
    """PNG нужного размера. Мелкие размеры — со сглаживанием по нескольким точкам на пиксель.
    draw — функция цвета точки (по умолчанию значок приёмника)."""
    draw = draw or pixel
    scale = SIZE / size
    samples = 1 if size == SIZE else 4
    rows = []
    for y in range(size):
        row = bytearray([0])  # фильтр строки PNG: без фильтра
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(samples):
                for sx in range(samples):
                    (r, g, b), a = draw((x + (sx + 0.5) / samples) * scale, (y + (sy + 0.5) / samples) * scale)
                    acc = [acc[0] + r * a, acc[1] + g * a, acc[2] + b * a, acc[3] + a]
            n = samples * samples
            alpha = acc[3] / n
            rgb = [c / acc[3] if acc[3] else 0 for c in acc[:3]]
            row += bytes(round(max(0, min(1, v)) * 255) for v in (*rgb, alpha))
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
        + chunk(b'IEND', b'')
    )


def ico(images):
    """ICO с PNG внутри (так умеют все Windows начиная с Vista)."""
    head = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b'', b''
    for size, png in images:
        dim = 0 if size >= 256 else size  # 0 означает 256
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(png), offset)
        blobs += png
        offset += len(png)
    return head + entries + blobs


def main():
    here = Path(__file__).parent
    images = [(size, render(size)) for size in (256, 64, 48, 32, 16)]
    (here / 'icon.png').write_bytes(images[0][1])
    (here / 'icon.ico').write_bytes(ico(images))
    print('icon.png и icon.ico готовы')


if __name__ == '__main__':
    main()
