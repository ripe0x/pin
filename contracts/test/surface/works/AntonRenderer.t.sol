// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";

import {AntonRenderer} from "../../../src/surface/works/anton/AntonRenderer.sol";
import {CodeKind, CodeRef} from "../../../src/surface/templates/CodeTypes.sol";
import {HTMLRequest, HTMLTag} from "../../../src/surface/templates/vendor/scripty/core/ScriptyStructs.sol";
import {IdMode} from "../../../src/surface/SurfaceTypes.sol";

/// @dev Echoes the assembled body tag contents so the injected render context
///      is inspectable.
contract EchoBuilder {
    function getEncodedHTMLString(HTMLRequest memory req) external pure returns (string memory out) {
        for (uint256 i = 0; i < req.bodyTags.length; i++) {
            out = string(abi.encodePacked(out, string(req.bodyTags[i].tagContent)));
        }
    }
}

/// @dev ERC721 plus the ISurfaceView subset the renderer reads.
contract MockCollection is ERC721 {
    mapping(uint256 => bytes32) public seedOf;
    uint256 public minted;

    constructor() ERC721("Anton", "ANTON") {}

    function mint(address to, bytes32 seed) external returns (uint256 id) {
        id = ++minted;
        seedOf[id] = seed;
        _mint(to, id);
    }

    function tokenSeed(uint256 id) external view returns (bytes32) {
        return seedOf[id];
    }

    function idMode() external pure returns (IdMode) {
        return IdMode.Sequential;
    }

    function owner() external pure returns (address) {
        return address(0);
    }
}

contract AntonRendererTest is Test {
    AntonRenderer renderer;
    MockCollection col;
    address collector = makeAddr("collector");
    address next = makeAddr("next");

    function setUp() public {
        col = new MockCollection();
        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: address(this), name: "anton.js", kind: CodeKind.Script});
        renderer = new AntonRenderer(address(new EchoBuilder()), address(0), "", code, new CodeRef[](0), 1, address(0));
    }

    function _json(uint256 id) internal view returns (string memory) {
        string memory uri = renderer.tokenURI(address(col), id);
        return string(Base64.decode(LibString.slice(uri, bytes("data:application/json;base64,").length)));
    }

    function _has(string memory hay, string memory needle) internal pure returns (bool) {
        return LibString.indexOf(hay, needle) != LibString.NOT_FOUND;
    }

    function test_traits_derivedFromSeed() public {
        // seed 0x405 = 1029 -> palette 1029 % 10 = 9 (J); tone (1029>>8)%2 = 4%2 = 0 (sun)
        uint256 id = col.mint(collector, bytes32(uint256(0x405)));
        string memory json = _json(id);
        assertTrue(_has(json, '"trait_type":"Palette","value":"J"'), "palette");
        assertTrue(_has(json, '"trait_type":"Tone","value":"sun"'), "tone");
        assertTrue(_has(json, '"trait_type":"Mint Order","value":1'), "order");
        assertTrue(_has(json, '"trait_type":"Seed"'), "seed");
    }

    function test_context_carriesOwner_noParams() public {
        uint256 id = col.mint(collector, bytes32(uint256(1)));
        string memory json = _json(id);
        assertTrue(_has(json, string(abi.encodePacked('"owner":"', LibString.toHexString(collector), '"'))), "owner");
        assertFalse(_has(json, '"params"'), "no params object");
        assertTrue(_has(json, '"context":"token"'), "context");
    }

    function test_owner_followsTransfer() public {
        uint256 id = col.mint(collector, bytes32(uint256(2)));
        vm.prank(collector);
        col.transferFrom(collector, next, id);
        string memory json = _json(id);
        assertTrue(_has(json, string(abi.encodePacked('"owner":"', LibString.toHexString(next), '"'))), "new owner");
    }

    function test_preview_unmintedToken_doesNotRevert() public view {
        string memory uri = renderer.previewURI(address(col), 999, bytes32(uint256(7)));
        assertTrue(bytes(uri).length > 0);
    }
}
