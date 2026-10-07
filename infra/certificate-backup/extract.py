#!/usr/bin/env python3
"""Extract only ordinary files/directories; preflight the entire archive first."""
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile

def extract(archive, target):
    target = Path(target)
    if target.exists() or target.is_symlink():
        raise ValueError('TARGET_MUST_NOT_EXIST')
    with tarfile.open(archive, 'r:gz') as source:
        seen = set()
        safe = []
        total = 0
        count = 0
        for entry in source:
            count += 1
            total += entry.size
            if count > 100000 or total > 32*1024**3 or entry.size < 0 or len(entry.name) > 512:
                raise ValueError('ARCHIVE_LIMIT_EXCEEDED')
            name = entry.name
            while name.startswith('./'):
                name = name[2:]
            if name in ('', '.') and entry.isdir():
                continue
            components = name.split('/')
            if name.startswith('/') or '\\' in name or any(p in ('..', '') for p in components) or '\0' in name:
                raise ValueError('UNSAFE_ARCHIVE_PATH')
            normal = str(PurePosixPath(name))
            if normal in seen or not (entry.isfile() or entry.isdir()) or entry.issym() or entry.islnk():
                raise ValueError('UNSAFE_ARCHIVE_MEMBER')
            seen.add(normal)
            safe.append((entry, normal))
        target.mkdir(mode=0o700)
        for entry, name in safe:
            destination = target / name
            if entry.isdir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as out, source.extractfile(entry) as content:
                    while block := content.read(1024*1024):
                        out.write(block)
                    out.flush()
                    os.fsync(out.fileno())
    return target

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: extract.py <archive.tar.gz> <new-staging-directory>')
    extract(sys.argv[1], sys.argv[2])
