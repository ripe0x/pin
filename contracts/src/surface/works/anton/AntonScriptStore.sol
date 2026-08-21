// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SSTORE2} from "solady/utils/SSTORE2.sol";

/// @title AntonScriptStore
/// @notice Immutable onchain store for the anton work's script bytes, exposing
///         the scripty v2 `getContent(name, data)` read a ScriptyBuilder calls
///         when assembling a document. The bytes are written once to an SSTORE2
///         data contract in the constructor and never change. Holds the gzipped
///         script (referenced as a `ScriptGzip` CodeRef); the onchain gunzip
///         helper decompresses it at the document's parse time.
///
///         One file, so `name` is ignored: the store serves a single script.
contract AntonScriptStore {
    /// @notice The SSTORE2 data contract holding the bytes.
    address public immutable pointer;

    /// @notice Byte length of the stored content.
    uint256 public immutable length;

    constructor(bytes memory content) {
        pointer = SSTORE2.write(content);
        length = content.length;
    }

    /// @notice Scripty v2 read: returns the stored bytes regardless of `name`.
    function getContent(string memory, bytes memory) external view returns (bytes memory) {
        return SSTORE2.read(pointer);
    }
}
