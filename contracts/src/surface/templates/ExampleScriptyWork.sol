// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ScriptyRenderer} from "./ScriptyRenderer.sol";
import {CodeRef} from "./CodeTypes.sol";
import {HTMLTag, HTMLTagType} from "./vendor/scripty/core/ScriptyStructs.sol";

/// @title ExampleScriptyWork
/// @notice A **worked example** of a bring-your-own generative renderer: it
///         subclasses the [ScriptyRenderer](./ScriptyRenderer.sol) template and
///         shows the two things a real work customizes: a seed-derived onchain
///         trait and a fixed-aspect `<head>`.
///
///         Fork this contract for a script-based work. You supply the same
///         constructor args as the base (the scripty builder, the gunzip
///         helper, and the onchain code/dependency refs for your sketch), and
///         you get an immutable renderer whose output any external checker can
///         attest. The only work-specific logic is `_workTraits`.
///
///         **The trait rule.** Onchain traits must be a *pure function of the
///         seed*, computed here the SAME way your sketch computes them, so the
///         published trait matches the render. Traits that require running the
///         algorithm (pixel counts, emergent structure) cannot be computed in a
///         view and belong offchain. The `Palette` trait below is illustrative:
///         a real work would derive it through the same PRNG draw its sketch
///         uses for the palette, not a raw seed modulo.
contract ExampleScriptyWork is ScriptyRenderer {
    string[4] private PALETTES = ["Ember", "Dusk", "Frost", "Verdant"];

    constructor(
        address scriptyBuilder_,
        address gunzipStore_,
        string memory gunzipFile_,
        CodeRef[] memory code_,
        CodeRef[] memory deps_,
        uint8 injectionVersion_,
        address renderAssets_
    )
        ScriptyRenderer(scriptyBuilder_, gunzipStore_, gunzipFile_, code_, deps_, injectionVersion_, renderAssets_)
    {}

    /// @dev A seed-derived trait: pick a named palette from the seed. Emitted
    ///      as a leading-comma JSON entry, appended after the base's provenance
    ///      + Seed traits.
    function _workTraits(bytes32 seed) internal view override returns (bytes memory) {
        string memory palette = PALETTES[uint256(seed) % 4];
        return abi.encodePacked(',{"trait_type":"Palette","value":"', palette, '"}');
    }

    /// @dev Constrain the canvas to a centered square, a common long-form
    ///      layout. Shows how to override the document head.
    function _headTags() internal view override returns (HTMLTag[] memory head) {
        head = new HTMLTag[](1);
        head[0].tagOpen = "<style>";
        head[0].tagContent = "html,body{margin:0;height:100%;background:#000;overflow:hidden}"
            "body{display:flex;align-items:center;justify-content:center}"
            "canvas{display:block;max-width:100vmin;max-height:100vmin}";
        head[0].tagClose = "</style>";
        head[0].tagType = HTMLTagType.useTagOpenAndClose;
    }
}
