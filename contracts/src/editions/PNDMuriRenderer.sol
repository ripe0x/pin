// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "openzeppelin-contracts/contracts/utils/Base64.sol";
import {Strings} from "openzeppelin-contracts/contracts/utils/Strings.sol";

import {IPNDRenderer, IPNDEditionsView} from "./interfaces/IPNDRenderer.sol";
import {IMURIProtocol} from "./interfaces/IMURIProtocol.sol";
import {MintMark, EditionStatus} from "./PNDEditionsTypes.sol";

/// @title PNDMuriRenderer
/// @notice Opt-in renderer that composes MURI under editions. The artwork is
///         sourced from MURI, the image as the resolved fallback URI and the
///         animation_url as MURI's resilient onchain HTML viewer (tries every
///         fallback URI, verifies the SHA-256 hash, shows the first surviving
///         copy), while the name, description, and LIVE per-token Mint Mark
///         attributes are built here from the calling edition. The edition
///         keeps its onchain identity; MURI provides the media permanence.
///
///         Reads MURI under the edition's canonical id (tokenId 0; see
///         PNDEditionsMuriOperator). If the edition has not been anchored in
///         MURI yet, it falls back to the edition's own artwork() so the token
///         always renders. Shared, immutable, ownerless, like the default
///         renderer; an edition opts in via setRenderer.
///
///         The Mint Mark attribute format intentionally mirrors
///         PNDDefaultRenderer so a token reads identically whichever renderer
///         the edition uses; only the artwork source differs.
contract PNDMuriRenderer is IPNDRenderer {
    using Strings for uint256;

    /// @dev Must match PNDEditionsMuriOperator.CANONICAL_TOKEN_ID.
    uint256 private constant CANONICAL_TOKEN_ID = 0;

    string private constant DESCRIPTION =
        "A PND Edition. This token's entry into the release is recorded onchain as a Mint Mark. Its artwork is preserved onchain via MURI.";

    /// @notice The MURI protocol singleton artwork is read from.
    IMURIProtocol public immutable muri;

    constructor(address muriProtocol) {
        muri = IMURIProtocol(muriProtocol);
    }

    function tokenURI(uint256 tokenId) external view override returns (string memory) {
        address edition = msg.sender;
        IPNDEditionsView ed = IPNDEditionsView(edition);
        MintMark memory m = ed.mintMarkOf(tokenId);

        (string memory image, string memory animationField) = _media(edition, ed);

        string memory json = string.concat(
            '{"name":"',
            _escape(ed.name()),
            " #",
            tokenId.toString(),
            '","description":"',
            DESCRIPTION,
            '","image":"',
            _escape(image),
            '"',
            animationField,
            ',"attributes":',
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

    // ── artwork source (MURI, with graceful fallback) ─────────────────────────

    /// @dev Returns (image, animationField). `image` is the MURI-resolved image
    ///      URI, or the edition's own artwork() if the edition has not been
    ///      anchored. `animationField` is the full `,"animation_url":"..."` JSON
    ///      fragment for MURI's onchain viewer, or "" when unavailable. The
    ///      try/catch means an un-anchored or reverting MURI read can never
    ///      brick a token's metadata.
    function _media(address edition, IPNDEditionsView ed)
        internal
        view
        returns (string memory image, string memory animationField)
    {
        try muri.renderImage(edition, CANONICAL_TOKEN_ID) returns (string memory img) {
            if (bytes(img).length > 0) {
                try muri.renderHTML(edition, CANONICAL_TOKEN_ID) returns (string memory html) {
                    if (bytes(html).length > 0) {
                        animationField = string.concat(',"animation_url":"', _escape(html), '"');
                    }
                } catch {}
                return (img, animationField);
            }
        } catch {}
        // Not anchored yet (or MURI read reverted): show the edition's own art.
        return (ed.artwork(), "");
    }

    // ── attributes (provenance, not rarity) — mirrors PNDDefaultRenderer ───────

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

    /// @dev Minimal JSON-string escaping: backslash and double-quote only.
    function _escape(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 extra = 0;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == '"' || b[i] == "\\") extra++;
        }
        if (extra == 0) return s;
        bytes memory out = new bytes(b.length + extra);
        uint256 j = 0;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == '"' || b[i] == "\\") {
                out[j++] = "\\";
            }
            out[j++] = b[i];
        }
        return string(out);
    }
}
