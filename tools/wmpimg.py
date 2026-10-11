"""Load WMP resource images (PNG/GIF/BMP incl. RLE8) as RGBA, applying colour-key transparency."""
import os, struct
from PIL import Image

def _rle8(path):
    b = open(path, 'rb').read()
    off = struct.unpack_from('<I', b, 10)[0]
    _, w, h, _, bc, comp, _, _, _, cu = struct.unpack_from('<IiiHHIIiiI', b, 14)
    n = cu or 256
    pal = [tuple(b[54 + i*4: 54 + i*4 + 3][::-1]) for i in range(n)]
    px = bytearray(w * abs(h)); x = y = 0; i = off
    while i < len(b) - 1:
        c, v = b[i], b[i+1]; i += 2
        if c:
            for _ in range(c):
                if x < w and y < abs(h): px[y*w + x] = v
                x += 1
        elif v == 0: x = 0; y += 1
        elif v == 1: break
        elif v == 2: x += b[i]; y += b[i+1]; i += 2
        else:
            for k in range(v):
                if x < w and y < abs(h): px[y*w + x] = b[i+k]
                x += 1
            i += v + (v & 1)
    im = Image.frombytes('P', (w, abs(h)), bytes(px))
    flat = [c for rgb in pal for c in rgb]; im.putpalette(flat + [0] * (768 - len(flat)))
    return im.transpose(Image.FLIP_TOP_BOTTOM) if h > 0 else im

def find(root, rid):
    for d, ext in (('257', 'png'), ('257', 'gif'), ('257', 'bmp'), ('bitmaps', 'bmp')):
        p = os.path.join(root, d, f'{rid}.{ext}')
        if os.path.exists(p): return p
    return None

def load(path, keys=((255, 0, 255), (240, 240, 240))):
    # Pillow silently mis-decodes some RLE8 bitmaps (e.g. 32165), so those always use _rle8.
    if path.lower().endswith('.bmp') and struct.unpack_from('<I', open(path, 'rb').read(34), 30)[0] == 1:
        im = _rle8(path)
    else:
        try:
            im = Image.open(path); im.load()
        except Exception:
            im = _rle8(path)
    im = im.convert('RGBA')
    if path.lower().endswith('.bmp') and keys:
        px = im.load()
        for yy in range(im.height):
            for xx in range(im.width):
                if px[xx, yy][:3] in keys: px[xx, yy] = (0, 0, 0, 0)
    return im
