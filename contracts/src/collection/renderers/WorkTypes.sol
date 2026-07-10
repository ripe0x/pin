// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// Render-side work types. These used to live in CollectionTypes.sol and be
// stored on the collection core; they moved here when all presentation data
// moved to renderer-land. The core knows nothing about presentation except
// which renderer to ask (the renderer slot) and whether that pointer is
// locked (lockRenderer).
// ─────────────────────────────────────────────────────────────────────────────

/// @notice How a stored file must be emitted into the assembled HTML.
///         Script = plain JS; ScriptGzip = gzipped JS (the renderer loads a
///         gunzip helper and emits it as a gzip data-URI script tag).
enum CodeKind {
    Script,
    ScriptGzip
}

/// @notice An onchain-addressable file: a named entry in a scripty v2
///         storage contract or an EthFS FileStore.
struct CodeRef {
    address store;
    string name;
    CodeKind kind;
}

/// @notice What the work is, executably. Stored per collection in the
///         renderer that runs it (GenerativeRenderer), settable and lockable
///         there by the collection's owner/admins. The struct states WHERE
///         the work's assets live (onchain code refs vs the offchain codeURI)
///         and pins their content (codeHash); how "onchain" a work is, is
///         derivable from those facts by any external checker and is not
///         self-declared.
struct WorkConfig {
    CodeRef[] code; // the algorithm, chunked/named in onchain storage
    CodeRef[] deps; // library files (gzipped p5/three/etc.)
    string codeURI; // offchain pointer for oversized code; hash-verified
    bytes32 codeHash; // integrity hash of the assembled script ("" refs ok)
    uint8 injectionVersion; // version of the render-context injection convention
    string renderParams; // renderer-interpreted settings (aspect, versions)
}
