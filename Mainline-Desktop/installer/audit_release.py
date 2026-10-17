"""Inspect the folder payload and embedded executable archive before distribution."""
import hashlib
from pathlib import Path
import runpy
from PyInstaller.archive.readers import CArchiveReader

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
POLICY = runpy.run_path(str(ROOT.parent / 'tools' / 'check_public_upload.py'))
# Reviewed vendor dependency inventory: package names, versions and NuGet hashes,
# with no user records or configuration. Any byte change requires a new review.
REVIEWED_MANIFESTS = {'_internal/pythonnet/runtime/Python.Runtime.deps.json':
    '1DF8757C717CDA3D84BA1059D6C0C8D728A64013AFCB2564F0EDB5FE4582053F'}


def main():
    payload = HERE / '.build' / '1.0' / 'dist' / 'Mainline'
    count = 0
    for path in payload.rglob('*'):
        if not path.is_file():
            continue
        name = path.relative_to(payload).as_posix()
        reason = POLICY['private_path'](name)
        content = path.read_bytes()
        if name in REVIEWED_MANIFESTS:
            assert hashlib.sha256(content).hexdigest().upper() == REVIEWED_MANIFESTS[name], name
            reason = ''
        assert not reason, name + ': ' + reason
        for label, pattern in POLICY['KEY_PATTERNS'].items():
            assert not pattern.search(content), name + ': ' + label
        count += 1
    archive = CArchiveReader(str(payload / 'Mainline.exe'))
    for name in archive.toc:
        assert not POLICY['private_path'](name), name
        raw = archive.extract(name)
        if raw:
            for label, pattern in POLICY['KEY_PATTERNS'].items():
                assert not pattern.search(raw), name + ': ' + label
    desktop = archive.extract('desktop')
    assert b'installed-1.0' in desktop
    assert b'--uninstall-background-task' in desktop
    source = HERE / '.build' / '1.0' / 'source' / 'public'
    public = payload / '_internal' / 'public'
    assert {p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file()} == {p.relative_to(public).as_posix() for p in public.rglob('*') if p.is_file()}
    for path in source.rglob('*'):
        if path.is_file():
            assert path.read_bytes() == (public / path.relative_to(source)).read_bytes()
    setup = ROOT / 'downloads' / 'Mainline-Setup-1.0.exe'
    digest = hashlib.sha256(setup.read_bytes()).hexdigest().upper()
    (ROOT / 'downloads' / 'Mainline-Setup-1.0.sha256').write_text(digest+'  '+setup.name+'\n',encoding='ascii')
    print(f'Privacy audit passed: {count} payload files; {len(archive.toc)} embedded archive entries; all public assets match staging.')
    print('SHA256:',digest)


if __name__ == '__main__':
    main()
