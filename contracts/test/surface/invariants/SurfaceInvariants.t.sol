// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SurfaceBase} from "../SurfaceBase.sol";
import {MockMinter} from "../mocks/SurfaceMocks.sol";
import {SurfaceHandler} from "./SurfaceHandler.sol";

import {Surface} from "../../../src/surface/Surface.sol";
import {PooledSurface} from "../../../src/surface/PooledSurface.sol";
import {SurfaceCore} from "../../../src/surface/SurfaceCore.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";

/// @title SurfaceInvariants
/// @notice Bounded random-walk invariant suite over ONE Sequential-mode and
///         ONE Pooled-mode Surface, driven by SurfaceHandler.
///         See SurfaceHandler.sol for the action set and ghost-state
///         design. Run recipe for a deep pass (no fork involved):
///
///           FOUNDRY_PROFILE=invariant forge test --match-path "test/surface/invariants/*"
///
///         Default profile keeps runs/depth small so this suite stays part
///         of the fast day-to-day `forge test` loop; the invariant profile
///         (see foundry.toml) is for a deliberate deep pass.
contract SurfaceInvariants is StdInvariant, SurfaceBase {
    SurfaceHandler internal handler;

    Surface internal seq;
    PooledSurface internal pooled;
    MockMinter internal seqMinter;
    MockMinter internal pooledMinter;

    uint256 internal constant SEQ_PRICE = 0.01 ether;
    uint256 internal constant SEQ_CAP = 40;
    uint256 internal constant POOLED_CAP = 30; // < POOLED_ID_MAX+1 (51) so the cap actually binds

    function setUp() public override {
        super.setUp();

        // ── Sequential collection: fixed price, capped, one granted minter ──
        SurfaceConfig memory seqCfg = _pricedConfig(SEQ_PRICE);
        seqCfg.supplyCap = SEQ_CAP;
        seqMinter = new MockMinter();
        address[] memory seqMinters = new address[](1);
        seqMinters[0] = address(seqMinter);
        seq = _collectionWithMinters(seqCfg, seqMinters);

        // ── Pooled collection: no built-in paid path, one granted minter ───
        SurfaceConfig memory pooledCfg = _freeConfig();
        pooledCfg.supplyCap = POOLED_CAP;
        pooledMinter = new MockMinter();
        address[] memory pooledMinters = new address[](1);
        pooledMinters[0] = address(pooledMinter);
        pooled = _pooledWithMinters(pooledCfg, pooledMinters);

        handler = new SurfaceHandler(seq, pooled, seqMinter, pooledMinter, SEQ_PRICE, SEQ_CAP, POOLED_CAP);

        // Only fuzz calls into the handler; the collections themselves and
        // the minters are reached exclusively through it.
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = SurfaceHandler.mintSeqPaid.selector;
        selectors[1] = SurfaceHandler.mintSeqExtension.selector;
        selectors[2] = SurfaceHandler.mintPooledExtension.selector;
        selectors[3] = SurfaceHandler.burnSeq.selector;
        selectors[4] = SurfaceHandler.burnPooled.selector;
        selectors[5] = SurfaceHandler.withdrawSeq.selector;
        selectors[6] = SurfaceHandler.withdrawPooled.selector;
        selectors[7] = SurfaceHandler.probeUnauthorizedMintTo.selector;
        selectors[8] = SurfaceHandler.probeWrongModeMint.selector;
        selectors[9] = SurfaceHandler.probeWrongPayment.selector;
        selectors[10] = SurfaceHandler.probeHolderBurnPooled.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ════════════════════════════════════════════════════════════════════
    // FUNDS: pull accounting is exact. Handlers never force-feed ETH (no
    // vm.deal to a collection address, no selfdestruct), so collection
    // balance must equal the sum of every ghost payee's pending balance,
    // and paid-in must equal withdrawn + still-pending, on EACH collection
    // independently (they never share a balance).
    // ════════════════════════════════════════════════════════════════════

    function invariant_seqFundsMatchPendingSum() public view {
        uint256 sumPending = _sumGhostPendingOn(seq);
        assertEq(address(seq).balance, sumPending, "seq balance != sum(pendingWithdrawal)");
    }

    function invariant_pooledFundsMatchPendingSum() public view {
        uint256 sumPending = _sumGhostPendingOn(pooled);
        assertEq(address(pooled).balance, sumPending, "pooled balance != sum(pendingWithdrawal)");
    }

    /// @dev Pooled mode has no built-in paid path in this suite (mintToId is
    ///      always called with referrer but zero underlying value moved by the
    ///      core), so its ghostTotalPaidIn contribution is 0 — all paid-in
    ///      ETH in this suite flows through the sequential collection. The
    ///      invariant is still stated over the combined ghost totals so it
    ///      keeps holding if that ever changes.
    function invariant_totalPaidInEqualsWithdrawnPlusPending() public view {
        uint256 sumPendingBoth = _sumGhostPendingOn(seq) + _sumGhostPendingOn(pooled);
        assertEq(
            handler.ghostTotalPaidIn(), handler.ghostTotalWithdrawn() + sumPendingBoth, "paidIn != withdrawn + pending"
        );
    }

    function _sumGhostPendingOn(SurfaceCore c) internal view returns (uint256 sum) {
        uint256 n = handler.ghostPayeeCount();
        for (uint256 i = 0; i < n; i++) {
            address payee = handler.ghostPayeesEver(i);
            sum += c.pendingWithdrawal(payee);
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // SUPPLY: totalSupply() == mints-ever - burns, per collection.
    // ════════════════════════════════════════════════════════════════════

    function invariant_seqSupplyMatchesGhost() public view {
        assertEq(
            seq.totalSupply(), handler.ghostSeqMints() - handler.ghostSeqBurns(), "seq totalSupply != mints - burns"
        );
    }

    function invariant_pooledSupplyMatchesGhost() public view {
        assertEq(
            pooled.totalSupply(),
            handler.ghostPooledMints() - handler.ghostPooledBurns(),
            "pooled totalSupply != mints - burns"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // IDS: every ghost-live id has a real owner; the live set has no
    // duplicates (by construction, see SurfaceHandler's _liveAdd/_liveRemove,
    // reasserted here structurally); sequential ids are exactly 1..mintedEver
    // with burned ones absent and never re-minted.
    // ════════════════════════════════════════════════════════════════════

    function invariant_seqLiveIdsHaveOwners() public view {
        uint256 n = handler.seqLiveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.seqLiveIds(i);
            address owner = seq.ownerOf(id); // reverts (fails the invariant) if not owned
            assertTrue(owner != address(0), "seq live id has zero owner");
        }
    }

    function invariant_pooledLiveIdsHaveOwners() public view {
        uint256 n = handler.pooledLiveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.pooledLiveIds(i);
            address owner = pooled.ownerOf(id);
            assertTrue(owner != address(0), "pooled live id has zero owner");
        }
    }

    /// @dev No id appears twice in either live set. The handler's
    ///      _seqLiveAdd/_pooledLiveAdd already `require` against re-adding a
    ///      live id (which would itself fail the run), but re-derive the
    ///      no-duplicates property structurally here too: walk the array and
    ///      confirm every id is unique via a scratch "seen" pass.
    function invariant_seqLiveIdsAreUnique() public view {
        uint256 n = handler.seqLiveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 idI = handler.seqLiveIds(i);
            for (uint256 j = i + 1; j < n; j++) {
                assertTrue(idI != handler.seqLiveIds(j), "seq live id duplicated");
            }
        }
    }

    function invariant_pooledLiveIdsAreUnique() public view {
        uint256 n = handler.pooledLiveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 idI = handler.pooledLiveIds(i);
            for (uint256 j = i + 1; j < n; j++) {
                assertTrue(idI != handler.pooledLiveIds(j), "pooled live id duplicated");
            }
        }
    }

    /// @dev Sequential ids are exactly 1..mintedEver: every id in that range
    ///      is either live (owned) or burned (ownerOf reverts), and burned
    ///      ids can never come back to life (no re-mint path exists in
    ///      Sequential mode at all — enforced structurally by the ABI, and
    ///      reasserted here against the ghost's seenEverBurned bookkeeping).
    function invariant_seqIdsAreExactlyOneToMintedEver() public view {
        uint256 mintedEver = handler.ghostSeqMints();
        for (uint256 id = 1; id <= mintedEver; id++) {
            bool isLive = handler.seqIsLive(id);
            bool everBurned = handler.seqEverBurned(id);
            // Exactly one of {live, burned} holds for every id ever assigned.
            assertTrue(isLive != everBurned, "seq id must be exactly one of live/burned");
            if (everBurned) {
                assertFalse(isLive, "seq burned id must not be live");
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // ORDER: mint order strictly increases with every successful mint across
    // BOTH paths and never repeats. Order is no longer stored per token — the
    // Minted event stamps it, and in Sequential mode the token id IS the
    // order (id == index + 1, ids never recycle). The handler asserts the
    // contract's id assignment against the ghost counter at call time; here
    // we reassert end-to-end coherence: every live sequential id maps into
    // the ghost-tracked index space with no id above the counter, and both
    // contracts' mintedEver counters match the ghosts exactly.
    // ════════════════════════════════════════════════════════════════════

    function invariant_seqMintIndexOrderHolds() public view {
        uint256 mintedEver = handler.ghostSeqMints();
        (,, uint256 contractMinted) = seq.config();
        assertEq(contractMinted, mintedEver, "seq mintedEver diverged from ghost");
        uint256 n = handler.seqLiveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.seqLiveIds(i);
            // Sequential id IS the order: id - 1 is the mint index.
            assertTrue(id >= 1 && id <= mintedEver, "seq live id outside minted id space");
            assertTrue(handler.seqMintIndexSeen(id - 1), "seq live id's index not in seen set");
            assertTrue(seq.tokenSeed(id) != bytes32(0), "seq live id missing entropy");
        }
    }

    function invariant_pooledMintIndexOrderHolds() public view {
        uint256 mintedEver = handler.ghostPooledMints();
        (,, uint256 contractMinted) = pooled.config();
        assertEq(contractMinted, mintedEver, "pooled mintedEver diverged from ghost");
        // Pooled order is event-only (ids are reused); the handler's seen-map
        // bookkeeping at call time covers non-repetition. Here: every live id
        // carries entropy, the was-minted sentinel.
        uint256 n = handler.pooledLiveCount();
        for (uint256 i = 0; i < n; i++) {
            assertTrue(pooled.tokenSeed(handler.pooledLiveIds(i)) != bytes32(0), "pooled live id missing entropy");
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // CAPS: sequential ghostMints <= cap always; pooled totalSupply() <= cap
    // always (cap semantics differ deliberately by mode — see
    // Surface._checkCap).
    // ════════════════════════════════════════════════════════════════════

    function invariant_seqMintsNeverExceedCap() public view {
        assertTrue(handler.ghostSeqMints() <= SEQ_CAP, "seq mints exceeded cap");
        (,, uint256 minted) = seq.config();
        assertTrue(minted <= SEQ_CAP, "seq contract mintedEver exceeded cap");
    }

    function invariant_pooledSupplyNeverExceedsCap() public view {
        assertTrue(pooled.totalSupply() <= POOLED_CAP, "pooled live supply exceeded cap");
    }

    // ════════════════════════════════════════════════════════════════════
    // ROLES: the negative probes (unauthorized mintTo, wrong-mode mint,
    // wrong payment) must NEVER succeed.
    // ════════════════════════════════════════════════════════════════════

    function invariant_unauthorizedMintToNeverSucceeds() public view {
        assertFalse(handler.ghostUnauthorizedMintToSucceeded(), "unauthorized mintTo succeeded");
    }

    function invariant_wrongModeMintNeverSucceeds() public view {
        assertFalse(handler.ghostWrongModeMintSucceeded(), "wrong-mode mint succeeded");
    }

    function invariant_wrongPaymentMintNeverSucceeds() public view {
        assertFalse(handler.ghostWrongPaymentMintSucceeded(), "wrong-payment mint succeeded");
    }

    function invariant_holderBurnPooledNeverSucceeds() public view {
        assertFalse(handler.ghostHolderBurnPooledSucceeded(), "holder burned a pooled token out-of-band");
    }
}
