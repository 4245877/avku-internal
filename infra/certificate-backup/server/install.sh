#!/bin/bash
set -euo pipefail
umask 077
test "$(id -u)" = 0 || { echo 'Run through an authenticated sudo session.' >&2; exit 1; }
test "$#" = 1 || { echo 'Usage: sudo ./install.sh <dedicated-public-key-file>' >&2; exit 1; }
installer_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
backup_base=/srv/backup/avku-internal
test "$(findmnt -n -o SOURCE,FSTYPE,TARGET --target "$backup_base")" = "backup/avku-internal zfs $backup_base"
test "$(realpath "$backup_base")" = "$backup_base"
ssh-keygen -l -f "$1" >/dev/null
test "$(awk 'NR==1 {print $1} END {if(NR!=1) exit 1}' "$1")" = ssh-ed25519
if ! getent passwd avku-backup >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir /incoming --shell /usr/sbin/nologin avku-backup
fi
test "$(id -nG avku-backup)" = avku-backup
test "$(id -u avku-backup)" -ge 100
test "$(getent passwd avku-backup | cut -d: -f7)" = /usr/sbin/nologin
passwd -l avku-backup >/dev/null
zfs set exec=off setuid=off devices=off atime=off compression=zstd backup/avku-internal
chown root:miha "$backup_base"
chmod 0750 "$backup_base"
install -d -o root -g avku-backup -m 0750 "$backup_base/sftp" "$backup_base/sftp/status"
install -d -o avku-backup -g avku-backup -m 0700 "$backup_base/sftp/incoming"
install -d -o root -g root -m 0700 "$backup_base/.candidates"
# Owner can download an archive from their trusted workstation for recovery.
# The production account has neither this group nor access outside its chroot.
install -d -o root -g miha -m 0750 "$backup_base/slots"
install -d -o root -g root -m 0755 /usr/local/lib/avku-backup
if [ ! -d /etc/ssh/authorized_keys.d ]; then
    install -d -o root -g root -m 0755 /etc/ssh/authorized_keys.d
fi
test "$(stat -c '%U' /etc/ssh/authorized_keys.d)" = root
install -o root -g root -m 0644 /dev/null /etc/ssh/authorized_keys.d/avku-backup
{ printf 'restrict,from="192.168.0.151" '; cat -- "$1"; } > /etc/ssh/authorized_keys.d/avku-backup
install -o root -g root -m 0644 "$installer_dir/publisher.py" /usr/local/lib/avku-backup/publisher.py
install -o root -g root -m 0644 "$installer_dir/70-avku-backup.conf" /etc/ssh/sshd_config.d/70-avku-backup.conf
sshd -t
sshd -T -C user=avku-backup,addr=192.168.0.151,host=miha | awk '/^(chrootdirectory|forcecommand|authenticationmethods|passwordauthentication|permittty|disableforwarding|permituserrc|permittunnel) /'
install -o root -g root -m 0644 "$installer_dir/avku-backup-publish.service" "$installer_dir/avku-backup-publish.path" /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/avku-backup-publish.{path,service}
systemctl daemon-reload
systemctl reload ssh
systemctl enable --now avku-backup-publish.path
python3 -B /usr/local/lib/avku-backup/publisher.py
zfs get exec,setuid,devices,atime,compression,quota backup/avku-internal
echo 'Installed. No timer, cron, Sanoid policy or automatic backup was created.'
