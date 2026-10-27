#!/usr/bin/env python3
"""Exercise the real SFTP policy with an ephemeral container and synthetic key.

Run explicitly after building ssh-lab.Dockerfile; never uses production secrets.
The source restriction is checked against the configured LAN address.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import uuid


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


def main():
    image = os.environ.get('AVKU_SSH_LAB_IMAGE', 'avku-backup-ssh-lab:audit-20261027')
    source = os.environ.get('AVKU_SSH_LAB_SOURCE', '192.168.0.151')
    name = 'avku-ssh-lab-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='avku-ssh-lab-') as directory:
        root = Path(directory)
        key = root / 'synthetic-key'
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key))
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        try:
            run('docker', 'run', '-d', '--name', name, '--network', 'host',
                '--entrypoint', '/usr/sbin/sshd', image, '-D', '-e',
                '-p', str(port), '-o', 'ListenAddress=127.0.0.1',
                '-o', 'PasswordAuthentication=no')
            run('docker', 'exec', '-i', name, 'sh', '-c',
                'cat > /etc/ssh/authorized_keys.d/avku-backup; '
                'chmod 644 /etc/ssh/authorized_keys.d/avku-backup; '
                'printf synthetic-status > /srv/backup/avku-internal/sftp/status/probe.json; '
                'chown root:avku-backup /srv/backup/avku-internal/sftp/status/probe.json; '
                'chmod 640 /srv/backup/avku-internal/sftp/status/probe.json',
                input=key.with_suffix('.pub').read_text())
            public = run('docker', 'exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub').stdout.split()
            known = root / 'known_hosts'
            known.write_text(f'[127.0.0.1]:{port} {public[0]} {public[1]}\n')
            known.chmod(0o600)
            for _ in range(100):
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError('isolated SSH listener did not start')
            probe = root / 'probe'
            probe.write_text('synthetic-probe')
            options = ['-F', '/dev/null', '-i', str(key), '-oBatchMode=yes',
                       '-oIdentitiesOnly=yes', '-oIdentityAgent=none',
                       '-oStrictHostKeyChecking=yes', '-oUpdateHostKeys=no',
                       '-oGlobalKnownHostsFile=/dev/null', '-oUserKnownHostsFile=' + str(known),
                       '-oHostKeyAlgorithms=ssh-ed25519', '-oConnectTimeout=5']
            cases = [
                ('incoming_upload', f'put {probe} /incoming/probe.partial\n', True),
                ('ready_rename', 'rename /incoming/probe.partial /incoming/probe.ready\n', True),
                ('status_read', f'get /status/probe.json {root / "status"}\n', True),
                ('status_write', f'put {probe} /status/forbidden.json\n', False),
                ('status_delete', 'rm /status/probe.json\n', False),
                ('slot_traversal', f'get /../slots/slot-1 {root / "forbidden"}\n', False),
                ('outside_chroot', f'get /srv/backup/avku-internal/slots/slot-1 {root / "outside"}\n', False),
                ('symlink', 'symlink /incoming/probe.ready /incoming/symlink\n', False),
                ('wrong_source_ip', 'ls\n', False),
            ]
            results = []
            for case, commands, expected in cases:
                bind = '127.0.0.1' if case == 'wrong_source_ip' else source
                result = subprocess.run(['sftp', '-q', '-b', '-', '-P', str(port),
                                         *options, '-oBindAddress=' + bind, 'avku-backup@127.0.0.1'],
                                        input=commands, capture_output=True, text=True, timeout=15)
                passed = (result.returncode == 0) == expected
                results.append({'case': case, 'pass': passed})
                if not passed:
                    print(case + ': ' + result.stderr, flush=True)
                    print(run('docker', 'logs', '--tail', '8', name).stderr, flush=True)
            subprocess.run(['ssh', '-T', '-p', str(port), *options, '-oBindAddress=' + source,
                            'avku-backup@127.0.0.1', 'touch /tmp/forbidden-shell-probe'],
                           input='', capture_output=True, text=True, timeout=10)
            check = subprocess.run(['docker', 'exec', name, 'test', '!', '-e', '/tmp/forbidden-shell-probe'],
                                   capture_output=True)
            results.append({'case': 'forced_sftp_prevents_shell', 'pass': check.returncode == 0})
            print(json.dumps(results, indent=2))
            assert all(item['pass'] for item in results), 'SFTP isolation check failed'
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True)


if __name__ == '__main__':
    main()
