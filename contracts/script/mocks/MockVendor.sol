// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IRenderer} from "../../src/surface/interfaces/IRenderer.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Base64} from "solady/utils/Base64.sol";

/// @notice Minimal IRenderer for Sepolia integration rehearsals. Returns a
///         valid data:application/json tokenURI whose animation_url is a small
///         self-contained HTML document: a solid-color stage plus a
///         gesture-started WebAudio beep. It exercises the frontend's
///         tokenURI decode, the animation_url iframe, and the click-to-play
///         audio path without the escape renderer's onchain file dependencies.
///         Not a production renderer.
contract MockVendor is IRenderer {
    string public label;
    string public color;

    constructor(string memory label_, string memory color_) {
        label = label_;
        color = color_;
    }

    function tokenURI(address, uint256 tokenId) external view override returns (string memory) {
        string memory id = LibString.toString(tokenId);
        string memory html = string.concat(
            "<!DOCTYPE html><html><head><meta charset='UTF-8'>",
            "<meta name='viewport' content='width=device-width,initial-scale=1'>",
            "<style>*{margin:0}body{overflow:hidden}#s{width:100vw;height:100vh;display:flex;",
            "align-items:center;justify-content:center;cursor:pointer;background:",
            color,
            ";font:600 28px system-ui;color:#fff}</style></head><body>",
            "<div id='s'>",
            label,
            " #",
            id,
            " (tap for sound)</div><script>",
            "document.getElementById('s').onclick=function(){",
            "var c=new (window.AudioContext||window.webkitAudioContext)();",
            "var o=c.createOscillator();o.frequency.value=330+",
            id,
            "*20;o.connect(c.destination);o.start();setTimeout(function(){o.stop()},400);",
            "document.getElementById('s').textContent='",
            label,
            " #",
            id,
            " playing';};</script></body></html>"
        );
        string memory anim = string.concat("data:text/html;base64,", Base64.encode(bytes(html)));
        string memory meta = string.concat(
            '{"name":"',
            label,
            " #",
            id,
            '","description":"Sepolia integration mock",',
            '"animation_url":"',
            anim,
            '","attributes":[{"trait_type":"Batch","value":"',
            label,
            '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(meta)));
    }

    function contractURI(address) external view override returns (string memory) {
        string memory meta =
            string.concat('{"name":"', label, ' (mock collection)","description":"Sepolia integration mock"}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(meta)));
    }
}
