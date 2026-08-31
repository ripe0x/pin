# 0003: independent core behavior cannot require PND runtime services

> **Status: accepted**
> **Date: 2026-08-31**

## Context

Feature parity is not meaningful if an artist template imports shared UI but
still depends on PND APIs, database reads, media proxies, or authentication for
core release behavior.

## Decision

Minting, current release state, transaction preparation, deterministic
rendering, and core error recovery must operate through replaceable providers
without mandatory PND endpoints.

PND services may add indexed history, identity, editorial context, and prepared
media. Those enhancements must fail into an explicit reduced experience.

## Consequences

- The shared kernel defines provider interfaces instead of importing PND data
  clients.
- CI includes a mode that blocks PND endpoints for the artist template.
- PND-specific enrichment remains in application assemblies.
- Direct live reads stay narrow and cacheable; storable history remains outside
  request-time RPC paths.

