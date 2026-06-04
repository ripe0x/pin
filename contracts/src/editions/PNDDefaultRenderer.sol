// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "openzeppelin-contracts/contracts/utils/Base64.sol";
import {Strings} from "openzeppelin-contracts/contracts/utils/Strings.sol";

import {IPNDRenderer, IPNDEditionsView} from "./interfaces/IPNDRenderer.sol";
import {MintMark, EditionStatus} from "./PNDEditionsTypes.sol";

/// @title PNDDefaultRenderer
/// @notice The canonical built-in renderer. Wired into every project at deploy
///         and used unless the artist sets a custom renderer. It reads project
///         state back from the calling project (msg.sender) and returns a
///         base64 data URI: the artwork as `image`, plus the token's Mint Mark
///         as provenance attributes.
///
///         Shared by all projects — there is exactly one of these, immutable
///         and ownerless. A project that wants unique-per-token art, generative
///         art, or fully onchain media points at its own IPNDRenderer instead.
contract PNDDefaultRenderer is IPNDRenderer {
    using Strings for uint256;

    string private constant DESCRIPTION =
        "A PND Edition. This token's entry into the release is recorded onchain as a Mint Mark.";

    function tokenURI(uint256 tokenId) external view override returns (string memory) {
        IPNDEditionsView ed = IPNDEditionsView(msg.sender);
        MintMark memory m = ed.mintMarkOf(tokenId);

        string memory art = ed.tokenArtwork(tokenId);
        if (bytes(art).length == 0) art = ed.artwork();

        string memory json = string.concat(
            '{"name":"',
            _escape(ed.name()),
            " #",
            tokenId.toString(),
            '","description":"',
            DESCRIPTION,
            '","image":"',
            _escape(art),
            '","attributes":',
            _attributes(m),
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function contractURI() external view override returns (string memory) {
        IPNDEditionsView ed = IPNDEditionsView(msg.sender);
        string memory json = string.concat('{"name":"', _escape(ed.name()), '"}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ── attributes (provenance, not rarity) ───────────────────────────────────

    function _attributes(MintMark memory m) internal pure returns (string memory) {
        string memory a = string.concat(
            "[",
            _numAttr("Mint Order", uint256(m.indexInEdition) + 1),
            ",",
            _numAttr("Mint Block", uint256(m.mintBlock)),
            ",",
            _strAttr("Mint Surface", Strings.toHexString(uint256(uint160(m.surface)), 20)),
            ",",
            _strAttr("Status at Mint", _statusLabel(m.statusAtMint))
        );
        if (m.isFirst) {
            a = string.concat(a, ",", _strAttr("Provenance", "First mint of the release"));
        }
        if (m.isFinal) {
            a = string.concat(a, ",", _strAttr("Provenance", "Final mint of the release"));
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

    function _statusLabel(EditionStatus s) internal pure returns (string memory) {
        if (s == EditionStatus.Open) return "Open";
        if (s == EditionStatus.Closing) return "Closing";
        return "Closed";
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
