#!/usr/bin/env python3
"""Synthesize vision test images: a white digit on a colored background,
placed at a random cell of a 3x3 grid.

Pure-stdlib PNG writer (zlib + struct). Ground truth (color/digit/position
and the base64 data URL) is written next to the images for the checker; the
prompt never contains any of those words.
"""
import base64
import json
import pathlib
import random
import struct
import sys
import zlib

DIGITS = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
}
COLORS = {
    "red": (220, 30, 30),
    "green": (30, 190, 60),
    "blue": (40, 80, 230),
    "yellow": (230, 210, 30),
    "purple": (150, 40, 210),
    "cyan": (30, 200, 210),
}
WIDTH = HEIGHT = 96
SCALE = 6  # 5x7 font * 6 -> 30x42 sprite


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def make_png(fill, digit, pad_x, pad_y) -> bytes:
    fg = (255, 255, 255)
    rows = []
    for y in range(HEIGHT):
        scan = bytearray()
        for x in range(WIDTH):
            lx = x - pad_x
            ly = y - pad_y
            on = (
                0 <= lx < 5 * SCALE
                and 0 <= ly < 7 * SCALE
                and DIGITS[digit][ly // SCALE][lx // SCALE] == "1"
            )
            scan += bytes(fg if on else fill)
        rows.append(b"\x00" + bytes(scan))
    ihdr = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )


def main():
    out_dir = pathlib.Path(sys.argv[1])
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else random.randrange(1 << 30)
    rng = random.Random(seed)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth = []
    for index in range(count):
        color = rng.choice(list(COLORS))
        digit = rng.choice(list(DIGITS))
        cell_x, cell_y = rng.randrange(3), rng.randrange(3)
        pad_x = 6 + cell_x * 28
        pad_y = 6 + cell_y * 18
        png = make_png(COLORS[color], digit, pad_x, pad_y)
        name = f"vision-{index}.png"
        (out_dir / name).write_bytes(png)
        truth.append(
            {
                "file": name,
                "color": color,
                "digit": digit,
                "position": ["left", "center", "right"][cell_x],
                "dataUrl": "data:image/png;base64," + base64.b64encode(png).decode(),
            }
        )
    (out_dir / "truth.json").write_text(
        json.dumps({"seed": seed, "images": truth}, indent=2)
    )
    print(json.dumps({"seed": seed, "count": count, "dir": str(out_dir)}))


if __name__ == "__main__":
    main()
