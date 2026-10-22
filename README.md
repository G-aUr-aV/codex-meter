# Meter

A passive, local Codex usage dashboard. The collector incrementally parses selected local session logs and publishes sanitized numeric reports. The web process receives reports rather than raw prompts, responses or account credentials.

## Requirements and checks

Requires Node.js 24, Python 3 and, for the isolated Linux deployment, Bubblewrap and libseccomp. Pricing is an offline snapshot of API-equivalent estimates; it is not ChatGPT subscription billing.

```sh
npm test
npm run test:collector
```

Review `deploy/` and `scripts/sandbox.py` before deploying. Configure your own input directories, service identities and private state paths. The example Ubuntu account and paths must be adapted for other installations. The collector and web process use separate mounts and a syscall policy. Raw logs, generated reports, credentials and the initial-login handoff belong outside this repository.

The web app uses passphrase authentication and exact-host/origin validation. Keep it on loopback and configure the allowed HTTPS origin before forwarding it. The default port is 4318. Calendar and relative filters support inspecting recorded usage; uncertain model/pricing records remain unpriced. See the [API description](docs/API.md).
