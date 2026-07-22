// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// Render-side code-reference types for the ScriptyRenderer template.
//
// These describe where a generative work's files live onchain, so the template
// can assemble them into an HTML document at tokenURI time. They are a template
// concern, not core protocol surface: the Surface core does not reference
// them. The core stores only the renderer address that answers tokenURI (the
// renderer slot) and whether that pointer is locked (lockRenderer).
// ─────────────────────────────────────────────────────────────────────────────

/// @notice How a stored file must be emitted into the assembled HTML.
///         Script = plain JS; ScriptGzip = gzipped JS (the renderer loads a
///         gunzip helper and emits it as a gzip data-URI script tag).
enum CodeKind {
    Script,
    ScriptGzip
}

/// @notice An onchain-addressable file: a named entry in a scripty v2 storage
///         contract or an EthFS FileStore.
struct CodeRef {
    address store; // the storage contract holding the file
    string name; // the file's name within that store
    CodeKind kind; // plain script or gzipped script
}
