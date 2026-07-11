// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {ICollectionView} from "../interfaces/IRenderer.sol";
import {CollectionStatus, IdMode} from "../CollectionTypes.sol";

/// @title MetadataJson
/// @notice The small shared toolbox every bundled renderer draws from: JSON
///         escaping, attribute entries, the base64 envelope, and the
///         provenance traits, derived one way so every renderer tells the
///         same story.
library MetadataJson {
    using LibString for uint256;

    /// @dev JSON string escaping per RFC 8259 (solady): backslash, quote, and
    ///      all control characters. An owner-set name cannot break the JSON.
    function escape(string memory s) internal pure returns (string memory) {
        return LibString.escapeJSON(s);
    }

    /// @dev Wrap a JSON document as a base64 data URI.
    function jsonDataURI(string memory json) internal pure returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function numAttr(string memory trait, uint256 value) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', trait, '","value":', value.toString(), "}");
    }

    function strAttr(string memory trait, string memory value) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', trait, '","value":"', value, '"}');
    }

    /// @notice Provenance traits, derived on the spot — nothing per-token is
    ///         stored beyond the seed. In Sequential mode the token id IS the
    ///         mint order: Mint Order = tokenId, First = id 1, Final = the
    ///         collection is Closed and this is the highest id it ever
    ///         assigned. Pooled ids carry no order, so pooled tokens get an
    ///         empty list; a pooled work wanting order records its own
    ///         mint-time data via a hook and reads it in a custom renderer.
    function provenanceAttributes(ICollectionView cv, uint256 tokenId) internal view returns (string memory) {
        if (cv.idMode() != IdMode.Sequential) return "[]";
        (, CollectionStatus status, uint256 minted) = cv.config();
        string memory a = string.concat("[", numAttr("Mint Order", tokenId));
        if (tokenId == 1) {
            a = string.concat(a, ",", strAttr("Provenance", "First mint of the collection"));
        }
        if (status == CollectionStatus.Closed && tokenId == minted) {
            a = string.concat(a, ",", strAttr("Provenance", "Final mint of the collection"));
        }
        return string.concat(a, "]");
    }
}
