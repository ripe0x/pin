// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {CollectionFactory} from "../src/collection/CollectionFactory.sol";
import {Collection} from "../src/collection/Collection.sol";
import {CollectionConfig, IdMode} from "../src/collection/CollectionTypes.sol";
import {CodeKind, CodeRef, WorkConfig} from "../src/collection/renderers/WorkTypes.sol";
import {GenerativeRenderer} from "../src/collection/renderers/GenerativeRenderer.sol";
import {RenderAssets} from "../src/collection/renderers/RenderAssets.sol";
import {SVGRenderer} from "../src/collection/renderers/SVGRenderer.sol";
import {LibString} from "solady/utils/LibString.sol";

interface IGateHook {
    function setRoot(address collection, bytes32 root) external;
    function setCap(address collection, uint256 cap) external;
}

/// @dev DEV-ONLY concrete SVGRenderer: seed-derived horizontal bands with
///      an accent column. Small on purpose; exists so the harness world has
///      a fully onchain Solidity-SVG collection (the launch-case renderer
///      type), exercising SVGRenderer.tokenURI AND previewURI end to end.
contract DevSVGRenderer is SVGRenderer {
    using LibString for uint256;

    function svg(address, uint256, bytes32 seed)
        internal
        view
        override
        returns (string memory)
    {
        uint256 s = uint256(seed);
        string memory bands = "";
        for (uint256 i = 0; i < 7; i++) {
            uint256 hue = (s >> (i * 9)) % 360;
            uint256 h = 60 + ((s >> (i * 5)) % 50);
            bands = string.concat(
                bands,
                '<rect x="0" y="',
                (i * 100).toString(),
                '" width="700" height="',
                h.toString(),
                '" fill="hsl(',
                hue.toString(),
                ',60%,',
                (30 + ((s >> (i * 3)) % 40)).toString(),
                '%)"/>'
            );
        }
        uint256 col = 40 + (s % 560);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 700">',
            '<rect width="700" height="700" fill="hsl(',
            ((s >> 200) % 360).toString(),
            ',25%,12%)"/>',
            bands,
            '<rect x="',
            col.toString(),
            '" y="0" width="24" height="700" fill="hsl(',
            ((s >> 120) % 360).toString(),
            ',80%,70%)"/></svg>'
        );
    }
}

interface IScriptyStorageWrite {
    function createContent(string calldata name, bytes calldata details) external;
    function addChunkToContent(string calldata name, bytes calldata chunk) external;
}

interface ICatalogClaim {
    function addContract(address contractAddress) external;
}

/// @notice DEV-ONLY fork seeding: populates a freshly harness-deployed
///         collection system with a browsable sample world, so the whole UI
///         (landing, collection pages, mint CTA, token pages, attribution
///         roster, studio) has real content on `pnpm dev:collections`.
///
///         Seeds, all owned by the broadcaster (anvil account 0):
///         1. "Orbit Studies" — generative (GenerativeRenderer over the real
///            forked EthFS p5 + a sketch this script uploads to the real
///            ScriptyStorageV2), collab roster [account0, account1], 3 mints,
///            account0's roster claim filed in the REAL Catalog.
///         2. "Field Notes" — edition preset (DefaultRenderer, inline-SVG
///            cover), 2 mints.
///
///         Run (the harness does this with SEED_SAMPLE=1):
///           FACTORY=0x… GENERATIVE_RENDERER=0x… PRIVATE_KEY=0x… \
///             forge script script/SeedDevCollections.s.sol \
///             --rpc-url http://127.0.0.1:8546 --broadcast
contract SeedDevCollections is Script {
    // Deterministic mainnet singletons, present on the fork.
    address constant SCRIPTY_STORAGE_V2 = 0xbD11994aABB55Da86DC246EBB17C1Be0af5b7699;
    address constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;
    // The deployed Catalog (packages/addresses ARTIST_RECORD_REGISTRY).
    address constant CATALOG = 0x467a9c39e03C595EC3075D856f19C7386b6b915d;

    string constant P5_GZ = "p5-v1.5.0.min.js.gz";
    string constant SKETCH_NAME = "pnd-dev-orbit-studies-v1";

    // Deterministic orbital sketch: hash-seeded xorshift PRNG, no time, no
    // network, noLoop, resolution-independent (canvas fits the viewport and
    // the composition scales) — pure per the injection convention.
    string constant SKETCH = string(
        abi.encodePacked(
            "let R;function setup(){const s=Math.min(windowWidth,windowHeight);createCanvas(s,s);noLoop();",
            "let a=parseInt(tokenData.hash.slice(2,10),16),b=parseInt(tokenData.hash.slice(10,18),16),",
            "c=parseInt(tokenData.hash.slice(18,26),16),d=parseInt(tokenData.hash.slice(26,34),16);",
            "R=function(){a|=0;b|=0;c|=0;d|=0;let t=(a+b)|0;t=((t<<11)|(t>>>21))+c|0;",
            "let na=b^(b<<9),nb=(c+(c<<3))|0,nc=((d<<7)|(d>>>25))+a|0;a=na;b=nb;c=nc;d=t;",
            "return (t>>>0)/4294967296}}",
            "function draw(){scale(width/700);const h=R()*360;colorMode(HSB,360,100,100,100);background(h,25,10);",
            "noFill();const n=14+Math.floor(R()*18);",
            "for(let i=0;i<n;i++){const r=40+i*(R()*20+8),w=1+R()*5,hh=(h+R()*130)%360,",
            "a0=R()*TWO_PI,a1=a0+PI*(0.3+R()*1.6);stroke(hh,55+R()*35,85,85);strokeWeight(w);",
            "arc(350,350,r*2,r*2,a0,a1)}",
            "noStroke();for(let i=0;i<44;i++){const a2=R()*TWO_PI,r2=60+R()*270;",
            "fill((h+R()*60)%360,40,95,90);circle(350+Math.cos(a2)*r2,350+Math.sin(a2)*r2,2+R()*6)}}"
        )
    );

    // Inline-SVG cover for the edition preset: renders with zero IPFS deps.
    string constant FIELD_COVER = string(
        abi.encodePacked(
            "data:image/svg+xml;utf8,",
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 700 700'>",
            "<rect width='700' height='700' fill='%23101014'/>",
            "<circle cx='350' cy='330' r='170' fill='none' stroke='%23e8e4d8' stroke-width='3'/>",
            "<line x1='120' y1='560' x2='580' y2='560' stroke='%23e8e4d8' stroke-width='2'/>",
            "<text x='350' y='620' text-anchor='middle' font-family='monospace' font-size='30' fill='%23e8e4d8'>field notes</text>",
            "</svg>"
        )
    );

    function run() external {
        address factory = vm.envAddress("FACTORY");
        address generativeRenderer = vm.envAddress("GENERATIVE_RENDERER");
        address renderAssets = vm.envAddress("RENDER_ASSETS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address artist = vm.addr(pk);

        vm.startBroadcast(pk);

        IScriptyStorageWrite store = IScriptyStorageWrite(SCRIPTY_STORAGE_V2);
        store.createContent(SKETCH_NAME, "");
        store.addChunkToContent(SKETCH_NAME, bytes(SKETCH));

        address orbits = _seedOrbits(factory, generativeRenderer, artist);
        address drift = _seedDrift(factory, generativeRenderer, artist);
        address field = _seedField(factory, renderAssets, artist);

        // Everything below deploys AFTER the original three so their
        // addresses stay stable across reseeds (nonce order preserved).
        // One example per collection type and lifecycle state, so the whole
        // UI matrix is reviewable on every fresh harness.
        console2.log("Seeded sample collections:");
        console2.log("  Orbit Studies (generative, gated, open):", orbits);
        console2.log("  Signal Drift (generative, gated-ineligible):", drift);
        console2.log("  Field Notes (edition):     ", field);
        DevSVGRenderer svgRenderer = new DevSVGRenderer();
        console2.log("  Woven Lattice (SVG onchain):", _seedLattice(factory, address(svgRenderer), artist));
        console2.log("  Common Signal (open edition, gas only):", _seedOpenEdition(factory, generativeRenderer, artist));
        console2.log("  Night Orbit (scheduled):   ", _seedScheduled(factory, generativeRenderer, artist));
        console2.log("  First Light (sold out):    ", _seedSoldOut(factory, generativeRenderer, artist));
        console2.log("  Brief Window (closes ~90s after seed):", _seedClosingWindow(factory, generativeRenderer, artist));
        _stageGates(orbits, drift);

        vm.stopBroadcast();
    }

    /// @dev Fully onchain Solidity-SVG work: seed-derived stacked bands.
    ///      Exercises the SVGRenderer base (and its previewURI) end to end —
    ///      the launch-case renderer type.
    function _seedLattice(address factory, address svgRenderer, address artist) private returns (address c) {
        CollectionConfig memory cfg;
        cfg.price = 0.001 ether;
        cfg.supplyCap = 40;
        cfg.renderer = svgRenderer;
        cfg.idMode = IdMode.Sequential;
        c = CollectionFactory(factory).createCollection(
            "Woven Lattice", "WEAVE", artist, cfg, new address[](0), new address[](0)
        );
        Collection(c).mintWithReferral{value: 0.004 ether}(4, address(0), "");
    }

    /// @dev Open edition (supplyCap 0) at price 0: the "N minted · open
    ///      edition" + "Gas only" presentation.
    function _seedOpenEdition(address factory, address generativeRenderer, address artist)
        private
        returns (address c)
    {
        CollectionConfig memory cfg;
        cfg.price = 0;
        cfg.supplyCap = 0;
        cfg.renderer = generativeRenderer;
        cfg.idMode = IdMode.Sequential;
        c = CollectionFactory(factory).createCollection(
            "Common Signal", "COMMON", artist, cfg, new address[](0), new address[](0)
        );
        GenerativeRenderer(generativeRenderer).setWork(c, _orbitWork());
        Collection(c).mintWithReferral(3, address(0), "");
    }

    /// @dev Scheduled: opens in a day, closes in three — the countdown state
    ///      survives reseeds and any short anvil time warps.
    function _seedScheduled(address factory, address generativeRenderer, address artist)
        private
        returns (address c)
    {
        CollectionConfig memory cfg;
        cfg.price = 0.002 ether;
        cfg.supplyCap = 48;
        cfg.mintStart = uint64(block.timestamp + 1 days);
        cfg.mintEnd = uint64(block.timestamp + 3 days);
        cfg.renderer = generativeRenderer;
        cfg.idMode = IdMode.Sequential;
        c = CollectionFactory(factory).createCollection(
            "Night Orbit", "NIGHT", artist, cfg, new address[](0), new address[](0)
        );
        GenerativeRenderer(generativeRenderer).setWork(c, _orbitWork());
    }

    /// @dev Sold out: cap 3, all three minted — the celebratory terminal
    ///      state and the supply-locked scarcity story.
    function _seedSoldOut(address factory, address generativeRenderer, address artist)
        private
        returns (address c)
    {
        CollectionConfig memory cfg;
        cfg.price = 0.001 ether;
        cfg.supplyCap = 3;
        cfg.renderer = generativeRenderer;
        cfg.idMode = IdMode.Sequential;
        c = CollectionFactory(factory).createCollection(
            "First Light", "FIRST", artist, cfg, new address[](0), new address[](0)
        );
        GenerativeRenderer(generativeRenderer).setWork(c, _orbitWork());
        Collection(c).mintWithReferral{value: 0.003 ether}(3, address(0), "");
        Collection(c).lockSupply();
    }

    /// @dev Window-closed: mints twice, then the window ends ~90 seconds
    ///      after seeding — by the time anyone reviews it, it shows the
    ///      honest "window closed with 2 of 50 minted" state.
    function _seedClosingWindow(address factory, address generativeRenderer, address artist)
        private
        returns (address c)
    {
        CollectionConfig memory cfg;
        cfg.price = 0.001 ether;
        cfg.supplyCap = 50;
        cfg.renderer = generativeRenderer;
        cfg.idMode = IdMode.Sequential;
        c = CollectionFactory(factory).createCollection(
            "Brief Window", "BRIEF", artist, cfg, new address[](0), new address[](0)
        );
        GenerativeRenderer(generativeRenderer).setWork(c, _orbitWork());
        Collection(c).mintWithReferral{value: 0.002 ether}(2, address(0), "");
        Collection(c).setMintWindow(0, uint64(block.timestamp + 90));
    }

    /// @dev Re-stage the mint gates on every reseed so the eligibility UI is
    ///      always reviewable. The roots match the allowlists ALREADY
    ///      PUBLISHED through the web API (stored keyed by collection+root):
    ///      Orbit's list holds anvil accounts 0+1 (connected dev wallet is
    ///      ELIGIBLE, capped at 2); Drift's holds three dummy addresses (dev
    ///      wallet is NOT eligible). On a fresh database, re-publish through
    ///      the studio mint-gate tool and re-run setRoot with the new root.
    ///      Skipped when GATE_HOOK is unset.
    function _stageGates(address orbits, address drift) private {
        address gate = vm.envOr("GATE_HOOK", address(0));
        if (gate == address(0)) return;
        Collection(orbits).setMintHook(gate);
        IGateHook(gate).setRoot(
            orbits, 0xd1573e3d5650743475aa0addfeef7e36cbfc4e060939615f4c3651e4b529d61c
        );
        IGateHook(gate).setCap(orbits, 2);
        Collection(drift).setMintHook(gate);
        IGateHook(gate).setRoot(
            drift, 0xfb0c6774b3bfc168584d0d561ee6561b377d86cdf30b8906e2c14d88b64581d8
        );
        IGateHook(gate).setCap(drift, 2);
    }

    function _orbitWork() private pure returns (WorkConfig memory work) {
        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: SCRIPTY_STORAGE_V2, name: SKETCH_NAME, kind: CodeKind.Script});
        CodeRef[] memory deps = new CodeRef[](1);
        deps[0] = CodeRef({store: ETHFS_V2_FILE_STORAGE, name: P5_GZ, kind: CodeKind.ScriptGzip});
        work = WorkConfig({
            code: code,
            deps: deps,
            codeURI: "",
            codeHash: keccak256(bytes(SKETCH)),
            injectionVersion: 1,
            renderParams: "aspect=1:1"
        });
    }

    /// @dev Generative with a collab roster and 3 mints; the artist's half of
    ///      the attribution handshake is filed in the real Catalog, the
    ///      collab (anvil account 1) deliberately stays unclaimed.
    function _seedOrbits(address factory, address generativeRenderer, address artist)
        private
        returns (address orbits)
    {
        CollectionConfig memory cfg;
        cfg.price = 0.005 ether;
        cfg.supplyCap = 64;
        cfg.renderer = generativeRenderer;
        cfg.idMode = IdMode.Sequential;

        address[] memory roster = new address[](2);
        roster[0] = artist;
        roster[1] = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

        orbits = CollectionFactory(factory).createCollection(
            "Orbit Studies", "ORBIT", artist, cfg, new address[](0), roster
        );
        // Work config lives in renderer-land now: the collection's owner
        // writes it to the GenerativeRenderer's registry post-create.
        GenerativeRenderer(generativeRenderer).setWork(orbits, _orbitWork());
        Collection(orbits).mintWithReferral{value: 0.015 ether}(3, address(0), "");
        ICatalogClaim(CATALOG).addContract(orbits);
    }

    /// @dev Generative, ZERO mints: exercises the pre-mint collection page
    ///      (deterministic preview-seed hero, no grid).
    function _seedDrift(address factory, address generativeRenderer, address artist)
        private
        returns (address drift)
    {
        CollectionConfig memory cfg;
        cfg.price = 0.003 ether;
        cfg.supplyCap = 32;
        cfg.renderer = generativeRenderer;
        cfg.idMode = IdMode.Sequential;

        drift = CollectionFactory(factory).createCollection(
            "Signal Drift", "DRIFT", artist, cfg, new address[](0), new address[](0)
        );
        GenerativeRenderer(generativeRenderer).setWork(drift, _orbitWork());
    }

    /// @dev Edition preset with an inline-SVG cover (RenderAssets) and 2 mints.
    function _seedField(address factory, address renderAssets, address artist)
        private
        returns (address field)
    {
        CollectionConfig memory cfg;
        cfg.price = 0.002 ether;
        cfg.supplyCap = 25;
        cfg.idMode = IdMode.Sequential;

        field = CollectionFactory(factory).createCollection(
            "Field Notes", "FIELD", artist, cfg, new address[](0), new address[](0)
        );
        // Cover art lives in renderer-land (RenderAssets), not the core.
        RenderAssets(renderAssets).setCover(field, FIELD_COVER);
        Collection(field).mintWithReferral{value: 0.004 ether}(2, address(0), "");
    }
}
