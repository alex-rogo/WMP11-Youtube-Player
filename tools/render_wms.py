"""Static preview renderer for WMP 7/8 skin folders (.wms XML + images).

Draws each visible element's resting image at its left/top position, which is enough to see
what a skin looks like. Script-driven positions (jscript:...) fall back to 0.

Usage:  python -I tools/render_wms.py <skins_dir> <out.png>
"""
import os, re, sys
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wmpimg

IMAGE_ATTRS = ('backgroundimage', 'image')


def read_wms(folder):
    name = next(n for n in os.listdir(folder) if n.lower().endswith('.wms'))
    raw = open(os.path.join(folder, name), 'rb').read()
    txt = raw[2:].decode('utf-16le') if raw[:2] == b'\xff\xfe' else raw.decode('latin-1')
    txt = re.sub(r'&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)', '&amp;', txt)
    return ET.fromstring(txt)


def attrs(el):
    return {k.lower(): v for k, v in el.attrib.items()}


def num(v, default=0):
    try: return int(float(v))
    except (TypeError, ValueError): return default


def colour(v):
    if not v or not v.startswith('#') or len(v) != 7: return None
    return tuple(int(v[i:i + 2], 16) for i in (1, 3, 5))


def find_file(folder, name):
    want = name.lower()
    for n in os.listdir(folder):
        if n.lower() == want: return os.path.join(folder, n)
    return None


def load(folder, name, key):
    p = find_file(folder, name)
    if not p: return None
    try:
        im = wmpimg.load(p, keys=None)
    except Exception:
        return None
    if key:
        px = im.load()
        for y in range(im.height):
            for x in range(im.width):
                if px[x, y][:3] == key: px[x, y] = (0, 0, 0, 0)
    return im


def draw(el, canvas, folder, ox, oy, z_items):
    a = attrs(el)
    if a.get('visible', '').lower() == 'false': return
    x, y = ox + num(a.get('left')), oy + num(a.get('top'))
    key = colour(a.get('transparencycolor', '#FF00FF'))
    z = num(a.get('zindex'))
    tag = el.tag.lower()
    bg = colour(a.get('backgroundcolor'))
    w, h = num(a.get('width')), num(a.get('height'))
    if bg and w and h and tag in ('subview', 'video', 'effects', 'playlist'):
        z_items.append((z, len(z_items), Image.new('RGBA', (w, h), bg + (255,)), x, y))
    for attr in IMAGE_ATTRS:
        v = a.get(attr)
        if v and not v.startswith(('jscript:', 'wmpprop:', 'res:')):
            im = load(folder, v, key)
            if im: z_items.append((z, len(z_items), im, x, y)); break
    for child in el:
        draw(child, canvas, folder, x, y, z_items)


def render(folder):
    root = read_wms(folder)
    view = next(e for e in root.iter() if e.tag.lower() == 'view')
    a = attrs(view)
    items = []
    draw(view, None, folder, -num(a.get('left')), -num(a.get('top')), items)
    w = max([num(a.get('width'))] + [x + im.width for _, _, im, x, y in items] + [1])
    h = max([num(a.get('height'))] + [y + im.height for _, _, im, x, y in items] + [1])
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    for _, _, im, x, y in sorted(items, key=lambda t: (t[0], t[1])):
        canvas.alpha_composite(im, (max(0, x), max(0, y)))
    return canvas


def main(skins_dir, out):
    tiles = []
    for name in sorted(os.listdir(skins_dir), key=str.lower):
        d = os.path.join(skins_dir, name)
        if not os.path.isdir(d): continue
        try: tiles.append((name, render(d)))
        except Exception as e: print('skip', name, e)
    cell_w, cell_h, cols = 420, 330, 4
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new('RGBA', (cols * cell_w, rows * cell_h), (58, 110, 165, 255))
    d = ImageDraw.Draw(sheet)
    try: font = ImageFont.truetype('segoeuib.ttf', 16)
    except OSError: font = ImageFont.load_default()
    for i, (name, im) in enumerate(tiles):
        im.thumbnail((cell_w - 20, cell_h - 44))
        cx, cy = (i % cols) * cell_w, (i // cols) * cell_h
        d.text((cx + 12, cy + 8), f'{i + 1}. {name}', fill='white', font=font)
        sheet.alpha_composite(im, (cx + (cell_w - im.width) // 2, cy + 36 + (cell_h - 44 - im.height) // 2))
    sheet.save(out)
    print(f'{len(tiles)} skins -> {out}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
