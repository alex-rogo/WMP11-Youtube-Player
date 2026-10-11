"""Extract the WMP11 artwork the app's skin is built from, out of your own WMP11 installer.

Usage:  python -I tools/extract_wmp11.py path\\to\\wmp11-windowsxp-x86-enu.exe [extracted]

Nothing from the installer is executed. The installer is a self-extracting cabinet: its CABINET
resource holds wmp11.exe, which in turn carries a cabinet with wmp.dll and wmploc.dll. Images
(resource type 257), bitmaps and icons are saved into extracted/wmploc and extracted/wmp, the
layout tools/build_skin.py reads. Requires Windows (expand.exe) and `pip install pefile`.
"""
import os, shutil, struct, subprocess, sys, tempfile
import pefile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def signer(path):
    """Authenticode signer subject via PowerShell (empty string if unsigned/unknown)."""
    try:
        out = subprocess.run(['powershell', '-NoProfile', '-Command',
                              f"$s = Get-AuthenticodeSignature -LiteralPath '{path}'; if ($s.Status -eq 'Valid') {{ $s.SignerCertificate.Subject }}"],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        return out
    except Exception:
        return ''


def resources(path):
    """Yield (type, name, data) for every resource in a PE file."""
    pe = pefile.PE(path, fast_load=True)
    pe.parse_data_directories([pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])
    if not hasattr(pe, 'DIRECTORY_ENTRY_RESOURCE'):
        return
    for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        tname = str(t.name) if t.name else t.id
        for n in t.directory.entries:
            name = str(n.name) if n.name else n.id
            for lang in n.directory.entries:
                yield tname, name, pe.get_data(lang.data.struct.OffsetToData, lang.data.struct.Size)


def expand(cab_bytes, out_dir, work):
    cab = os.path.join(work, 'tmp.cab')
    open(cab, 'wb').write(cab_bytes)
    os.makedirs(out_dir, exist_ok=True)
    subprocess.run([os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'expand.exe'), cab, '-F:*', out_dir],
                   check=True, capture_output=True)


def first_cab_in(path):
    """A cabinet embedded anywhere in a file (wmp11.exe keeps its payload outside the resources)."""
    d = open(path, 'rb').read()
    i = 0
    while (i := d.find(b'MSCF', i)) != -1:
        reserved, size = struct.unpack_from('<II', d, i + 4)
        if reserved == 0 and 0 < size <= len(d) - i:
            return d[i:i + size]
        i += 4
    raise ValueError(f'no cabinet found in {path}')


def bmp_file(dib):
    """Resource bitmaps are bare DIBs; prefix the BITMAPFILEHEADER."""
    hsize, = struct.unpack_from('<I', dib, 0)
    bits, = struct.unpack_from('<H', dib, 14)
    comp, = struct.unpack_from('<I', dib, 16)
    used, = struct.unpack_from('<I', dib, 32)
    colors = used or (1 << bits if bits <= 8 else 0)
    off = 14 + hsize + colors * 4 + (12 if comp == 3 and used == 0 else 0)
    return struct.pack('<2sIHHI', b'BM', 14 + len(dib), 0, 0, off) + dib


def save_dll(path, out):
    os.makedirs(out, exist_ok=True)
    icons, groups, n = {}, {}, 0
    for t, name, data in resources(path):
        if t == 257:                                    # PNG/GIF/BMP images
            ext = '.png' if data[:4] == b'\x89PNG' else '.gif' if data[:4] == b'GIF8' else '.bmp' if data[:2] == b'BM' else '.bin'
            sub = os.path.join(out, '257'); os.makedirs(sub, exist_ok=True)
            open(os.path.join(sub, f'{name}{ext}'), 'wb').write(data); n += 1
        elif t == pefile.RESOURCE_TYPE['RT_BITMAP']:
            sub = os.path.join(out, 'bitmaps'); os.makedirs(sub, exist_ok=True)
            open(os.path.join(sub, f'{name}.bmp'), 'wb').write(bmp_file(data)); n += 1
        elif t == pefile.RESOURCE_TYPE['RT_ICON']:
            icons[name] = data
        elif t == pefile.RESOURCE_TYPE['RT_GROUP_ICON']:
            groups[name] = data
    sub = os.path.join(out, 'icons'); os.makedirs(sub, exist_ok=True)
    for name, g in groups.items():                      # rebuild .ico files from icon groups
        count, = struct.unpack_from('<H', g, 4)
        entries = [struct.unpack_from('<BBBBHHIH', g, 6 + i * 14) for i in range(count)]
        entries = [e for e in entries if e[7] in icons]
        out_ico = struct.pack('<HHH', 0, 1, len(entries))
        offset, blobs = 6 + 16 * len(entries), b''
        for w, h, cc, r, planes, bits, _, iid in entries:
            blob = icons[iid]
            out_ico += struct.pack('<BBBBHHII', w, h, cc, r, planes, bits, len(blob), offset)
            offset += len(blob); blobs += blob
        open(os.path.join(sub, f'{name}.ico'), 'wb').write(out_ico + blobs)
    return n + len(groups)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    installer = os.path.abspath(sys.argv[1])
    dest = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(ROOT, 'extracted')

    who = signer(installer)
    if 'Microsoft Corporation' not in who:
        sys.exit(f'{installer} is not validly signed by Microsoft (signer: {who or "none"}); refusing to use it.')
    print('Signature OK:', who.split(',')[0])

    work = tempfile.mkdtemp(prefix='wmp11-')
    try:
        cab = next(d for t, name, d in resources(installer) if name == 'CABINET' and d[:4] == b'MSCF')
        stage1 = os.path.join(work, 'stage1'); expand(cab, stage1, work)
        stage2 = os.path.join(work, 'stage2'); expand(first_cab_in(os.path.join(stage1, 'wmp11.exe')), stage2, work)
        for dll, sub in (('wmploc.dll', 'wmploc'), ('wmp.dll', 'wmp')):
            n = save_dll(os.path.join(stage2, dll), os.path.join(dest, sub))
            print(f'{dll}: {n} resources -> {os.path.join(dest, sub)}')
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print('Done. Next: cd app && npm install && npm run skin')


if __name__ == '__main__':
    main()
