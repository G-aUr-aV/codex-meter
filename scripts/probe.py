"""Non-mutating negative tests for the actual runtime sandbox."""
import errno
import json
import os
from pathlib import Path
import socket
import sys

role = sys.argv[1]
checks = {}
for label, path in [('codex_auth_hidden', '/home/ubuntu/.codex/auth.json'),
                    ('vault_hidden', '/home/ubuntu/vaults'), ('host_home_hidden', '/home/ubuntu')]:
    checks[label] = not Path(path).exists()
try:
    s = socket.socket()
    s.connect(('1.1.1.1', 443))
    checks['outbound_connect_denied'] = False
except OSError as e:
    checks['outbound_connect_denied'] = e.errno == errno.EPERM
finally:
    s.close()
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(b'probe', ('127.0.0.1', 9))
    checks['outbound_datagram_denied'] = False
except OSError as e:
    checks['outbound_datagram_denied'] = e.errno == errno.EPERM
finally:
    s.close()
if role == 'collector':
    checks['source_visible'] = Path('/input/sessions').is_dir()
    # O_TMPFILE tests the read-only filesystem without creating a directory entry.
    try:
        fd = os.open('/input/sessions', os.O_TMPFILE | os.O_RDWR, 0o600)
        os.close(fd)
        checks['source_read_only'] = False
    except OSError as e:
        checks['source_read_only'] = e.errno == errno.EROFS
else:
    checks['raw_logs_hidden'] = not Path('/input').exists()
    checks['numeric_snapshot_visible'] = Path('/published/report.json').is_file()
    try:
        fd = os.open('/published', os.O_TMPFILE | os.O_RDWR, 0o600)
        os.close(fd)
        checks['snapshot_read_only'] = False
    except OSError as e:
        checks['snapshot_read_only'] = e.errno == errno.EROFS
print(json.dumps({'role': role, 'checks': checks, 'passed': all(checks.values())}))
raise SystemExit(0 if all(checks.values()) else 1)
