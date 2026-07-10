// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "openzeppelin-contracts/contracts/utils/Base64.sol";
import {Strings} from "openzeppelin-contracts/contracts/utils/Strings.sol";

import {IRenderer, ICollectionView} from "../interfaces/IRenderer.sol";
import {CollectionConfig, CollectionStatus, IdMode} from "../CollectionTypes.sol";

/// @title DefaultRenderer
/// @notice The canonical built-in renderer for Collection. Wired
///         into every collection at deploy (`defaultRenderer` in InitParams)
///         and used unless the artist sets a custom renderer. It reads
///         collection state back through ICollectionView, given the
///         collection address explicitly (not msg.sender, per IRenderer), and
///         returns a base64 data URI: the artwork as `image`, plus the
///         token's Mint Mark as provenance attributes.
///
///         Shared by every collection that wants it — there is exactly one
///         of these, immutable and ownerless. A collection that wants
///         unique-per-token art, generative art, or fully onchain media
///         points at its own IRenderer instead (e.g. an SVGRenderer).
///
///         Builds the JSON envelope (name, description, image, attributes)
///         from the collection's own views and per-token Mint Mark, reading
///         them through the IRenderer/ICollectionView surface.
contract DefaultRenderer is IRenderer {
    using Strings for uint256;

    string private constant DESCRIPTION =
        "A Collection token. This token's entry into the collection is recorded onchain as a Mint Mark.";

    function tokenURI(address collection, uint256 tokenId)
        external
        view
        override
        returns (string memory)
    {
        ICollectionView cv = ICollectionView(collection);

        string memory art = cv.tokenArtwork(tokenId);
        if (bytes(art).length == 0) art = cv.artwork();

        string memory json = string.concat(
            '{"name":"',
            _escape(cv.name()),
            " #",
            tokenId.toString(),
            '","description":"',
            DESCRIPTION,
            '","image":"',
            _escape(art),
            '","attributes":',
            _attributes(cv, tokenId),
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function contractURI(address collection) external view override returns (string memory) {
        ICollectionView cv = ICollectionView(collection);
        string memory json = string.concat('{"name":"', _escape(cv.name()), '"}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ── attributes (provenance, not rarity) ───────────────────────────────────

    /// @dev Provenance traits, fully derived — nothing per-token is stored
    ///      beyond the seed. Sequential mode: the token id IS the mint order
    ///      (ids assigned 1,2,3..., never reused), so Mint Order = tokenId,
    ///      First = id 1, and Final = the collection is Closed and this is
    ///      the highest id ever assigned (minted == mints-ever == last id).
    ///      Pooled ids are not mint order, so pooled tokens get no order
    ///      traits here; a pooled work wanting them records its own mint-time
    ///      data via a hook/minter and reads it in a custom renderer.
    function _attributes(ICollectionView cv, uint256 tokenId)
        internal
        view
        returns (string memory)
    {
        if (cv.idMode() != IdMode.Sequential) return "[]";
        (, CollectionStatus status, uint256 minted) = cv.config();
        string memory a = string.concat("[", _numAttr("Mint Order", tokenId));
        if (tokenId == 1) {
            a = string.concat(a, ",", _strAttr("Provenance", "First mint of the collection"));
        }
        if (status == CollectionStatus.Closed && tokenId == minted) {
            a = string.concat(a, ",", _strAttr("Provenance", "Final mint of the collection"));
        }
        return string.concat(a, "]");
    }

    function _numAttr(string memory trait, uint256 value) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', trait, '","value":', value.toString(), "}");
    }

    function _strAttr(string memory trait, string memory value)
        internal
        pure
        returns (string memory)
    {
        return string.concat('{"trait_type":"', trait, '","value":"', value, '"}');
    }

    /// @dev JSON string escaping per RFC 8259: backslash, double-quote, and all
    ///      control characters U+0000-U+001F (named escapes for the common ones,
    ///      \u00XX for the rest). Owner-set names/URIs therefore cannot break the
    ///      JSON structure or emit output that strict parsers reject.
    function _escape(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 len = 0;
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (
                c == 0x22 || c == 0x5c || c == 0x08 || c == 0x09 || c == 0x0a || c == 0x0c
                    || c == 0x0d
            ) {
                len += 2; // \" \\ \b \t \n \f \r
            } else if (c < 0x20) {
                len += 6; // \u00XX
            } else {
                len += 1;
            }
        }
        if (len == b.length) return s; // nothing to escape
        bytes memory hexc = "0123456789abcdef";
        bytes memory out = new bytes(len);
        uint256 j = 0;
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c == 0x22) {
                out[j++] = "\\";
                out[j++] = '"';
            } else if (c == 0x5c) {
                out[j++] = "\\";
                out[j++] = "\\";
            } else if (c == 0x08) {
                out[j++] = "\\";
                out[j++] = "b";
            } else if (c == 0x09) {
                out[j++] = "\\";
                out[j++] = "t";
            } else if (c == 0x0a) {
                out[j++] = "\\";
                out[j++] = "n";
            } else if (c == 0x0c) {
                out[j++] = "\\";
                out[j++] = "f";
            } else if (c == 0x0d) {
                out[j++] = "\\";
                out[j++] = "r";
            } else if (c < 0x20) {
                out[j++] = "\\";
                out[j++] = "u";
                out[j++] = "0";
                out[j++] = "0";
                out[j++] = hexc[c >> 4];
                out[j++] = hexc[c & 0x0f];
            } else {
                out[j++] = b[i];
            }
        }
        return string(out);
    }
}
