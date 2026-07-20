// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {Surface} from "../../../src/surface/Surface.sol";
import {PooledSurface} from "../../../src/surface/PooledSurface.sol";
import {SurfaceFactory} from "../../../src/surface/SurfaceFactory.sol";
import {FixedPriceMinter} from "../../../src/surface/minters/FixedPriceMinter.sol";
import {SurfaceConfig, IdMode} from "../../../src/surface/SurfaceTypes.sol";
import {ExampleScriptyWork} from "../../../src/surface/templates/ExampleScriptyWork.sol";
import {CodeKind, CodeRef} from "../../../src/surface/templates/CodeTypes.sol";

/// @dev Minimal scripty-compatible storage: the builder fetches tag content
///      via getContent(name, data). Lets the fork test store the "artist
///      script" locally while deps resolve from the real onchain stores.
contract MockScriptStore {
    mapping(string => bytes) private _files;

    function put(string calldata name, bytes calldata content) external {
        _files[name] = content;
    }

    function getContent(string memory name, bytes memory) external view returns (bytes memory) {
        return _files[name];
    }
}

/// @title ScriptyRendererForkTest
/// @notice End-to-end proof that the bring-your-own generative renderer template
///         (ExampleScriptyWork over ScriptyRenderer) assembles a complete HTML
///         document from chain state alone, against the REAL mainnet scripty v2
///         builder and EthFS-backed gzipped p5. The work is fixed in the
///         renderer's constructor (immutable by construction, no setWork), and
///         the injected tokenData carries the token's actual seed. Also verifies
///         the worked seed-derived `Palette` trait.
///
///         Opt-in like the other fork suites:
///           MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com \
///           FORK_BLOCK=<pin for cache reuse; 0/unset = HEAD> \
///           forge test --match-contract ScriptyRendererFork -vv
contract ScriptyRendererForkTest is Test {
    using LibString for uint256;

    // Deterministic scripty v2 deployments (same address on every chain).
    address constant SCRIPTY_BUILDER_V2 = 0xD7587F110E08F4D120A231bA97d3B577A81Df022;
    address constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;

    string constant GUNZIP_FILE = "gunzipScripts-0.0.1.js";
    string constant P5_GZ_FILE = "p5-v1.5.0.min.js.gz";
    string constant ARTIST_FILE = "fork-sketch.js";
    string constant ARTIST_MARKER = "function setup(){/*byo-renderer-proof*/createCanvas(64,64)}";

    Surface collection;
    ExampleScriptyWork renderer;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            emit log("skipping scripty renderer fork test: set MAINNET_RPC_URL to run");
            return;
        }
        uint256 pin = vm.envOr("FORK_BLOCK", uint256(0));
        try vm.createSelectFork(rpc) {
            if (pin != 0) vm.rollFork(pin);
        } catch {
            emit log("skipping: could not create mainnet fork");
            return;
        }
        forked = true;

        MockScriptStore artistStore = new MockScriptStore();
        artistStore.put(ARTIST_FILE, bytes(ARTIST_MARKER));

        // The work is baked into the renderer at construction — no setWork,
        // no registry. This exact renderer answers tokenURI forever.
        CodeRef[] memory deps = new CodeRef[](1);
        deps[0] = CodeRef({store: ETHFS_V2_FILE_STORAGE, name: P5_GZ_FILE, kind: CodeKind.ScriptGzip});
        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: address(artistStore), name: ARTIST_FILE, kind: CodeKind.Script});
        renderer =
            new ExampleScriptyWork(SCRIPTY_BUILDER_V2, ETHFS_V2_FILE_STORAGE, GUNZIP_FILE, code, deps, 1, address(0));

        Surface impl = new Surface();
        // Factory wires the template as the default renderer, so a plain
        // create points the collection's slot straight at it.
        SurfaceFactory factory = new SurfaceFactory(
            address(impl), address(new PooledSurface()), address(new FixedPriceMinter()), address(renderer), address(0)
        );

        SurfaceConfig memory cfg;
        cfg.supplyCap = 10;

        collection = Surface(
            factory.createSurfaceCustom(
                "BYO Proof", "BYO", address(this), cfg, new address[](0), address(0), new address[](0)
            )
        );
        // The token has no built-in sale path: this test contract is the
        // collection's owner, so it grants itself as minter and mints directly.
        collection.setMinter(address(this), true);
        collection.mintTo(address(this), 1);
    }

    function test_fork_tokenURI_assemblesDocumentFromChainAlone() public {
        if (!forked) return;

        string memory uri = collection.tokenURI(1);
        assertTrue(LibString.startsWith(uri, "data:application/json;base64,"), "json data uri prefix");

        string memory json = string(Base64.decode(LibString.slice(uri, 29, bytes(uri).length)));
        assertTrue(LibString.contains(json, '"animation_url":"data:text/html;base64,'), "animation_url present");

        string memory html = _extractHtml(json);

        // The injected context carries the token's real seed per the injection
        // convention (docs/injection-convention.md).
        string memory expectedHash =
            string(abi.encodePacked('window.tokenData={"hash":"', uint256(collection.tokenSeed(1)).toHexString(32)));
        assertTrue(LibString.contains(html, expectedHash), "tokenData hash injected");
        assertTrue(LibString.contains(html, '"tokenId":"1"'), "tokenId injected");
        assertTrue(LibString.contains(html, '"chainId":1'), "chainId injected");
        assertTrue(LibString.contains(html, '"context":"token"'), "canonical render marked context:token");

        // The gzipped p5 dependency arrived as a gzip data-URI script tag.
        assertTrue(LibString.contains(html, "gzip"), "gzip dep tag present");

        // The artist's code made it into the document verbatim.
        assertTrue(LibString.contains(html, ARTIST_MARKER), "artist script present");

        // Sanity: heavyweight because p5 actually came along (~200KB+ base64).
        assertGt(bytes(html).length, 100_000, "document carries dependency payload");
    }

    function test_fork_attributes_carryDerivedAndSeedTraits() public {
        if (!forked) return;

        string memory json =
            string(Base64.decode(LibString.slice(collection.tokenURI(1), 29, bytes(collection.tokenURI(1)).length)));

        // Provenance + seed traits from the base.
        assertTrue(LibString.contains(json, '"trait_type":"Mint Order","value":1'), "mint order");
        assertTrue(LibString.contains(json, '"trait_type":"Seed"'), "seed trait");

        // The worked seed-derived onchain trait from the override.
        assertTrue(LibString.contains(json, '"trait_type":"Palette"'), "palette trait present");
        string[4] memory palettes = ["Ember", "Dusk", "Frost", "Verdant"];
        string memory expected = palettes[uint256(collection.tokenSeed(1)) % 4];
        assertTrue(
            LibString.contains(json, string(abi.encodePacked('"value":"', expected, '"'))), "palette matches seed"
        );
    }

    /// @dev The preview contract: previewURI with the token's REAL seed
    ///      assembles the exact same document as tokenURI, differing only in
    ///      the injected `context` word — previews are verifiably the live
    ///      render, not an approximation.
    function test_fork_previewURI_sameSeed_isTheTokenDocument() public {
        if (!forked) return;

        string memory tokenJson =
            string(Base64.decode(LibString.slice(collection.tokenURI(1), 29, bytes(collection.tokenURI(1)).length)));
        string memory tokenHtml = _extractHtml(tokenJson);

        string memory previewUri = renderer.previewURI(address(collection), 1, collection.tokenSeed(1));
        string memory previewJson = string(Base64.decode(LibString.slice(previewUri, 29, bytes(previewUri).length)));
        string memory previewHtml = _extractHtml(previewJson);

        assertTrue(LibString.contains(previewHtml, '"context":"preview"'), "preview marked context:preview");
        assertEq(
            LibString.replace(previewHtml, '"context":"preview"', '"context":"token"'),
            tokenHtml,
            "same seed, same document (modulo context)"
        );

        // Preview metadata is deliberately not token-shaped provenance.
        assertTrue(LibString.contains(previewJson, "(preview)"), "name marked as preview");
        assertFalse(LibString.contains(previewJson, "Mint Order"), "no provenance attributes");
        assertFalse(LibString.contains(previewJson, '"image":'), "no static image on a preview");
    }

    /// @dev Previews need no token: a fresh collection with zero mints renders
    ///      a full document for any caller-supplied seed.
    function test_fork_previewURI_rendersWithoutAnyMint() public {
        if (!forked) return;

        Surface impl2 = new Surface();
        SurfaceFactory factory2 = new SurfaceFactory(
            address(impl2), address(new PooledSurface()), address(new FixedPriceMinter()), address(renderer), address(0)
        );
        SurfaceConfig memory cfg;
        cfg.supplyCap = 10;
        Surface unminted = Surface(
            factory2.createSurfaceCustom(
                "No Mints Yet", "NMY", address(this), cfg, new address[](0), address(0), new address[](0)
            )
        );

        bytes32 throwaway = keccak256("what-if");
        string memory uri = renderer.previewURI(address(unminted), 1, throwaway);
        string memory json = string(Base64.decode(LibString.slice(uri, 29, bytes(uri).length)));
        string memory html = _extractHtml(json);

        assertTrue(LibString.contains(html, '"context":"preview"'), "context injected");
        assertTrue(
            LibString.contains(html, string(abi.encodePacked('"hash":"', uint256(throwaway).toHexString(32)))),
            "caller seed injected"
        );
        assertTrue(LibString.contains(html, ARTIST_MARKER), "artist script present");
        assertGt(bytes(html).length, 100_000, "full document with dependency payload");
    }

    function _extractHtml(string memory json) private pure returns (string memory) {
        string memory marker = '"animation_url":"data:text/html;base64,';
        uint256 start = LibString.indexOf(json, marker) + bytes(marker).length;
        uint256 end = LibString.indexOf(json, '"', start);
        return string(Base64.decode(LibString.slice(json, start, end)));
    }
}
