// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IRenderer, ICollectionView} from "../interfaces/IRenderer.sol";
import {MintMark, CollectionStatus} from "../CollectionTypes.sol";

/// @title SVGRenderer
/// @notice Abstract base for fully onchain Solidity-SVG works. Implements
///         IRenderer end to end (base64 JSON envelope: name, description,
///         image = data:image/svg+xml;base64,<svg>, provenance attributes),
///         leaving exactly one abstract function for the concrete art:
///         `svg(collection, tokenId)`. A concrete work inherits this,
///         implements `svg`, and optionally overrides the naming/description/
///         attributes hooks.
///
///         Reads collection state through ICollectionView, given the
///         collection address explicitly (per IRenderer — the collection is
///         a param, not msg.sender), so one renderer instance can serve many
///         collections that share the same generative algorithm.
abstract contract SVGRenderer is IRenderer {
    using LibString for uint256;
    using LibString for address;

    /// @notice The art itself. Must return a complete `<svg ...>...</svg>`
    ///         document (not base64-encoded, not data-URI-wrapped — this base
    ///         contract handles that envelope).
    function svg(address collection, uint256 tokenId) internal view virtual returns (string memory);

    /// @notice Token name hook. Default: "{collection name} #{tokenId}".
    function tokenName(address collection, uint256 tokenId)
        internal
        view
        virtual
        returns (string memory)
    {
        return string.concat(
            _escape(ICollectionView(collection).name()), " #", tokenId.toString()
        );
    }

    /// @notice Token description hook. Default: empty (field omitted).
    ///         Override to supply collection- or token-specific copy.
    function tokenDescription(address, /* collection */ uint256 /* tokenId */ )
        internal
        view
        virtual
        returns (string memory)
    {
        return "";
    }

    /// @notice Attributes hook. Default: the token's Mint Mark, rendered the
    ///         same way DefaultRenderer does (provenance, not rarity).
    ///         Override/extend to add work-specific traits (e.g. seed-derived
    ///         params) alongside or instead of provenance.
    function attributes(address collection, uint256 tokenId)
        internal
        view
        virtual
        returns (string memory)
    {
        return _markAttributes(ICollectionView(collection).mintMarkOf(tokenId));
    }

    // ── IRenderer ──────────────────────────────────────────────────────────

    function tokenURI(address collection, uint256 tokenId)
        external
        view
        override
        returns (string memory)
    {
        string memory image = string.concat(
            "data:image/svg+xml;base64,", Base64.encode(bytes(svg(collection, tokenId)))
        );

        string memory desc = tokenDescription(collection, tokenId);
        string memory json = string.concat(
            '{"name":"',
            tokenName(collection, tokenId),
            '"',
            bytes(desc).length > 0 ? string.concat(',"description":"', _escape(desc), '"') : "",
            ',"image":"',
            image,
            '","attributes":',
            attributes(collection, tokenId),
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function contractURI(address collection) external view override returns (string memory) {
        string memory json =
            string.concat('{"name":"', _escape(ICollectionView(collection).name()), '"}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ── shared attribute/escaping helpers (available to overriding works) ──

    function _markAttributes(MintMark memory m) internal pure returns (string memory) {
        string memory a = string.concat(
            "[",
            _numAttr("Mint Order", uint256(m.mintIndex) + 1),
            ",",
            _numAttr("Mint Block", uint256(m.mintBlock)),
            ",",
            _strAttr("Mint Surface", m.surface.toHexString()),
            ",",
            _strAttr("Status at Mint", _statusLabel(m.statusAtMint))
        );
        if (m.isFirst) {
            a = string.concat(a, ",", _strAttr("Provenance", "First mint of the collection"));
        }
        if (m.isFinal) {
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

    function _statusLabel(CollectionStatus s) internal pure returns (string memory) {
        if (s == CollectionStatus.Open) return "Open";
        if (s == CollectionStatus.Closing) return "Closing";
        return "Closed";
    }

    /// @dev JSON string escaping per RFC 8259, same rule as DefaultRenderer:
    ///      backslash, double-quote, and all control characters U+0000-U+001F.
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
