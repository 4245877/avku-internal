import importlib.util
import hashlib
import json
import io
import tarfile
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publisher.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        for directory in ('sftp/incoming', 'sftp/status', '.candidates', 'slots'):
            (self.base / directory).mkdir(parents=True, mode=0o700)
        self.receiver = publisher.Publisher(self.base, lambda: None)

    def tearDown(self):
        self.temp.cleanup()

    def candidate(self, index=1):
        job = str(uuid.uuid4())
        files = {'database/certificates.sqlite': b'SQLite format 3\0' + os.urandom(200)}
        checks = {name: {'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()} for name, content in files.items()}
        manifest = {'formatVersion': 3, 'schemaVersion': 4, 'jobId': job,
                    'snapshotAt': f'2026-10-06T12:00:{index:02d}Z', 'files': checks}
        files['manifest.json'] = json.dumps(manifest).encode()
        files['SHA256SUMS'] = ''.join(f"{info['sha256']}  {name}\n" for name, info in checks.items()).encode()
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz', format=tarfile.USTAR_FORMAT) as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name); member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        content = output.getvalue()
        (self.receiver.incoming / (job + '.partial')).write_bytes(content)
        meta = {'jobId': job, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
        (self.receiver.incoming / (job + '.ready')).write_text(json.dumps(meta))
        return job, meta, content

    def snapshots(self):
        return {p.name: p.read_bytes() for p in self.receiver.slots.iterdir()}

    def seed(self):
        for index in (1, 2):
            job, _, _ = self.candidate(index)
            self.receiver.publish(job)
        return self.snapshots()

    def test_status_permissions_with_restrictive_installer_umask(self):
        old_umask = os.umask(0o077)
        try:
            self.receiver.run()
            catalog = self.receiver.status / 'slots.json'
            self.assertEqual(catalog.stat().st_mode & 0o777, 0o640)
            job, _, _ = self.candidate()
            self.receiver.publish(job)
            receipt = self.receiver.status / (job + '.json')
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o640)
            self.assertEqual(receipt.stat().st_gid, self.receiver.status.stat().st_gid)
            # A stale temporary file may have been created before this fix.
            temporary = self.receiver.status / 'slots.json.tmp'
            temporary.write_text('{}')
            temporary.chmod(0o600)
            self.receiver.reconcile()
            self.assertEqual(catalog.stat().st_mode & 0o777, 0o640)
        finally:
            os.umask(old_umask)

    def test_first_second_third_and_idempotent_ack(self):
        jobs = []
        for index in (1, 2, 3):
            job, meta, content = self.candidate(index)
            jobs.append(job)
            receipt = self.receiver.publish(job)
            self.assertEqual(receipt['status'], 'succeeded')
            self.assertEqual(len(self.snapshots()), min(index, 2))
        self.assertEqual({r['jobId'] for r in self.receiver.inventory()}, set(jobs[1:]))
        before = self.snapshots()
        # Lost acknowledgement: same job resolves to durable receipt without another rotation.
        (self.receiver.incoming / (job + '.ready')).write_text(json.dumps(meta))
        result = self.receiver.publish(job)
        self.assertEqual(result['jobId'], job)
        self.assertEqual(self.snapshots(), before)

    def test_bad_checksum_does_not_change_two_slots(self):
        before = self.seed()
        job, meta, _ = self.candidate(3)
        meta['sha256'] = '0'*64
        (self.receiver.incoming / (job + '.ready')).write_text(json.dumps(meta))
        with self.assertRaisesRegex(ValueError, 'CHECKSUM_MISMATCH'):
            self.receiver.publish(job)
        self.assertEqual(self.snapshots(), before)

    def test_atomic_replacement_preserves_old_open_reader(self):
        before = self.seed()
        job, _, content = self.candidate(3)
        with publisher.regular(self.receiver.slots / 'slot-1') as old_reader:
            self.receiver.publish(job)
            self.assertEqual(old_reader.read(), before['slot-1'])
        self.assertEqual((self.receiver.slots / 'slot-1').read_bytes(), content)
        self.assertEqual((self.receiver.slots / 'slot-2').read_bytes(), before['slot-2'])

    def test_commit_rename_failure_preserves_both_slots(self):
        before = self.seed()
        job, _, _ = self.candidate(3)
        original_replace = publisher.os.replace
        def replace(source, destination):
            if Path(destination).parent == self.receiver.slots:
                raise OSError('injected commit failure')
            return original_replace(source, destination)
        with patch.object(publisher.os, 'replace', replace):
            with self.assertRaises(OSError):
                self.receiver.publish(job)
        self.assertEqual(self.snapshots(), before)
        receipt = json.loads((self.receiver.status / (job + '.json')).read_text())
        self.assertEqual(receipt['status'], 'failed')
        self.assertFalse(list(self.receiver.candidates.iterdir()))

    def test_corrupted_archive_and_partial_file_preserve_slots(self):
        before = self.seed()
        job, meta, content = self.candidate(3)
        content = b'WRONGMAGIC' + content[10:]
        (self.receiver.incoming / (job + '.partial')).write_bytes(content)
        meta['sha256'] = hashlib.sha256(content).hexdigest()
        (self.receiver.incoming / (job + '.ready')).write_text(json.dumps(meta))
        with self.assertRaisesRegex(ValueError, 'INVALID_ARTIFACT'):
            self.receiver.publish(job)
        self.assertEqual(self.snapshots(), before)
        job, _, _ = self.candidate(3)
        (self.receiver.incoming / (job + '.partial')).write_bytes(b'partial')
        with self.assertRaisesRegex(ValueError, 'SIZE_MISMATCH'):
            self.receiver.publish(job)
        self.assertEqual(self.snapshots(), before)

    def test_internal_checksum_mismatch_and_unsafe_members_preserve_slots(self):
        before = self.seed()
        for unsafe in (False, True):
            job, meta, content = self.candidate(3)
            with tarfile.open(fileobj=io.BytesIO(content), mode='r:gz') as source:
                members = [(member, source.extractfile(member).read()) for member in source]
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz') as target:
                for member, data in members:
                    if member.name == 'database/certificates.sqlite':
                        if unsafe:
                            member.name = '../escape'
                        else:
                            data = b'X' + data[1:]
                    target.addfile(member, io.BytesIO(data))
            content = output.getvalue()
            (self.receiver.incoming / (job + '.partial')).write_bytes(content)
            meta.update(size=len(content), sha256=hashlib.sha256(content).hexdigest())
            (self.receiver.incoming / (job + '.ready')).write_text(json.dumps(meta))
            with self.assertRaisesRegex(ValueError, 'UNSAFE_ARCHIVE_PATH' if unsafe else 'INTERNAL_CHECKSUM_MISMATCH'):
                self.receiver.publish(job)
            self.assertEqual(self.snapshots(), before)

    def test_mount_mismatch_and_no_space_preserve_slots(self):
        before = self.seed()
        job, _, _ = self.candidate(3)
        self.receiver.mount_check = lambda: (_ for _ in ()).throw(ValueError('ZFS_MOUNT_MISMATCH'))
        with self.assertRaisesRegex(ValueError, 'ZFS_MOUNT_MISMATCH'):
            self.receiver.publish(job)
        self.assertEqual(self.snapshots(), before)
        self.receiver.mount_check = lambda: None
        with patch.object(publisher.os, 'statvfs') as available:
            available.return_value.f_bavail = 0
            available.return_value.f_frsize = 4096
            with self.assertRaisesRegex(ValueError, 'INSUFFICIENT_SPACE'):
                self.receiver.publish(job)
        self.assertEqual(self.snapshots(), before)

    def test_symlink_and_job_traversal_rejected(self):
        before = self.seed()
        job, _, _ = self.candidate(3)
        incoming = self.receiver.incoming / (job + '.partial')
        incoming.unlink()
        incoming.symlink_to(self.receiver.slots / 'slot-1')
        with self.assertRaises(OSError):
            self.receiver.publish(job)
        self.assertEqual(self.snapshots(), before)
        with self.assertRaisesRegex(ValueError, 'INVALID_JOB'):
            self.receiver.publish('../../slot-1')

    def test_crash_after_commit_reconstructs_receipt(self):
        before = self.seed()
        job, _, content = self.candidate(3)
        original = self.receiver.write_status
        def fail_ack(name, data):
            if name == job + '.json' and data.get('status') == 'succeeded':
                raise OSError('simulated status disk failure')
            return original(name, data)
        with patch.object(self.receiver, 'write_status', fail_ack):
            with self.assertRaises(OSError):
                self.receiver.publish(job)
        self.receiver.reconcile()
        receipt = json.loads((self.receiver.status / (job + '.json')).read_text())
        self.assertEqual(receipt['status'], 'succeeded')
        self.assertEqual(len(self.snapshots()), 2)
        self.assertEqual((self.receiver.slots / 'slot-2').read_bytes(), before['slot-2'])
        self.assertEqual((self.receiver.slots / 'slot-1').read_bytes(), content)

    def test_existing_corruption_blocks_rotation(self):
        self.seed()
        slot = self.receiver.slots / 'slot-2'
        slot.write_bytes(b'BROKEN' + slot.read_bytes()[6:])
        before = self.snapshots()
        job, _, _ = self.candidate(3)
        with self.assertRaisesRegex(ValueError, 'EXISTING_SLOT_CORRUPTED'):
            self.receiver.publish(job)
        self.assertEqual(self.snapshots(), before)

    def test_partial_without_ready_never_publishes(self):
        before = self.seed()
        job, _, _ = self.candidate(3)
        (self.receiver.incoming / (job + '.ready')).unlink()
        self.receiver.run()
        self.assertEqual(self.snapshots(), before)

    def test_source_clock_rollback_does_not_change_publication_order(self):
        self.seed()
        previous = self.receiver.reconcile()
        job, _, _ = self.candidate(0)
        self.receiver.publish(job)
        current = self.receiver.reconcile()
        self.assertEqual({item['generation'] for item in current}, {2, 3})
        self.assertIn(job, {item['jobId'] for item in current})
        self.assertIn(next(item['jobId'] for item in previous if item['generation'] == 2), {item['jobId'] for item in current})

    def test_failed_candidate_cleanup_error_is_durable(self):
        before = self.seed()
        job, meta, _ = self.candidate(3)
        meta['sha256'] = '0'*64
        (self.receiver.incoming / (job + '.ready')).write_text(json.dumps(meta))
        original = self.receiver.cleanup_inputs
        def cleanup(current):
            if current == job:
                raise OSError('injected cleanup failure')
            return original(current)
        with patch.object(self.receiver, 'cleanup_inputs', cleanup):
            with self.assertRaisesRegex(ValueError, 'CHECKSUM_MISMATCH'):
                self.receiver.publish(job)
        receipt = json.loads((self.receiver.status / (job + '.json')).read_text())
        self.assertEqual(receipt['status'], 'failed')
        self.assertTrue(receipt['cleanupPending'])
        self.assertEqual(self.snapshots(), before)
        self.receiver.run()
        self.assertEqual(json.loads((self.receiver.status / (job + '.json')).read_text())['status'], 'failed')
        self.assertFalse(json.loads((self.receiver.status / (job + '.json')).read_text()).get('cleanupPending', False))
        self.assertFalse((self.receiver.incoming / (job + '.ready')).exists())

    def test_retained_cleanup_failure_blocks_rotation(self):
        before = self.seed()
        retained = self.receiver.inventory()[0]['jobId']
        job, _, _ = self.candidate(3)
        original = self.receiver.cleanup_inputs
        def cleanup(current):
            if current == retained:
                raise OSError('injected cleanup failure')
            return original(current)
        with patch.object(self.receiver, 'cleanup_inputs', cleanup):
            with self.assertRaisesRegex(ValueError, 'RETAINED_CLEANUP_PENDING'):
                self.receiver.publish(job)
        self.assertEqual(self.snapshots(), before)

if __name__ == '__main__':
    unittest.main()
