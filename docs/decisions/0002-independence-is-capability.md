# 0002: independence is a capability, not an observed status

> **Status: accepted**
> **Date: 2026-08-31**

## Context

PND can provide contracts, exportable release data, shared interface code,
deployment tooling, and optional artist-provided links. It cannot reliably
discover every independently deployed interface or continuously prove who
controls its domain and hosting.

## Decision

PND offers export and self-host capabilities without assigning an automatic
graduated or independent state.

An artist may voluntarily publish a signed destination. PND presents it as an
artist-provided site. Resolution and contract-reference checks are narrow
compatibility observations, not proof of continuing ownership or independence.

## Consequences

- Studio never marks self-hosting incomplete.
- Public profiles and release pages show external destinations only when the
  artist declares them.
- Metrics distinguish deployment flows initiated from destinations explicitly
  published by artists.
- PND's durable record remains useful whether an artist reports an external
  interface or not.

