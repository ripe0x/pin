// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {SovereignCollectionFactory} from "../src/collection/SovereignCollectionFactory.sol";
import {SovereignCollection} from "../src/collection/SovereignCollection.sol";
import {
    CodeKind,
    CodeRef,
    CollectionConfig,
    CollectionKind,
    IdMode,
    Liveness,
    WorkConfig
} from "../src/collection/CollectionTypes.sol";

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
    // network, noLoop — honest Liveness.Pure per the injection convention.
    string constant SKETCH = string(
        abi.encodePacked(
            "let R;function setup(){createCanvas(700,700);noLoop();",
            "let a=parseInt(tokenData.hash.slice(2,10),16),b=parseInt(tokenData.hash.slice(10,18),16),",
            "c=parseInt(tokenData.hash.slice(18,26),16),d=parseInt(tokenData.hash.slice(26,34),16);",
            "R=function(){a|=0;b|=0;c|=0;d|=0;let t=(a+b)|0;t=((t<<11)|(t>>>21))+c|0;",
            "let na=b^(b<<9),nb=(c+(c<<3))|0,nc=((d<<7)|(d>>>25))+a|0;a=na;b=nb;c=nc;d=t;",
            "return (t>>>0)/4294967296}}",
            "function draw(){const h=R()*360;colorMode(HSB,360,100,100,100);background(h,25,10);",
            "noFill();const n=14+Math.floor(R()*18);",
            "for(let i=0;i<n;i++){const r=40+i*(R()*20+8),w=1+R()*5,hh=(h+R()*130)%360,",
            "a0=R()*TWO_PI,a1=a0+PI*(0.3+R()*1.6);stroke(hh,55+R()*35,85,85);strokeWeight(w);",
            "arc(width/2,height/2,r*2,r*2,a0,a1)}",
            "noStroke();for(let i=0;i<44;i++){const a2=R()*TWO_PI,r2=60+R()*270;",
            "fill((h+R()*60)%360,40,95,90);circle(width/2+Math.cos(a2)*r2,height/2+Math.sin(a2)*r2,2+R()*6)}}"
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
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address artist = vm.addr(pk);
        // Anvil account 1: the unclaimed collaborator on the roster.
        address collab = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

        vm.startBroadcast(pk);

        // 1) Upload the sketch to the real ScriptyStorageV2 on the fork.
        IScriptyStorageWrite store = IScriptyStorageWrite(SCRIPTY_STORAGE_V2);
        store.createContent(SKETCH_NAME, "");
        store.addChunkToContent(SKETCH_NAME, bytes(SKETCH));

        // 2) "Orbit Studies": generative, collab roster, 3 mints.
        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: SCRIPTY_STORAGE_V2, name: SKETCH_NAME, kind: CodeKind.Script});
        CodeRef[] memory deps = new CodeRef[](1);
        deps[0] = CodeRef({store: ETHFS_V2_FILE_STORAGE, name: P5_GZ, kind: CodeKind.ScriptGzip});

        WorkConfig memory orbitWork = WorkConfig({
            code: code,
            deps: deps,
            codeURI: "",
            codeHash: keccak256(bytes(SKETCH)),
            liveness: Liveness.Pure,
            injectionVersion: 1,
            renderParams: "aspect=1:1"
        });

        CollectionConfig memory orbitCfg;
        orbitCfg.price = 0.005 ether;
        orbitCfg.supplyCap = 64;
        orbitCfg.kind = CollectionKind.Standalone;
        orbitCfg.renderer = generativeRenderer;
        orbitCfg.idMode = IdMode.Sequential;

        address[] memory noMinters = new address[](0);
        address[] memory roster = new address[](2);
        roster[0] = artist;
        roster[1] = collab;

        address orbits = SovereignCollectionFactory(factory).createCollection(
            "Orbit Studies", "ORBIT", artist, orbitCfg, orbitWork, noMinters, roster
        );
        SovereignCollection(orbits).mintWithRewards{value: 0.015 ether}(3, address(0), "");

        // The artist's half of the attribution handshake, in the real Catalog;
        // the collab (account 1) deliberately stays unclaimed so the roster UI
        // shows both states.
        ICatalogClaim(CATALOG).addContract(orbits);

        // 3) "Field Notes": edition preset, inline-SVG cover, 2 mints.
        WorkConfig memory emptyWork;
        CollectionConfig memory fieldCfg;
        fieldCfg.artworkURI = FIELD_COVER;
        fieldCfg.price = 0.002 ether;
        fieldCfg.supplyCap = 25;
        fieldCfg.kind = CollectionKind.Standalone;
        fieldCfg.idMode = IdMode.Sequential;

        address field = SovereignCollectionFactory(factory).createCollection(
            "Field Notes", "FIELD", artist, fieldCfg, emptyWork, noMinters, new address[](0)
        );
        SovereignCollection(field).mintWithRewards{value: 0.004 ether}(2, address(0), "");

        vm.stopBroadcast();

        console2.log("Seeded sample collections:");
        console2.log("  Orbit Studies (generative):", orbits);
        console2.log("  Field Notes (edition):     ", field);
    }
}
