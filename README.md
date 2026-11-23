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

## Add or update model pricing

Run the pricing command with the exact Codex model ID and its input, cached input, and output prices in USD per million tokens. Include `--cache-write` if the provider publishes a cache-write rate. For example:

```sh
npm run pricing -- example-model 2 0.10 10 --cache-write 2.50
```

The [Meter pricing skill](skills/meter-pricing/SKILL.md) gives Codex the same workflow. When installed, invoke `$meter-pricing` directly or let Codex pick it up during Meter work when it finds a model missing from the catalog.

The command updates `pricing.json`. A new entry starts with Standard pricing. For published speed tiers or long-context rates, edit the model's `tiers` and `long_*` fields in that same file. The bundled `gpt-6.2-sol` entry provides an example. The dashboard shows the catalog under **Privacy & pricing**.

The collector reloads the catalog on its next scan. When a new model is added, it revisits retained logs to price requests that were recorded as unknown and can be attributed to that model. It preserves existing estimates when you edit an already configured model's rates. Requests with missing logs, ambiguous token totals, or missing rates for their speed tier or cache writes can remain unpriced.

An installed Meter reads its own copy of the catalog. Update the installed copy with `--file /path/to/installed/pricing.json`, or update the checkout and deploy it. The provided host installer places the active copy at `/opt/codex-meter/current/pricing.json` and replaces it on each release. Keep any custom entries in the checkout you deploy from. For a custom installation, point the collector's `--pricing` and the web app's `pricingFile` at the same catalog, using the paths visible to each process.
