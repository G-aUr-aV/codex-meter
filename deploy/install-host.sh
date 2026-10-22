#!/usr/bin/env bash
set -euo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run with sudo after reviewing this script.' >&2; exit 1; fi
repo=/home/ubuntu/workspace/repos/codex-meter
node=/home/ubuntu/.local/opt/node-v24.22.0-linux-x64/bin/node
test -x /usr/bin/bwrap
test -x "$node"
test -f "$repo/collector.py"
install -d -m 0755 /opt/codex-meter /opt/codex-meter/runtime /opt/codex-meter/releases
release=$(mktemp -d /opt/codex-meter/releases/release-XXXXXXXX)
cp -a "$repo/collector.py" "$repo/server.mjs" "$repo/pricing.json" "$repo/public" "$repo/scripts" "$release/"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0644 {} +
chown -R root:root "$release"
install -m 0755 "$node" /opt/codex-meter/runtime/node
if [[ -e /opt/codex-meter/current && ! -L /opt/codex-meter/current ]]; then echo 'Unexpected runtime path; refusing to replace it' >&2; exit 1; fi
ln -s "$release" /opt/codex-meter/current.next
mv -Tf /opt/codex-meter/current.next /opt/codex-meter/current
if ! id meter-web >/dev/null 2>&1; then useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin meter-web; fi
install -d -m 0755 /var/lib/codex-meter /etc/codex-meter
install -d -o ubuntu -g ubuntu -m 0700 /var/lib/codex-meter/collector
install -d -o ubuntu -g meter-web -m 2750 /var/lib/codex-meter/published
install -d -o meter-web -g meter-web -m 0700 /var/lib/codex-meter/web
install -d -o ubuntu -g ubuntu -m 0700 /home/ubuntu/.local/state/codex-meter
if [[ ! -f /etc/codex-meter/app.json ]]; then
  "$node" -e 'require("fs").writeFileSync("/etc/codex-meter/app.json",JSON.stringify({port:4318,origins:["http://127.0.0.1:4318"],insecureLocal:true,stateDir:"/state",reportFile:"/published/report.json",publicRoot:"/app/public"}),{mode:0o644})'
fi
"$node" "$repo/scripts/bootstrap.mjs" /var/lib/codex-meter/web /home/ubuntu/.local/state/codex-meter/initial-login.txt
chown meter-web:meter-web /var/lib/codex-meter/web/auth.json
if [[ -f /home/ubuntu/.local/state/codex-meter/initial-login.txt ]]; then chown ubuntu:ubuntu /home/ubuntu/.local/state/codex-meter/initial-login.txt; fi
install -d -o ubuntu -g ubuntu -m 0755 /home/ubuntu/workspace/ops/apps/codex-meter
for name in collector web; do
  install -o ubuntu -g ubuntu -m 0644 "$repo/deploy/codex-meter-$name.service" "/home/ubuntu/workspace/ops/apps/codex-meter/codex-meter-$name.service"
  install -m 0644 "$repo/deploy/codex-meter-$name.service" "/etc/systemd/system/codex-meter-$name.service"
done
systemctl daemon-reload
systemctl enable codex-meter-collector.service codex-meter-web.service
systemctl restart codex-meter-collector.service codex-meter-web.service
echo 'Meter services installed; authentication material remains in private local files.'
