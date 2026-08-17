// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";

import {AntonParams} from "../../../src/surface/works/anton/AntonParams.sol";
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
    mapping(address => bool) public isMinter;
    mapping(uint256 => bytes32) public seedOf;
    uint256 public minted;

    constructor() ERC721("Anton", "ANTON") {}

    function setMinter(address m, bool v) external {
        isMinter[m] = v;
    }

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
    AntonParams params;
    AntonRenderer renderer;
    MockCollection col;

    address collector = makeAddr("collector");
    address next = makeAddr("next");

    function setUp() public {
        params = new AntonParams(10, 2);
        col = new MockCollection();
        col.setMinter(address(this), true);

        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: address(this), name: "anton.js", kind: CodeKind.Script});
        renderer = new AntonRenderer(
            address(new EchoBuilder()), address(0), "", code, new CodeRef[](0), 1, address(0), address(params)
        );
    }

    function _json(address collection, uint256 id) internal view returns (string memory) {
        string memory uri = renderer.tokenURI(collection, id);
        string memory b64 = LibString.slice(uri, bytes("data:application/json;base64,").length);
        return string(Base64.decode(b64));
    }

    function _has(string memory hay, string memory needle) internal pure returns (bool) {
        return LibString.indexOf(hay, needle) != LibString.NOT_FOUND;
    }

    function test_context_carriesOwnerAndParams() public {
        uint256 id = col.mint(collector, bytes32(uint256(0xABCD)));
        params.initParams(address(col), id, 3, 1); // D, moon

        string memory json = _json(address(col), id);
        assertTrue(_has(json, string(abi.encodePacked('"owner":"', LibString.toHexString(collector), '"'))), "owner");
        assertTrue(_has(json, '"params":{"palette":"D","tone":"moon"}'), "params");
        assertTrue(_has(json, '"context":"token"'), "context token");
    }

    function test_attributes_areIdentityBased() public {
        uint256 id = col.mint(collector, bytes32(uint256(1)));
        params.initParams(address(col), id, 0, 0); // A, sun

        string memory json = _json(address(col), id);
        assertTrue(_has(json, '"trait_type":"Palette","value":"A"'), "palette trait");
        assertTrue(_has(json, '"trait_type":"Tone","value":"sun"'), "tone trait");
        assertTrue(_has(json, '"trait_type":"Mint Order","value":1'), "mint order");
    }

    function test_owner_followsTransfer() public {
        uint256 id = col.mint(collector, bytes32(uint256(2)));
        params.initParams(address(col), id, 1, 0);

        vm.prank(collector);
        col.transferFrom(collector, next, id);

        string memory json = _json(address(col), id);
        assertTrue(_has(json, string(abi.encodePacked('"owner":"', LibString.toHexString(next), '"'))), "new owner");
    }

    function test_preview_unmintedToken_doesNotRevert() public view {
        string memory uri = renderer.previewURI(address(col), 999, bytes32(uint256(7)));
        assertTrue(bytes(uri).length > 0);
    }
}
