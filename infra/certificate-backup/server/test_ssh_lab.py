#!/usr/bin/env python3
"""Black-box test of the exact production profile in an isolated container."""
import json
from pathlib import Path
import subprocess

root = Path('/tmp/avku-backup-baseline')
known = root / 'ssh-lab-known-hosts'
probe = root / 'sftp-test-probe'
public = subprocess.check_output(['docker', 'exec', 'avku-backup-ssh-lab', 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']).decode().split()
known.write_text('[192.168.0.151]:18184 ' + public[0] + ' ' + public[1] + '\n[127.0.0.1]:18184 ' + public[0] + ' ' + public[1] + '\n')
known.chmod(0o600)
probe.write_text('synthetic-probe')
probe.chmod(0o600)
options = ['-F', '/dev/null', '-i', '/home/hpelitdesk/.config/avku-certificate-backup/id_ed25519', '-oBatchMode=yes',
           '-oIdentitiesOnly=yes', '-oIdentityAgent=none', '-oStrictHostKeyChecking=yes', '-oUpdateHostKeys=no',
           '-oGlobalKnownHostsFile=/dev/null', '-oUserKnownHostsFile=' + str(known), '-oHostKeyAlgorithms=ssh-ed25519', '-oConnectTimeout=5']
cases = [
    ('incoming_upload', 'put ' + str(probe) + ' /incoming/probe.partial\n', True),
    ('ready_rename', 'rename /incoming/probe.partial /incoming/probe.ready\n', True),
    ('status_read', 'get /status/probe.json ' + str(root / 'sftp-read-status') + '\n', True),
    ('status_write', 'put ' + str(probe) + ' /status/forbidden.json\n', False),
    ('status_delete', 'rm /status/probe.json\n', False),
    ('slot_traversal', 'get /../slots/slot-1 ' + str(root / 'must-not-exist') + '\n', False),
    ('outside_chroot', 'get /srv/backup/avku-internal/slots/slot-1 ' + str(root / 'must-not-exist-2') + '\n', False),
    ('symlink', 'symlink /incoming/probe.ready /incoming/symlink\n', False),
    ('wrong_source_ip', 'ls\n', False),
]
results = []
for name, commands, expected in cases:
    host = '127.0.0.1' if name == 'wrong_source_ip' else '192.168.0.151'
    result = subprocess.run(['sftp', '-q', '-b', '-', '-P', '18184', *options, 'avku-backup@' + host],
                            input=commands, capture_output=True, text=True, timeout=10)
    results.append({'case': name, 'pass': (result.returncode == 0) == expected, 'exit': result.returncode})
subprocess.run(['ssh', '-T', '-p', '18184', *options, 'avku-backup@192.168.0.151', 'touch /tmp/forbidden-shell-probe'],
               input='', capture_output=True, text=True, timeout=5)
check = subprocess.run(['docker', 'exec', 'avku-backup-ssh-lab', 'test', '!', '-e', '/tmp/forbidden-shell-probe'])
results.append({'case': 'forced_sftp_prevents_shell', 'pass': check.returncode == 0})
print(json.dumps(results, indent=2))
(root / 'ssh-isolation-tests.json').write_text(json.dumps(results, indent=2))
assert all(item['pass'] for item in results)
