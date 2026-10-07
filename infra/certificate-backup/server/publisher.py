#!/usr/bin/env python3
"""Root receiver. No shell arguments, environment paths, secrets or ZFS delegation."""
import datetime
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile

BASE = Path('/srv/backup/avku-internal')
JOB = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
SHA = re.compile(r'^[0-9a-f]{64}$')
MAX_BYTES = 16 * 1024**3

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sync_dir(path):
    fd = os.open(path, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        raise ValueError('UNSAFE_FILE')
    return os.fdopen(fd, 'rb')

def json_file(path, limit=8192):
    with regular(path) as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('METADATA_TOO_LARGE')
    return json.loads(raw)

def archive(stream):
    """Verify a keyless tar.gz without extracting any file as root."""
    files = {}
    seen = set()
    metadata = {}
    total = 0
    count = 0
    try:
        with gzip.GzipFile(fileobj=stream, mode='rb') as compressed:
            with tarfile.open(fileobj=compressed, mode='r|') as source:
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
                    if name.startswith('/') or '\\' in name or '\0' in name or any(p in ('..', '') for p in name.split('/')):
                        raise ValueError('UNSAFE_ARCHIVE_PATH')
                    name = str(PurePosixPath(name))
                    if name in seen or not (entry.isfile() or entry.isdir()):
                        raise ValueError('UNSAFE_ARCHIVE_MEMBER')
                    seen.add(name)
                    if entry.isdir():
                        continue
                    if name in ('manifest.json', 'SHA256SUMS') and entry.size > 16*1024**2:
                        raise ValueError('METADATA_TOO_LARGE')
                    digest = hashlib.sha256()
                    size = 0
                    raw = bytearray()
                    with source.extractfile(entry) as content:
                        while block := content.read(1024*1024):
                            size += len(block)
                            digest.update(block)
                            if name in ('manifest.json', 'SHA256SUMS'):
                                raw.extend(block)
                    if size != entry.size:
                        raise ValueError('TRUNCATED_ARCHIVE_MEMBER')
                    files[name] = {'size': size, 'sha256': digest.hexdigest()}
                    if name in ('manifest.json', 'SHA256SUMS'):
                        metadata[name] = bytes(raw)
            # Read through the gzip footer: a bad CRC/truncated stream must fail.
            while block := compressed.read(1024*1024):
                total += len(block)
                if total > 32*1024**3:
                    raise ValueError('ARCHIVE_LIMIT_EXCEEDED')
        manifest = json.loads(metadata['manifest.json'])
        if manifest['formatVersion'] != 3 or manifest['schemaVersion'] != 4 or not JOB.fullmatch(manifest['jobId']):
            raise ValueError('UNSUPPORTED_BACKUP_FORMAT')
        stamp = datetime.datetime.fromisoformat(manifest['snapshotAt'].replace('Z', '+00:00'))
        if stamp.utcoffset() != datetime.timedelta(0):
            raise ValueError('INVALID_TIMESTAMP')
        expected = manifest['files']
        if set(files) != set(expected) | {'manifest.json', 'SHA256SUMS'}:
            raise ValueError('FILE_SET_MISMATCH')
        if any(files[name] != info for name, info in expected.items()):
            raise ValueError('INTERNAL_CHECKSUM_MISMATCH')
        checksums = ''.join(f"{info['sha256']}  {name}\n" for name, info in expected.items()).encode()
        if metadata['SHA256SUMS'] != checksums:
            raise ValueError('CHECKSUM_INDEX_MISMATCH')
        return {'format': 3, 'jobId': manifest['jobId'], 'snapshotAt': manifest['snapshotAt']}
    except (tarfile.TarError, OSError, EOFError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError('INVALID_ARTIFACT') from error

def check_mount():
    result = subprocess.run(['/usr/bin/findmnt', '-n', '-o', 'SOURCE,FSTYPE,TARGET', '--target', str(BASE)],
                            check=True, capture_output=True, text=True)
    if result.stdout.strip().split() != ['backup/avku-internal', 'zfs', str(BASE)]:
        raise ValueError('ZFS_MOUNT_MISMATCH')
    if BASE.resolve() != BASE or not os.path.ismount(BASE):
        raise ValueError('ZFS_MOUNT_MISMATCH')

class Publisher:
    def __init__(self, base=BASE, mount_check=check_mount):
        self.base = Path(base)
        self.mount_check = mount_check
        self.incoming = self.base / 'sftp/incoming'
        self.status = self.base / 'sftp/status'
        self.candidates = self.base / '.candidates'
        self.slots = self.base / 'slots'

    def checked(self):
        self.mount_check()
        for p in [self.base, self.base / 'sftp', self.incoming, self.status, self.candidates, self.slots]:
            if p.resolve() != p or not p.is_dir():
                raise ValueError('UNSAFE_DIRECTORY')
        if self.base == BASE:
            for p in [self.base, self.base / 'sftp', self.status, self.candidates, self.slots]:
                info = p.stat()
                if info.st_uid != 0 or info.st_mode & 0o022:
                    raise ValueError('UNSAFE_OWNERSHIP')
        device = self.base.stat().st_dev
        if any(p.stat().st_dev != device for p in [self.incoming, self.candidates, self.slots]):
            raise ValueError('CROSS_FILESYSTEM')

    def write_status(self, name, data):
        target = self.status / name
        temporary = self.status / (name + '.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
        try:
            with os.fdopen(fd, 'w') as out:
                os.fchown(out.fileno(), -1, self.status.stat().st_gid)
                # The installer deliberately uses umask 077. Status must still be
                # readable by the dedicated SFTP group, including on first install.
                os.fchmod(out.fileno(), 0o640)
                json.dump(data, out, separators=(',', ':'))
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, target)
            sync_dir(self.status)
        finally:
            if temporary.exists():
                temporary.unlink()

    def inventory(self):
        records = []
        for slot in ('slot-1', 'slot-2'):
            path = self.slots / slot
            if path.is_symlink():
                raise ValueError('UNSAFE_SLOT')
            if not path.exists():
                continue
            with regular(path) as stream:
                try:
                    header = archive(stream)
                except ValueError as error:
                    raise ValueError('EXISTING_SLOT_CORRUPTED') from error
                stream.seek(0)
                checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
            records.append(dict(header, slot=slot, size=path.stat().st_size, sha256=checksum, verifiedAt=utc()))
        return records

    def cleanup_inputs(self, job):
        if not JOB.fullmatch(job):
            raise ValueError('INVALID_JOB')
        for suffix in ('.partial', '.ready', '.marker.partial'):
            (self.incoming / (job + suffix)).unlink(missing_ok=True)
        (self.candidates / (job + '.partial')).unlink(missing_ok=True)
        sync_dir(self.incoming)
        sync_dir(self.candidates)

    def reconcile(self):
        records = self.inventory()
        for item in records:
            receipt = self.status / (item['jobId'] + '.json')
            if receipt.exists():
                previous = json_file(receipt)
                if previous.get('status') in ('succeeded', 'publishing'):
                    if previous.get('sha256') != item['sha256'] or previous.get('size') != item['size']:
                        raise ValueError('EXISTING_SLOT_CORRUPTED')
                    if type(previous.get('generation')) is not int or previous['generation'] < 1:
                        raise ValueError('MISSING_PUBLICATION_GENERATION')
                    item['generation'] = previous['generation']
                    item['committedAt'] = previous.get('committedAt', item['verifiedAt'])
                else:
                    raise ValueError('MISSING_PUBLICATION_RECEIPT')
            else:
                raise ValueError('MISSING_PUBLICATION_RECEIPT')
            try:
                self.cleanup_inputs(item['jobId'])
                item['cleanupPending'] = False
            except OSError:
                item['cleanupPending'] = True
                print(json.dumps({'jobId': item['jobId'], 'event': 'cleanup_error', 'at': utc()}), flush=True)
            self.write_status(item['jobId'] + '.json', dict(item, status='succeeded', committedAt=item['committedAt']))
        self.write_status('slots.json', {'slots': records, 'checkedAt': utc()})
        return records

    def publish(self, job):
        if not JOB.fullmatch(job):
            raise ValueError('INVALID_JOB')
        self.checked()
        marker = self.incoming / (job + '.ready')
        candidate = self.candidates / (job + '.partial')
        committed = False
        try:
            meta = json_file(marker)
            if set(meta) != {'jobId', 'size', 'sha256'} or meta['jobId'] != job:
                raise ValueError('INVALID_METADATA')
            if type(meta['size']) is not int or not 64 <= meta['size'] <= MAX_BYTES or not SHA.fullmatch(meta['sha256']):
                raise ValueError('INVALID_METADATA')
            records = self.reconcile()
            if any(item.get('cleanupPending') for item in records):
                raise ValueError('RETAINED_CLEANUP_PENDING')
            receipt = self.status / (job + '.json')
            if receipt.exists():
                old = json_file(receipt)
                if old.get('status') == 'succeeded':
                    if old.get('sha256') != meta['sha256']:
                        raise ValueError('JOB_CONTENT_CONFLICT')
                    committed = True
                    return old
            self.write_status(job + '.json', {'jobId': job, 'status': 'remote_verifying', 'updatedAt': utc()})
            if os.statvfs(self.base).f_bavail * os.statvfs(self.base).f_frsize < meta['size'] + 64*1024**2:
                raise ValueError('INSUFFICIENT_SPACE')
            # Never rename a file still writable through an SFTP open handle into a slot.
            # Copy to root-only storage; hash THAT immutable copy before publication.
            with regular(self.incoming / (job + '.partial')) as source:
                if os.fstat(source.fileno()).st_size != meta['size']:
                    raise ValueError('SIZE_MISMATCH')
                fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                os.fchown(fd, -1, self.slots.stat().st_gid)
                os.fchmod(fd, 0o640)
                with os.fdopen(fd, 'wb') as target:
                    remaining = meta['size']
                    digest = hashlib.sha256()
                    while remaining:
                        block = source.read(min(1024*1024, remaining))
                        if not block:
                            raise ValueError('TRUNCATED_CANDIDATE')
                        target.write(block)
                        digest.update(block)
                        remaining -= len(block)
                    if source.read(1) or digest.hexdigest() != meta['sha256']:
                        raise ValueError('CHECKSUM_MISMATCH')
                    target.flush()
                    os.fsync(target.fileno())
            with regular(candidate) as source:
                header = archive(source)
                if header['jobId'] != job:
                    raise ValueError('MANIFEST_JOB_MISMATCH')
            occupied = {r['slot'] for r in records}
            slot = next((s for s in ('slot-1', 'slot-2') if s not in occupied), None)
            if slot is None:
                # Revalidate the retained copy, not merely its header, against the prior receipt.
                for r in records:
                    previous = json_file(self.status / (r['jobId'] + '.json'))
                    if previous['sha256'] != r['sha256']:
                        raise ValueError('EXISTING_SLOT_CORRUPTED')
                slot = min(records, key=lambda r: r['generation'])['slot']
            generation = max((r['generation'] for r in records), default=0) + 1
            # Persist the publication reservation BEFORE the atomic file commit.
            # This recovers order after ACK loss and is independent of source UTC clock drift.
            self.write_status(job + '.json', {'jobId': job, 'status': 'publishing', 'updatedAt': utc(),
                              'generation': generation, 'slot': slot, 'size': meta['size'], 'sha256': meta['sha256']})
            self.checked()
            sync_dir(self.candidates)
            os.replace(candidate, self.slots / slot)
            committed = True
            sync_dir(self.slots)
            sync_dir(self.candidates)
            result = dict(header, slot=slot, size=meta['size'], sha256=meta['sha256'],
                          verifiedAt=utc(), committedAt=utc(), status='succeeded', generation=generation)
            self.write_status(job + '.json', result)
            self.reconcile()
            result = json_file(self.status / (job + '.json'))
            print(json.dumps({'jobId': job, 'event': 'publication', 'slot': slot,
                              'generation': generation,
                              'replacedJob': next((r['jobId'] for r in records if r['slot'] == slot), None),
                              'size': meta['size'], 'sha256': meta['sha256'], 'at': utc()}), flush=True)
            return result
        except Exception as error:
            code = str(error) if isinstance(error, ValueError) else type(error).__name__
            if not committed:
                receipt = self.status / (job + '.json')
                prior = json_file(receipt) if receipt.exists() else {}
                if prior.get('status') != 'succeeded':
                    self.write_status(job + '.json', {'jobId': job, 'status': 'failed', 'error': code, 'updatedAt': utc()})
            else:
                # A commit is irreversible. Reconstruct its receipt after an ACK/status failure.
                self.reconcile()
            print(json.dumps({'jobId': job, 'event': 'error', 'code': code, 'committed': committed, 'at': utc()}), flush=True)
            raise
        finally:
            try:
                self.cleanup_inputs(job)
            except OSError:
                prior = json_file(self.status / (job + '.json'))
                self.write_status(job + '.json', dict(prior, cleanupPending=True))
                print(json.dumps({'jobId': job, 'event': 'cleanup_error', 'at': utc()}), flush=True)

    def run(self):
        self.checked()
        fd = os.open(self.base / 'publisher.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            # Crash between slot rename and receipt is repaired from its verified manifest.
            for child in self.candidates.iterdir():
                if re.fullmatch(JOB.pattern[:-1] + r'\.partial$', child.name) and child.is_file() and not child.is_symlink():
                    child.unlink()
            self.reconcile()
            for marker in sorted(self.incoming.glob('*.ready')):
                job = marker.name[:-6]
                if JOB.fullmatch(job):
                    try:
                        self.publish(job)
                    except Exception:
                        pass

if __name__ == '__main__':
    if os.geteuid() != 0 or len(sys.argv) != 1:
        sys.exit('root-only; no arguments accepted')
    Publisher().run()
