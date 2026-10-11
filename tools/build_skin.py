"""Build the app's skin folder from the resources extracted out of the user's WMP11 installer.

Usage:  python -I tools/build_skin.py [extracted/wmploc] [app/renderer/skin]

Writes named PNGs (colour-keyed BMPs converted to real alpha) plus layout.json,
which holds glyph offsets and hit-map regions computed from WMP's mapping images.
"""
import json, os, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wmpimg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'extracted', 'wmploc')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'app', 'renderer', 'skin')
XP = 30000  # WMP11 on XP uses the +30000 glyph variants

# name -> resource id (tuple = preferred id first, then fallbacks)
IMAGES = {
    # title bar
    'top': 3961, 'logo': 4012,
    'cap': 4008, 'cap_hover': 4010, 'cap_down': 4009,
    'glyph_min': 4181, 'glyph_max': 4182, 'glyph_restore': 4183, 'glyph_close': 4184,
    # task bar / tabs
    'taskbar': 5100,
    'nav': 5230, 'nav_down': 5231, 'nav_hover': 5232, 'nav_disabled': 5233,
    'tab_hover': 5012, 'tab_down': 5011, 'tab_hoverhover': 5015, 'tab_arrow': 5239,
    # frame sides
    'side_left': 3995, 'side_right': 3960,
    # bottom
    'bottom': 3952, 'bottom_small': 3953,
    'transport_bg': (XP + 2164, 2164), 'transport_bg_small': (XP + 2165, 2165),
    'seek_bg': 4159, 'seek_fill': 3881, 'seek_thumb': 4059, 'seek_thumb_hover': 3884, 'seek_thumb_down': 3883,
    'round': 4723, 'round_down': 4724, 'round_hover': 4725,
    'tgroup': 4153, 'tgroup_down': 4154, 'tgroup_hover': 4155, 'tgroup_disabled': 4156,
    'glow': 4160,
    'vol_track': 5240, 'vol_thumb': 3885, 'vol_thumb_down': 3886, 'vol_thumb_hover': 3887,
    # compact transport (< 640px): split mute/volume button + volume pop-up
    'split': 4619, 'split_down': 4620, 'split_hover': 4621, 'split_hoverhover': 4625, 'vol_popup': 4616,
}
GLYPHS = {
    'play': 4162, 'play_disabled': 4163, 'pause': 4164, 'pause_disabled': 4165,
    'stop': 4179, 'prev': 4169, 'next': 4167,
    'shuffle_on': 4174, 'shuffle_off': 4175, 'repeat_on': 4176, 'repeat_off': 4177,
    'mute': 5244, 'vol0': 5248, 'vol1': 5245, 'vol2': 5246, 'vol3': 5247,
}
MAPS = {'cap_map': 4011, 'nav_map': 5234, 'tab_map': 5013, 'round_map': 4726, 'tgroup_map': 4157, 'split_map': 4622}
# Element colours inside each mapping image
REGIONS = {
    'cap_map': {'min': (255, 255, 0), 'max': (0, 255, 0), 'close': (255, 0, 0)},
    'nav_map': {'back': (0, 255, 0), 'forward': (255, 255, 0)},
    'tab_map': {'main': (0, 255, 0), 'drop': (0, 0, 255)},
    'round_map': {'btn': (255, 0, 0)},
    'tgroup_map': {'stop': (255, 0, 0), 'prev': (0, 255, 255), 'play': (0, 255, 0), 'next': (0, 0, 255)},
    'split_map': {'mute': (255, 0, 0), 'popup': (0, 255, 0)},
}


def resolve(rid):
    for r in (rid if isinstance(rid, tuple) else (rid,)):
        p = wmpimg.find(SRC, r)
        if p: return p
    raise FileNotFoundError(f'resource {rid} not found under {SRC}')


def bbox_of_colour(im, rgb):
    px = im.load(); xs = []; ys = []
    for y in range(im.height):
        for x in range(im.width):
            if px[x, y][:3] == rgb: xs.append(x); ys.append(y)
    return [min(xs), min(ys), max(xs) + 1, max(ys) + 1] if xs else None


def main():
    if os.path.isdir(OUT): shutil.rmtree(OUT)
    os.makedirs(OUT)
    layout = {'regions': {}, 'glyphs': {}, 'sizes': {}}

    for name, rid in IMAGES.items():
        im = wmpimg.load(resolve(rid)); im.save(os.path.join(OUT, name + '.png'))
        layout['sizes'][name] = im.size
    for name, rid in GLYPHS.items():
        im = wmpimg.load(resolve((XP + rid, rid))); im.save(os.path.join(OUT, 'g_' + name + '.png'))
        layout['sizes']['g_' + name] = im.size
        layout['glyphs'][name] = im.getbbox()  # visible pixels, for centring
    for name, rid in MAPS.items():
        im = wmpimg.load(resolve(rid), keys=None); im.save(os.path.join(OUT, name + '.png'))
        layout['regions'][name] = {el: bbox_of_colour(im, c) for el, c in REGIONS[name].items()}
        layout['sizes'][name] = im.size

    # Window icon: the largest frame of the first wmp.dll icon
    icons = os.path.join(os.path.dirname(SRC), 'wmp', 'icons')
    if os.path.isdir(icons):
        first = sorted(os.listdir(icons), key=lambda n: (len(n), n))[0]
        shutil.copy(os.path.join(icons, first), os.path.join(OUT, 'app.ico'))

    json.dump(layout, open(os.path.join(OUT, 'layout.json'), 'w'), indent=1)
    print(f'wrote {len(os.listdir(OUT))} files to {OUT}')


if __name__ == '__main__':
    main()
