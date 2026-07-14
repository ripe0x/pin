// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {SurfaceFactory} from "../src/surface/SurfaceFactory.sol";
import {Surface} from "../src/surface/Surface.sol";
import {SurfaceConfig} from "../src/surface/SurfaceTypes.sol";
import {RenderAssets} from "../src/surface/renderers/RenderAssets.sol";

interface ICatalogClaim {
    function addContract(address contractAddress) external;
}

/// @notice DEV-ONLY fork seeding: populates a freshly harness-deployed
///         collection system with a browsable sample world, so the whole UI
///         (landing, collection pages, mint CTA, token pages, attribution
///         roster, studio) has real content on `pnpm dev:collections`.
///
///         Every seed renders through the DefaultRenderer with an inline-SVG
///         cover (RenderAssets) — no IPFS, no onchain HTML assembler.
///         Generative works now ship as bring-your-own renderers (a
///         work-specific IRenderer the artist deploys), so the dev world no
///         longer stands up a shared assembler; a generative seed would deploy
///         its own concrete renderer and point the collection's slot at it.
///
///         Seeds, all owned by the broadcaster (anvil account 0):
///         1. "Orbit Studies" — DefaultRenderer + inline-SVG cover, collab
///            roster [account0, account1], 3 mints, account0's roster claim
///            filed in the REAL Catalog.
///         2. "Signal Drift" — DefaultRenderer + inline-SVG cover, ZERO mints
///            (exercises the pre-mint collection page).
///         3. "Field Notes" — edition preset (DefaultRenderer, inline-SVG
///            cover), 2 mints.
///
///         Run (the harness does this with SEED_SAMPLE=1):
///           FACTORY=0x… RENDER_ASSETS=0x… PRIVATE_KEY=0x… \
///             forge script script/SeedDevSurfaces.s.sol \
///             --rpc-url http://127.0.0.1:8546 --broadcast
contract SeedDevSurfaces is Script {
    // The deployed Catalog (packages/addresses ARTIST_RECORD_REGISTRY).
    address constant CATALOG = 0x467a9c39e03C595EC3075D856f19C7386b6b915d;

    // anvil account 1 — the collab listed on Orbit's roster who deliberately
    // never files their Catalog claim (shows listed-but-unconfirmed).
    address constant ANVIL_ACCOUNT_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    // Inline-SVG covers: render with zero IPFS deps.
    string constant ORBIT_COVER = string(
        abi.encodePacked(
            "data:image/svg+xml;utf8,",
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 700 700'>",
            "<rect width='700' height='700' fill='%230a0a12'/>",
            "<circle cx='350' cy='350' r='120' fill='none' stroke='%23e8e4d8' stroke-width='2'/>",
            "<circle cx='350' cy='350' r='210' fill='none' stroke='%237a86c8' stroke-width='2'/>",
            "<circle cx='470' cy='350' r='9' fill='%23e8e4d8'/>",
            "<circle cx='140' cy='350' r='6' fill='%237a86c8'/>",
            "<text x='350' y='650' text-anchor='middle' font-family='monospace' font-size='28' fill='%23e8e4d8'>orbit studies</text>",
            "</svg>"
        )
    );

    string constant DRIFT_COVER = string(
        abi.encodePacked(
            "data:image/svg+xml;utf8,",
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 700 700'>",
            "<rect width='700' height='700' fill='%23121016'/>",
            "<path d='M60 420 Q 200 320 350 400 T 640 380' fill='none' stroke='%23c8a87a' stroke-width='3'/>",
            "<path d='M60 470 Q 200 380 350 450 T 640 440' fill='none' stroke='%23e8e4d8' stroke-width='2'/>",
            "<text x='350' y='650' text-anchor='middle' font-family='monospace' font-size='28' fill='%23e8e4d8'>signal drift</text>",
            "</svg>"
        )
    );

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
        address renderAssets = vm.envAddress("RENDER_ASSETS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address artist = vm.addr(pk);

        vm.startBroadcast(pk);

        address orbits = _seedOrbits(factory, renderAssets, artist);
        address drift = _seedDrift(factory, renderAssets, artist);
        address field = _seedField(factory, renderAssets, artist);

        vm.stopBroadcast();

        console2.log("Seeded sample collections:");
        console2.log("  Orbit Studies (roster+mints):", orbits);
        console2.log("  Signal Drift (unminted):     ", drift);
        console2.log("  Field Notes (edition):       ", field);
    }

    /// @dev Collab roster and 3 mints; the artist's half of the attribution
    ///      handshake is filed in the real Catalog, the collab (anvil account
    ///      1) deliberately stays unclaimed (listed-but-unconfirmed).
    function _seedOrbits(address factory, address renderAssets, address artist) private returns (address orbits) {
        SurfaceConfig memory cfg;
        cfg.price = 0.005 ether;
        cfg.supplyCap = 64;

        address[] memory roster = new address[](2);
        roster[0] = artist;
        roster[1] = ANVIL_ACCOUNT_1;

        orbits = SurfaceFactory(factory)
            .createSurface("Orbit Studies", "ORBIT", artist, cfg, new address[](0), roster);
        // Cover art lives in renderer-land (RenderAssets), not the core.
        RenderAssets(renderAssets).setCover(orbits, ORBIT_COVER);
        Surface(orbits).mintWithReferral{value: 0.015 ether}(3, address(0), "");
        ICatalogClaim(CATALOG).addContract(orbits);
    }

    /// @dev ZERO mints: exercises the pre-mint collection page (no grid).
    function _seedDrift(address factory, address renderAssets, address artist) private returns (address drift) {
        SurfaceConfig memory cfg;
        cfg.price = 0.003 ether;
        cfg.supplyCap = 32;

        drift = SurfaceFactory(factory)
            .createSurface("Signal Drift", "DRIFT", artist, cfg, new address[](0), new address[](0));
        RenderAssets(renderAssets).setCover(drift, DRIFT_COVER);
    }

    /// @dev Edition preset with an inline-SVG cover (RenderAssets) and 2 mints.
    function _seedField(address factory, address renderAssets, address artist) private returns (address field) {
        SurfaceConfig memory cfg;
        cfg.price = 0.002 ether;
        cfg.supplyCap = 25;

        field = SurfaceFactory(factory)
            .createSurface("Field Notes", "FIELD", artist, cfg, new address[](0), new address[](0));
        RenderAssets(renderAssets).setCover(field, FIELD_COVER);
        Surface(field).mintWithReferral{value: 0.004 ether}(2, address(0), "");
    }
}
