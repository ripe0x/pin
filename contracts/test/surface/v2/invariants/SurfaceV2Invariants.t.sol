// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SurfaceV2Base} from "../SurfaceV2Base.sol";
import {MockMinterV2} from "../mocks/SurfaceV2Mocks.sol";
import {SurfaceV2Handler} from "./SurfaceV2Handler.sol";

import {SurfaceV2} from "../../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceConfig} from "../../../../src/surface/SurfaceTypes.sol";

/// @title SurfaceV2Invariants
/// @notice Bounded random-walk invariant suite over one SurfaceV2 instance,
///         driven by SurfaceV2Handler. See SurfaceV2Handler.sol for the
///         action set and ghost-state design. Ported from
///         test/surface/invariants/SurfaceInvariants.t.sol with the pooled
///         half dropped, and locks/seed-immutability probes added for the
///         behavior v2 introduces.
///
///         Deep-pass recipe (no fork involved):
///           FOUNDRY_PROFILE=invariant forge test --match-path "test/surface/v2/invariants/*"
///
///         Default profile keeps runs/depth small so this suite stays part
///         of the fast day-to-day `forge test` loop.
contract SurfaceV2Invariants is StdInvariant, SurfaceV2Base {
    SurfaceV2Handler internal handler;

    SurfaceV2 internal collection;
    MockMinterV2 internal minter;

    uint256 internal constant CAP = 40;

    function setUp() public override {
        super.setUp();

        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = CAP;
        minter = new MockMinterV2();
        address[] memory minters = new address[](1);
        minters[0] = address(minter);
        collection = _collectionWithMinters(cfg, minters);

        handler = new SurfaceV2Handler(collection, minter, CAP);

        // Only fuzz calls into the handler; the collection and the minter
        // are reached exclusively through it.
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = SurfaceV2Handler.mintExtension.selector;
        selectors[1] = SurfaceV2Handler.burn.selector;
        selectors[2] = SurfaceV2Handler.snapshotSeed.selector;
        selectors[3] = SurfaceV2Handler.lockRenderer.selector;
        selectors[4] = SurfaceV2Handler.lockSupply.selector;
        selectors[5] = SurfaceV2Handler.lockMinter.selector;
        selectors[6] = SurfaceV2Handler.lockRoyalty.selector;
        selectors[7] = SurfaceV2Handler.probeUnauthorizedMintTo.selector;
        selectors[8] = SurfaceV2Handler.probeUnauthorizedBurn.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ════════════════════════════════════════════════════════════════════
    // SUPPLY: totalSupply() == mints-ever - burns.
    // ════════════════════════════════════════════════════════════════════

    function invariant_supplyMatchesGhost() public view {
        assertEq(collection.totalSupply(), handler.ghostMints() - handler.ghostBurns(), "totalSupply != mints - burns");
    }

    // ════════════════════════════════════════════════════════════════════
    // IDS: every ghost-live id has a real owner; the live set has no
    // duplicates; ids are exactly 1..mintedEver with burned ones absent and
    // never re-minted (no id-choosing entrypoint exists in v2 at all).
    // ════════════════════════════════════════════════════════════════════

    function invariant_liveIdsHaveOwners() public view {
        uint256 n = handler.liveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.liveIds(i);
            address owner = collection.ownerOf(id); // reverts (fails the invariant) if not owned
            assertTrue(owner != address(0), "live id has zero owner");
        }
    }

    function invariant_liveIdsAreUnique() public view {
        uint256 n = handler.liveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 idI = handler.liveIds(i);
            for (uint256 j = i + 1; j < n; j++) {
                assertTrue(idI != handler.liveIds(j), "live id duplicated");
            }
        }
    }

    function invariant_idsAreExactlyOneToMintedEver() public view {
        uint256 mintedEver = handler.ghostMints();
        for (uint256 id = 1; id <= mintedEver; id++) {
            bool isLive = handler.isLive(id);
            bool everBurned = handler.everBurned(id);
            assertTrue(isLive != everBurned, "id must be exactly one of live/burned");
            if (everBurned) {
                assertFalse(isLive, "burned id must not be live");
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // ORDER: mint order strictly increases with every successful mint and
    // never repeats. Token id IS the order (id == index + 1, ids never
    // recycle); every live id carries nonzero entropy.
    // ════════════════════════════════════════════════════════════════════

    function invariant_mintIndexOrderHolds() public view {
        uint256 mintedEver = handler.ghostMints();
        (, uint256 contractMinted) = collection.config();
        assertEq(contractMinted, mintedEver, "mintedEver diverged from ghost");
        uint256 n = handler.liveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.liveIds(i);
            assertTrue(id >= 1 && id <= mintedEver, "live id outside minted id space");
            assertTrue(handler.mintIndexSeen(id - 1), "live id's index not in seen set");
            assertTrue(collection.tokenSeed(id) != bytes32(0), "live id missing entropy");
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // CAP: mints-ever never exceeds the cap, regardless of burns in between.
    // ════════════════════════════════════════════════════════════════════

    function invariant_mintsNeverExceedCap() public view {
        assertTrue(handler.ghostMints() <= CAP, "mints exceeded cap");
        (, uint256 minted) = collection.config();
        assertTrue(minted <= CAP, "contract mintedEver exceeded cap");
    }

    // ════════════════════════════════════════════════════════════════════
    // ROLES: the negative probes must never succeed.
    // ════════════════════════════════════════════════════════════════════

    function invariant_unauthorizedMintToNeverSucceeds() public view {
        assertFalse(handler.ghostUnauthorizedMintToSucceeded(), "unauthorized mintTo succeeded");
    }

    function invariant_unauthorizedBurnNeverSucceeds() public view {
        assertFalse(handler.ghostUnauthorizedBurnSucceeded(), "a non-owner, non-approved actor burned a token");
    }

    // ════════════════════════════════════════════════════════════════════
    // LOCKS: one-way. Once the handler recorded a successful lock call, the
    // contract's own view must report locked forever after (no setter can
    // ever flip it back; reasserted here on live contract state every run).
    // ════════════════════════════════════════════════════════════════════

    function invariant_locksAreOneWay() public view {
        if (handler.ghostRendererLockEngaged()) assertTrue(collection.isRendererLocked());
        if (handler.ghostSupplyLockEngaged()) assertTrue(collection.isSupplyLocked());
        if (handler.ghostMinterLockEngaged()) assertTrue(collection.isMinterLocked());
        if (handler.ghostRoyaltyLockEngaged()) assertTrue(collection.isRoyaltyLocked());
    }

    // ════════════════════════════════════════════════════════════════════
    // SEED: a stored seed never changes once set, across mints, burns, and
    // transfers in between (the handler's snapshotSeed action already
    // requires this inline; reasserted here structurally against every live
    // id's snapshot).
    // ════════════════════════════════════════════════════════════════════

    function invariant_seedNeverChangesOnceSet() public view {
        uint256 n = handler.liveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.liveIds(i);
            if (!handler.seedSnapshotTaken(id)) continue;
            assertEq(collection.tokenSeed(id), handler.seedSnapshot(id), "live id seed drifted from its mint snapshot");
        }
    }
}
