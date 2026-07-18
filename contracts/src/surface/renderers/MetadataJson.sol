// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {ISurfaceView} from "../interfaces/IRenderer.sol";
import {SurfaceStatus, IdMode} from "../SurfaceTypes.sol";

/// @title MetadataJson
/// @notice Shared helpers used by the bundled renderers: JSON escaping,
///         attribute entries, base64 data-URI wrapping, and provenance traits.
///         Provenance is derived here so every renderer produces identical
///         traits.
library MetadataJson {
    using LibString for uint256;

    /// @dev JSON string escaping per RFC 8259 (solady): backslash, quote, and
    ///      all control characters. Prevents an owner-set name from breaking
    ///      the JSON.
    function escape(string memory s) internal pure returns (string memory) {
        return LibString.escapeJSON(s);
    }

    /// @dev Wrap a JSON document as a base64 data URI.
    function jsonDataURI(string memory json) internal pure returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev Both `trait` and `value` are escaped so the attribute is JSON-safe.
    ///      Current callers pass literals (escaping is a no-op), but dynamic
    ///      text passed through here cannot inject into the metadata.
    function numAttr(string memory trait, uint256 value) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', escape(trait), '","value":', value.toString(), "}");
    }

    function strAttr(string memory trait, string memory value) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', escape(trait), '","value":"', escape(value), '"}');
    }

    /// @notice Provenance traits, derived at call time; no per-token data is
    ///         stored beyond the seed. In Sequential mode the token id equals
    ///         the mint order: Mint Order = tokenId, First = id 1, Final = the
    ///         collection is Closed and this is the highest id it assigned.
    ///         Pooled ids carry no order, so pooled tokens return an empty
    ///         list; to expose order for a pooled collection, record mint-time
    ///         data via a hook and read it in a custom renderer.
    function provenanceAttributes(ISurfaceView cv, uint256 tokenId) internal view returns (string memory) {
        if (cv.idMode() != IdMode.Sequential) return "[]";
        (, SurfaceStatus status, uint256 minted) = cv.config();
        string memory a = string.concat("[", numAttr("Mint Order", tokenId));
        if (tokenId == 1) {
            a = string.concat(a, ",", strAttr("Provenance", "First mint of the collection"));
        }
        if (status == SurfaceStatus.Closed && tokenId == minted) {
            a = string.concat(a, ",", strAttr("Provenance", "Final mint of the collection"));
        }
        return string.concat(a, "]");
    }
}
