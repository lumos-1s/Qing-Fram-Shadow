#!/usr/bin/env python3
"""按 Compositor/CameraRawTables.swift 的格式解 CameraRawTables.bin，
打印高光/阴影/白点/黑点在某亮度档下的灰轴响应，作为校准真值。"""
import lzma, sys

PATH = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:/Users/lumos/AppData/Local/Temp/compositor-ref/Compositor/Resources/CameraRawTables.bin"

raw = open(PATH, 'rb').read()
assert raw[:4] == b'CRT3', raw[:4]
size = int.from_bytes(raw[4:6], 'little')
count = int.from_bytes(raw[6:8], 'little')
step = int.from_bytes(raw[8:10], 'little')
print(f"size={size} count={count} step={step} file={len(raw)}")

planes = lzma.decompress(raw[10:])
cells = size ** 3 * 3
assert len(planes) == count * cells, (len(planes), count * cells)

level = [round(i * 255 / (size - 1)) for i in range(size)]

def table(index):
    """返回 17^3 × 3 的输出表，cell = ((r*size)+g)*size+b"""
    out = bytearray(count and size**3 * 3)
    for ch in range(3):
        base = (index * 3 + ch) * (size**3)
        running = 0
        for cell in range(size**3):
            running = (running + planes[base + cell]) & 0xFF
            delta = running - 256 if running > 127 else running
            axis = cell // (size * size) if ch == 0 else (cell // size) % size if ch == 1 else cell % size
            v = level[axis] + delta * step
            out[cell * 3 + ch] = 0 if v < 0 else 255 if v > 255 else v
    return out

def diagonal(index):
    t = table(index)
    n = size
    return [t[(i * n * n + i * n + i) * 3] for i in range(n)]   # 灰轴取 R 通道

BRIGHT = [53, 80, 104, 130, 160, 190, 224]
AVAL = [-100, -50, -25, 0, 25, 50, 100]

def adaptive(start, value, brightness):
    def between(v, pts):
        if v <= pts[0]: return 0, 0.0
        if v >= pts[-1]: return len(pts) - 2, 1.0
        for i in range(len(pts) - 1):
            if v <= pts[i + 1]:
                return i, (v - pts[i]) / (pts[i + 1] - pts[i])
    row, f = between(brightness, BRIGHT)
    col, g = between(value, AVAL)
    w = len(AVAL)
    a = diagonal(start + row * w + col)
    b = diagonal(start + (row + 1) * w + col)
    c = diagonal(start + row * w + col + 1)
    d = diagonal(start + (row + 1) * w + col + 1)
    return [((a[i] * (1 - g) + c[i] * g) * (1 - f) + (b[i] * (1 - g) + d[i] * g) * f) for i in range(size)]

def show(label, diag):
    # 映射到 0..255 输入亮度
    def at(v):
        x = v / 255 * (size - 1)
        i = min(size - 2, int(x)); f = x - i
        return round(diag[i] * (1 - f) + diag[i + 1] * f)
    pts = [64, 96, 128, 160, 192, 224, 255]
    print(f"{label:<26}", " ".join(f"{p:>4}" for p in pts))
    print(f"{'':<26}", " ".join(f"{at(p):>4}" for p in pts))

print("\n=== 高光（灰轴，亮度档 104 / 130 / 160）===")
print(f"{'输入':<26}", " ".join(f"{p:>4}" for p in [64, 96, 128, 160, 192, 224, 255]))
for b in (104, 130, 160):
    show(f"hi=-100 bright={b}", adaptive(187, -100, b))
show("hi=-100 (bright=128)", adaptive(187, -100, 128))

print("\n=== 阴影（灰轴，global 表）===")
for b in (104, 130, 160):
    show(f"sh=-30 bright={b}", adaptive(236, -30, b))

print("\n=== 白点 / 黑点 ===")
show("whites=+23", adaptive(102, 23, 130))
show("blacks=+26", adaptive(111, 26, 130))
