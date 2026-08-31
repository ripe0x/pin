# Program schemas

> **Status: canonical machine-readable design artifacts**

- `release-manifest-v1.schema.json`: portable release identity,
  artist-authored context, presentation, capabilities, adapters, and optional
  EIP-712 authorship.
- `artist-site-declaration-v1.schema.json`: optional signed artist-provided
  destination declaration.

The normative behavior, truth classes, hashing rules, provider contracts, and
compatibility rules are in `docs/portable-release-boundary.md`.

These schemas describe the accepted W1.1 boundary. Runtime validators and
generated TypeScript types belong to `@pin/release-spec` in W1.2. Do not create
a second application-local interpretation.
