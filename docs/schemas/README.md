# Program schemas

> **Status: canonical machine-readable design artifacts**

- `release-manifest-v1.schema.json`: portable release identity,
  artist-authored context, presentation, capabilities, adapters, and optional
  EIP-712 authorship.
- `artist-site-declaration-v1.schema.json`: optional signed artist-provided
  destination declaration.
- `pnd-editorial-release-v1.schema.json`: PND-authored feature order, summary,
  and optional route slug. It contains no protocol or artist-authored facts.

The normative behavior, truth classes, hashing rules, provider contracts, and
compatibility rules are in `docs/portable-release-boundary.md`.

The release and site schemas describe the accepted W1.1 boundary. Runtime
validators and generated TypeScript types belong to `@pin/release-spec` in
W1.2. The editorial schema describes W2.1 and remains a PND assembly concern.
Do not create a second application-local interpretation of either boundary.
