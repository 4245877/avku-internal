# Isolated security test only; no host volumes and no production SSH daemon.
FROM avku-internal-backup-worker:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --user-group --no-create-home --shell /usr/sbin/nologin avku-backup \
    && passwd -l avku-backup \
    && mkdir -p /run/sshd /etc/ssh/authorized_keys.d /srv/backup/avku-internal/sftp/incoming /srv/backup/avku-internal/sftp/status /srv/backup/avku-internal/slots \
    && chown avku-backup:avku-backup /srv/backup/avku-internal/sftp/incoming \
    && chmod 700 /srv/backup/avku-internal/sftp/incoming /srv/backup/avku-internal/slots \
    && chown root:avku-backup /srv/backup/avku-internal/sftp/status \
    && chmod 750 /srv/backup/avku-internal/sftp/status \
    && printf 'immutable-test-slot' > /srv/backup/avku-internal/slots/slot-1
COPY infra/certificate-backup/server/70-avku-backup.conf /etc/ssh/sshd_config.d/70-avku-backup.conf
ENTRYPOINT ["/usr/sbin/sshd", "-D", "-e", "-p", "18184", "-o", "PasswordAuthentication=no"]
