// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {Surface} from "../../../src/surface/Surface.sol";
import {PooledSurface} from "../../../src/surface/PooledSurface.sol";
import {ISurface} from "../../../src/surface/interfaces/ISurface.sol";
import {ISurfaceCore} from "../../../src/surface/interfaces/ISurfaceCore.sol";
import {IPooledSurface} from "../../../src/surface/interfaces/IPooledSurface.sol";
import {MockMinter} from "../mocks/SurfaceMocks.sol";

/// @title SurfaceHandler
/// @notice Bounded random-walk handler driving two Surface
///         instances (one Sequential, one Pooled) through every public mint /
///         burn entrypoint, while maintaining ghost-truth state the invariant
///         test asserts against.
///
/// @dev    Design notes:
///         - The token holds no value and runs no sale logic (thin-token
///           rearchitecture): every mint goes through a granted MockMinter,
///           standing in for a real minter module. Value-conservation
///           coverage lives with the Phase 2 minter, not here.
///         - Sequential collection: supply-capped, sells exclusively through a
///           granted MockMinter calling batch-native mintTo (quantity varies
///           per call, exercising both single and batch mints).
///         - Pooled collection: sells exclusively through a granted MockMinter
///           calling mintToId with ids bounded to [0, POOLED_ID_MAX], so burn
///           -> re-mint of the same id is exercised constantly. Also
///           supply-capped, bounding LIVE totalSupply per pooled cap
///           semantics.
///         - Every actor address is drawn from a small bounded actor set so
///           collisions (same collector minting/burning/approving repeatedly)
///           happen often, which is where id-set bugs tend to hide.
///         - Negative probes (unauthorized mintTo, wrong-mode mint) are
///           wrapped in try/catch: a probe that does NOT revert trips a ghost
///           flag the invariant test asserts false, rather than reverting the
///           whole run (which would silently drop coverage).
contract SurfaceHandler is StdInvariant, Test {
    // ─────────────────────────────────────────────────────────────────────
    // Fixed setup
    // ─────────────────────────────────────────────────────────────────────

    Surface public immutable seq; // sequential form
    PooledSurface public immutable pooled; // pooled form
    MockMinter public immutable seqMinter; // granted on seq (mintTo)
    MockMinter public immutable pooledMinter; // granted on pooled (mintToId)

    uint256 public immutable seqCap;
    uint256 public immutable pooledCap;

    uint256 public constant POOLED_ID_MAX = 50; // bounded id space [0, 50]
    uint256 public constant NUM_ACTORS = 6;

    // ─────────────────────────────────────────────────────────────────────
    // Ghost state (the handler's own truth, checked against the contracts)
    // ─────────────────────────────────────────────────────────────────────

    // Mint / burn counters, per collection
    uint256 public ghostSeqMints;
    uint256 public ghostSeqBurns;
    uint256 public ghostPooledMints;
    uint256 public ghostPooledBurns;

    // Live id sets, per collection. Solidity has no native set type, so this
    // is an array (enumeration) + membership + index mapping, kept coherent
    // by _liveAdd / _liveRemove so no id can appear twice and removal is O(1).
    uint256[] public seqLiveIds;
    mapping(uint256 => bool) public seqIsLive;
    mapping(uint256 => uint256) private _seqLiveIndex; // id -> index in seqLiveIds (only valid if seqIsLive[id])

    uint256[] public pooledLiveIds;
    mapping(uint256 => bool) public pooledIsLive;
    mapping(uint256 => uint256) private _pooledLiveIndex;

    // Sequential ids are 1..mintedEver; once burned they must NEVER be
    // re-minted (no id-choosing entrypoint exists for Sequential at all, but
    // we track it explicitly as a ghost invariant anyway).
    mapping(uint256 => bool) public seqEverBurned;

    // mintIndex bookkeeping (order invariant): mintIndex must strictly
    // increase across every mint, on a single shared counter, and never
    // repeat. Mint order is 0-based and global per collection, stamped in
    // the Minted event (sequential id == index + 1); ghosts derive it.
    mapping(uint256 => bool) public seqMintIndexSeen;
    mapping(uint256 => bool) public pooledMintIndexSeen;

    // Negative-probe flags: MUST stay false. Set true only if a probe that
    // is supposed to revert did NOT revert.
    bool public ghostUnauthorizedMintToSucceeded;
    bool public ghostWrongModeMintSucceeded;
    bool public ghostHolderBurnPooledSucceeded;

    // Call counters, useful for sanity-checking run depth in failure reports.
    uint256 public callsMintSeqExtension;
    uint256 public callsMintPooledExtension;
    uint256 public callsBurnSeq;
    uint256 public callsBurnPooled;
    uint256 public callsNegativeProbes;

    constructor(
        Surface seq_,
        PooledSurface pooled_,
        MockMinter seqMinter_,
        MockMinter pooledMinter_,
        uint256 seqCap_,
        uint256 pooledCap_
    ) {
        seq = seq_;
        pooled = pooled_;
        seqMinter = seqMinter_;
        pooledMinter = pooledMinter_;
        seqCap = seqCap_;
        pooledCap = pooledCap_;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Actor helpers — a small bounded universe so collisions and repeat
    // interactions (re-approve, re-burn) happen often.
    // ─────────────────────────────────────────────────────────────────────

    function _actor(uint256 seed) internal pure returns (address payable) {
        uint256 idx = seed % NUM_ACTORS;
        return payable(address(uint160(uint256(keccak256(abi.encode("collection-invariant-actor", idx))))));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Live-id set maintenance (sequential)
    // ─────────────────────────────────────────────────────────────────────

    function _seqLiveAdd(uint256 id) internal {
        require(!seqIsLive[id], "handler: seq id already live");
        seqIsLive[id] = true;
        _seqLiveIndex[id] = seqLiveIds.length;
        seqLiveIds.push(id);
    }

    function _seqLiveRemove(uint256 id) internal {
        require(seqIsLive[id], "handler: seq id not live");
        uint256 idx = _seqLiveIndex[id];
        uint256 lastIdx = seqLiveIds.length - 1;
        uint256 lastId = seqLiveIds[lastIdx];
        seqLiveIds[idx] = lastId;
        _seqLiveIndex[lastId] = idx;
        seqLiveIds.pop();
        seqIsLive[id] = false;
        delete _seqLiveIndex[id];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Live-id set maintenance (pooled)
    // ─────────────────────────────────────────────────────────────────────

    function _pooledLiveAdd(uint256 id) internal {
        require(!pooledIsLive[id], "handler: pooled id already live");
        pooledIsLive[id] = true;
        _pooledLiveIndex[id] = pooledLiveIds.length;
        pooledLiveIds.push(id);
    }

    function _pooledLiveRemove(uint256 id) internal {
        require(pooledIsLive[id], "handler: pooled id not live");
        uint256 idx = _pooledLiveIndex[id];
        uint256 lastIdx = pooledLiveIds.length - 1;
        uint256 lastId = pooledLiveIds[lastIdx];
        pooledLiveIds[idx] = lastId;
        _pooledLiveIndex[lastId] = idx;
        pooledLiveIds.pop();
        pooledIsLive[id] = false;
        delete _pooledLiveIndex[id];
    }

    function seqLiveCount() external view returns (uint256) {
        return seqLiveIds.length;
    }

    function pooledLiveCount() external view returns (uint256) {
        return pooledLiveIds.length;
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: batch-native mintTo on the sequential collection
    // ─────────────────────────────────────────────────────────────────────

    function mintSeqExtension(uint256 actorSeed, uint256 qtySeed) external {
        address to = _actor(actorSeed);
        uint256 quantity = bound(qtySeed, 1, 4);

        if (seqCap != 0 && ghostSeqMints >= seqCap) return;
        if (seqCap != 0 && ghostSeqMints + quantity > seqCap) {
            quantity = seqCap - ghostSeqMints;
        }
        if (quantity == 0) return;

        try seqMinter.callMintTo(ISurface(address(seq)), to, quantity) returns (uint256 firstTokenId) {
            callsMintSeqExtension++;
            uint256 expectedFirstId = ghostSeqMints + 1;
            require(firstTokenId == expectedFirstId, "handler: seq mintTo firstTokenId mismatch");
            for (uint256 i = 0; i < quantity; i++) {
                uint256 tokenId = firstTokenId + i;
                _seqLiveAdd(tokenId);
                uint256 mintIndex = ghostSeqMints + i;
                require(!seqMintIndexSeen[mintIndex], "handler: seq mintIndex repeat");
                seqMintIndexSeen[mintIndex] = true;
            }
            ghostSeqMints += quantity;
        } catch {
            revert("handler: authorized seq mintTo unexpectedly reverted");
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: extension mintToId on the pooled collection (bounded id space,
    // including deliberate re-mints of previously burned ids)
    // ─────────────────────────────────────────────────────────────────────

    function mintPooledExtension(uint256 actorSeed, uint256 idSeed) external {
        address to = _actor(actorSeed);
        uint256 tokenId = bound(idSeed, 0, POOLED_ID_MAX);

        if (pooledIsLive[tokenId]) return; // OZ _mint reverts on a live id; skip (not this action's probe)
        if (pooledCap != 0) {
            uint256 liveSupply = pooledLiveIds.length;
            if (liveSupply >= pooledCap) return;
        }

        try pooledMinter.callMintToId(IPooledSurface(address(pooled)), to, tokenId) {
            callsMintPooledExtension++;
            _pooledLiveAdd(tokenId);
            uint256 mintIndex = ghostPooledMints;
            require(!pooledMintIndexSeen[mintIndex], "handler: pooled mintIndex repeat");
            pooledMintIndexSeen[mintIndex] = true;
            ghostPooledMints += 1;
        } catch {
            revert("handler: authorized pooled mintToId unexpectedly reverted");
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: burn, by owner or by an approved actor, on either collection
    // ─────────────────────────────────────────────────────────────────────

    function burnSeq(uint256 idSeed, uint256 actorSeed, bool viaApproval) external {
        if (seqLiveIds.length == 0) return;
        uint256 tokenId = seqLiveIds[idSeed % seqLiveIds.length];
        address currentOwner = seq.ownerOf(tokenId);

        address caller = currentOwner;
        if (viaApproval) {
            address approved = _actor(actorSeed);
            if (approved != currentOwner) {
                vm.prank(currentOwner);
                seq.approve(approved, tokenId);
                caller = approved;
            }
        }

        vm.prank(caller);
        try seq.burn(tokenId) {
            callsBurnSeq++;
            _seqLiveRemove(tokenId);
            seqEverBurned[tokenId] = true;
            ghostSeqBurns += 1;
        } catch {
            revert("handler: authorized seq burn unexpectedly reverted");
        }
    }

    /// @dev Pooled burns are minter-only (the minter owns the pool), so the
    ///      burn goes through the granted minter — the redeem path a real
    ///      backed form uses.
    function burnPooled(uint256 idSeed) external {
        if (pooledLiveIds.length == 0) return;
        uint256 tokenId = pooledLiveIds[idSeed % pooledLiveIds.length];

        try pooledMinter.callBurn(ISurfaceCore(address(pooled)), tokenId) {
            callsBurnPooled++;
            _pooledLiveRemove(tokenId);
            ghostPooledBurns += 1;
        } catch {
            revert("handler: authorized pooled burn unexpectedly reverted");
        }
    }

    /// @dev A holder (or anyone but a minter) must NOT be able to burn a
    ///      pooled token out-of-band and strand its backing.
    function probeHolderBurnPooled(uint256 idSeed) external {
        callsNegativeProbes++;
        if (pooledLiveIds.length == 0) return;
        uint256 tokenId = pooledLiveIds[idSeed % pooledLiveIds.length];
        address currentOwner = pooled.ownerOf(tokenId);

        vm.prank(currentOwner);
        try pooled.burn(tokenId) {
            ghostHolderBurnPooledSucceeded = true;
        } catch {}
    }

    // ─────────────────────────────────────────────────────────────────────
    // NEGATIVE PROBES — every one of these MUST revert. Wrapped in try/catch
    // so an unexpected success flips a ghost flag instead of killing the run
    // (which would hide the very bug this exists to catch).
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Unauthorized address calling mintTo directly (not via the granted
    ///      MockMinter) on the sequential collection.
    function probeUnauthorizedMintTo(uint256 actorSeed) external {
        callsNegativeProbes++;
        address caller = _actor(actorSeed);
        address to = _actor(actorSeed + 1);
        vm.prank(caller);
        try seq.mintTo(to, 1) returns (uint256) {
            ghostUnauthorizedMintToSucceeded = true;
        } catch {}
    }

    /// @dev Wrong-form mint calls. Each form is its own contract now, so the
    ///      other form's entrypoint does not exist — these are raw selector
    ///      probes asserting the dispatcher rejects them (no accidental
    ///      selector collision, no accepting fallback).
    function probeWrongModeMint(uint256 actorSeed, uint256 idSeed) external {
        callsNegativeProbes++;
        address actor = _actor(actorSeed);
        uint256 id = bound(idSeed, 0, POOLED_ID_MAX);

        // (a) mintToId on the sequential collection: no such function.
        (bool okA,) = address(seq).call(abi.encodeWithSignature("mintToId(address,uint256)", actor, id));
        if (okA) ghostWrongModeMintSucceeded = true;

        // (b) extension mintTo on the pooled collection: no such function.
        (bool okB,) = address(pooled).call(abi.encodeWithSignature("mintTo(address,uint256)", actor, uint256(1)));
        if (okB) ghostWrongModeMintSucceeded = true;
    }
}
