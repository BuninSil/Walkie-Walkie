"""
Значок отдельной программы «Рация» (walkie.png, walkie.ico): корпус рации с антенной,
экраном и клавиатурой. Рисуется теми же средствами, что и значок приёмника.
Запуск: python make_walkie_icon.py
"""

import math
from pathlib import Path

from make_icon import SIZE, circle, cover, hex_rgb, ico, mix, render, rounded_rect, segment


def pixel(x, y):
    rgb, alpha = (0.0, 0.0, 0.0), 0.0

    def paint(d, color, a=1.0):
        nonlocal rgb, alpha
        c = cover(d) * a
        if c <= 0:
            return
        rgb = mix(rgb, color, c / max(alpha + c * (1 - alpha), 1e-6)) if alpha else color
        alpha = alpha + c * (1 - alpha)

    # Антенна и ручка громкости сверху
    paint(rounded_rect(x, y, 150, 6, 182, 70, 14), mix(hex_rgb('#26272d'), hex_rgb('#101114'), y / 70))
    paint(rounded_rect(x, y, 84, 30, 114, 60, 8), hex_rgb('#1a1b20'))

    # Корпус
    body = rounded_rect(x, y, 48, 50, 208, 250, 30)
    paint(body, mix(hex_rgb('#2c2d34'), hex_rgb('#141519'), (y - 50) / 200))
    paint(abs(body + 1.5) - 1.2, hex_rgb('#3a3b43'), 0.8)

    # Тангента сбоку и индикатор передачи
    paint(rounded_rect(x, y, 38, 104, 52, 158, 5), hex_rgb('#ffb547'))
    paint(circle(x, y, 188, 68, 6), hex_rgb('#ff4b3e'))

    # Экран с зелёной подсветкой
    screen = rounded_rect(x, y, 68, 80, 188, 146, 10)
    glow = max(0.0, 1 - math.hypot((x - 128) / 80, (y - 113) / 45))
    paint(screen, mix(hex_rgb('#4f6134'), hex_rgb('#c4d98f'), glow ** 1.2))
    paint(segment(x, y, 84, 100, 172, 100, 6), hex_rgb('#1d2612'), 0.85)
    paint(segment(x, y, 84, 124, 140, 124, 11), hex_rgb('#1d2612'), 0.9)

    # Клавиатура 3×3
    for row in range(3):
        for col in range(3):
            kx, ky = 72 + col * 40, 166 + row * 26
            key = rounded_rect(x, y, kx, ky, kx + 32, ky + 18, 5)
            paint(key, hex_rgb('#e8a13c') if (row, col) == (0, 0) else hex_rgb('#3c3d45'))

    return rgb, alpha


def main():
    here = Path(__file__).parent
    images = [(size, render(size, pixel)) for size in (256, 64, 48, 32, 16)]
    (here / 'walkie.png').write_bytes(images[0][1])
    (here / 'walkie.ico').write_bytes(ico(images))
    print('walkie.png и walkie.ico готовы')


if __name__ == '__main__':
    main()
