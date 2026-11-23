---
name: meter-pricing
description: Add or update a Codex model's rates in the Meter usage dashboard. Use when asked to maintain Meter pricing or when Meter work reveals usage for a model missing from its pricing catalog.
---

# Meter pricing

Use the active `codex-meter` checkout or locate it at `~/codex-meter`. Read its README pricing section and the affected row in `pricing.json`. During related Meter work, add a missing model when its exact ID and rates can be established. Investigate other causes of unpriced usage when the model already has a catalog entry.

1. Match the exact model ID Meter receives from Codex to the provider's published model ID or a documented alias. Verify that model's current Standard text-token rates from the provider's official pricing or model documentation. Use explicit user-supplied rates for a custom entry. Leave the model unpriced if its identity or required input, cached input, or output rate is uncertain. A zero rate means the category is free.
2. From the checkout, run `npm run pricing -- MODEL INPUT CACHED OUTPUT` with rates in USD per million tokens. Append `--cache-write RATE` when the provider publishes the rate Meter can represent. For a provider-sourced entry, record the official URL in `pricing.json` under `sources` if absent. New entries start with Standard pricing. Add published speed-tier multipliers or long-context rates in the catalog when appropriate, using the bundled entries as examples.
3. Read back the affected row. Run `npm run test:collector` if you edited advanced fields. Report the model ID, rates, source, and which catalog you updated. Meter revisits retained logs for newly registered models and uses edited rates on newly recorded requests.

Use the checkout catalog by default. If the task calls for updating a running installation, identify its active pricing file and pass `--file /path/to/pricing.json`. Verify the new row in the next report when the installation is accessible.
