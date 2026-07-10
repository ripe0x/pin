// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {Collection} from "../../../src/collection/Collection.sol";
import {CollectionFactory} from "../../../src/collection/CollectionFactory.sol";
import {GenerativeRenderer} from "../../../src/collection/renderers/GenerativeRenderer.sol";
import {CollectionConfig, IdMode} from "../../../src/collection/CollectionTypes.sol";
import {CodeKind, CodeRef, WorkConfig} from "../../../src/collection/renderers/WorkTypes.sol";
import {RenderAssets} from "../../../src/collection/renderers/RenderAssets.sol";

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

/// @title GenerativeRendererForkTest
/// @notice End-to-end proof against the REAL mainnet scripty v2 builder and
///         EthFS-backed storage: a collection whose work config points at the
///         canonical gzipped p5 + gunzip helper assembles a complete HTML
///         document from chain state alone, with the injection convention's
///         tokenData carrying the token's actual seed.
///
///         Opt-in like the other fork suites:
///           MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com \
///           FORK_BLOCK=<pin for cache reuse; 0/unset = HEAD> \
///           forge test --match-contract GenerativeRendererFork -vv
contract GenerativeRendererForkTest is Test {
    using LibString for uint256;

    // Deterministic scripty v2 deployments (same address on every chain).
    address constant SCRIPTY_BUILDER_V2 = 0xD7587F110E08F4D120A231bA97d3B577A81Df022;
    address constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;

    string constant GUNZIP_FILE = "gunzipScripts-0.0.1.js";
    string constant P5_GZ_FILE = "p5-v1.5.0.min.js.gz";
    string constant ARTIST_FILE = "fork-sketch.js";
    string constant ARTIST_MARKER =
        "function setup(){/*sovereign-fork-proof*/createCanvas(64,64)}";

    Collection collection;
    GenerativeRenderer renderer;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            emit log("skipping generative fork test: set MAINNET_RPC_URL to run");
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

        RenderAssets assets = new RenderAssets();
        renderer = new GenerativeRenderer(
            SCRIPTY_BUILDER_V2, address(assets), ETHFS_V2_FILE_STORAGE, GUNZIP_FILE
        );
        MockScriptStore artistStore = new MockScriptStore();
        artistStore.put(ARTIST_FILE, bytes(ARTIST_MARKER));

        Collection impl = new Collection();
        CollectionFactory factory =
            new CollectionFactory(address(impl), address(renderer), address(0));

        CollectionConfig memory cfg;
        cfg.supplyCap = 10;
        cfg.idMode = IdMode.Sequential;

        WorkConfig memory work;
        work.deps = new CodeRef[](1);
        work.deps[0] = CodeRef({store: ETHFS_V2_FILE_STORAGE, name: P5_GZ_FILE, kind: CodeKind.ScriptGzip});
        work.code = new CodeRef[](1);
        work.code[0] = CodeRef({store: address(artistStore), name: ARTIST_FILE, kind: CodeKind.Script});
        work.injectionVersion = 1;

        collection = Collection(
            factory.createCollection(
                "Fork Proof", "FORK", address(this), cfg, new address[](0), new address[](0)
            )
        );
        // Work config lives in the renderer's registry, written by the
        // collection's owner (this test contract).
        renderer.setWork(address(collection), work);
        collection.mint(1);
    }

    function test_fork_tokenURI_assemblesDocumentFromChainAlone() public {
        if (!forked) return;

        string memory uri = collection.tokenURI(1);
        assertTrue(
            LibString.startsWith(uri, "data:application/json;base64,"), "json data uri prefix"
        );

        string memory json =
            string(Base64.decode(LibString.slice(uri, 29, bytes(uri).length)));
        assertTrue(
            LibString.contains(json, '"animation_url":"data:text/html;base64,'),
            "animation_url present"
        );

        string memory html = _extractHtml(json);

        // The injected context carries the token's real seed per the
        // injection convention (docs/injection-convention.md v1).
        string memory expectedHash =
            string(abi.encodePacked('window.tokenData={"hash":"', uint256(collection.tokenSeed(1)).toHexString(32)));
        assertTrue(LibString.contains(html, expectedHash), "tokenData hash injected");
        assertTrue(LibString.contains(html, '"tokenId":"1"'), "tokenId injected");
        assertTrue(LibString.contains(html, '"chainId":1'), "chainId injected");
        assertTrue(
            LibString.contains(html, '"context":"token"'),
            "canonical render must inject context:token"
        );

        // The gzipped p5 dependency arrived as a gzip data-URI script tag.
        assertTrue(LibString.contains(html, "gzip"), "gzip dep tag present");

        // The artist's code made it into the document verbatim.
        assertTrue(LibString.contains(html, ARTIST_MARKER), "artist script present");

        // Sanity: the document is heavyweight because p5 actually came along
        // (~200KB+ base64) rather than an empty shell that happens to match
        // substrings.
        assertGt(bytes(html).length, 100_000, "document carries dependency payload");
    }

    /// @dev The load-bearing preview property: a preview rendered with a
    ///      token's REAL seed assembles the exact same document as the
    ///      canonical tokenURI render, differing only in the injected
    ///      execution context. The preview IS the render.
    function test_fork_previewURI_sameSeed_isTheTokenDocument() public {
        if (!forked) return;

        string memory tokenHtml = _extractHtml(
            string(Base64.decode(LibString.slice(collection.tokenURI(1), 29, bytes(collection.tokenURI(1)).length)))
        );
        string memory previewUri =
            renderer.previewURI(address(collection), 1, collection.tokenSeed(1));
        string memory previewJson =
            string(Base64.decode(LibString.slice(previewUri, 29, bytes(previewUri).length)));
        assertTrue(
            LibString.contains(previewJson, "(preview)"), "preview name marked as preview"
        );
        string memory previewHtml = _extractHtml(previewJson);

        assertTrue(
            LibString.contains(previewHtml, '"context":"preview"'),
            "preview render must inject context:preview"
        );
        assertEq(
            LibString.replace(previewHtml, '"context":"preview"', '"context":"token"'),
            tokenHtml,
            "preview(realSeed) must be the token document modulo context"
        );
    }

    /// @dev Previews need no token: any (tokenId, seed) renders, including
    ///      ids that were never minted — this is the pre-mint explore state.
    function test_fork_previewURI_rendersWithoutAnyMint() public {
        if (!forked) return;

        bytes32 seed = keccak256("throwaway-preview-seed");
        string memory uri = renderer.previewURI(address(collection), 7, seed);
        string memory json = string(Base64.decode(LibString.slice(uri, 29, bytes(uri).length)));
        string memory html = _extractHtml(json);

        assertTrue(
            LibString.contains(
                html,
                string(
                    abi.encodePacked('window.tokenData={"hash":"', uint256(seed).toHexString(32))
                )
            ),
            "preview injects the caller's seed"
        );
        assertTrue(LibString.contains(html, '"tokenId":"7"'), "preview injects the asked-for id");
        assertTrue(LibString.contains(html, '"context":"preview"'), "context is preview");
        assertTrue(LibString.contains(html, ARTIST_MARKER), "artist script present");
    }

    function _extractHtml(string memory json) private pure returns (string memory) {
        string memory marker = '"animation_url":"data:text/html;base64,';
        uint256 start = LibString.indexOf(json, marker) + bytes(marker).length;
        uint256 end = LibString.indexOf(json, '"', start);
        return string(Base64.decode(LibString.slice(json, start, end)));
    }
}
