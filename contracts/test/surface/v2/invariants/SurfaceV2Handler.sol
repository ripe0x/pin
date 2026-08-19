// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {SurfaceV2} from "../../../../src/surface/v2/SurfaceV2.sol";
import {ISurfaceV2} from "../../../../src/surface/v2/interfaces/ISurfaceV2.sol";
import {MockMinterV2} from "../mocks/SurfaceV2Mocks.sol";

/// @title SurfaceV2Handler
/// @notice Bounded random-walk handler driving one SurfaceV2 instance through
///         every public mint/burn/lock entrypoint, while maintaining
///         ghost-truth state the invariant test asserts against. Ported from
///         test/surface/invariants/SurfaceHandler.sol with the pooled-mode
///         half of that handler dropped: v2 has one id mode.
///
/// @dev    - The token holds no value and runs no sale logic: every mint
///           goes through a granted MockMinterV2, standing in for a real
///           minter module.
///         - The collection is supply-capped, mints exclusively through the
///           granted MockMinterV2 calling batch-native mintTo (quantity
///           varies per call, exercising single and batch mints).
///         - Every actor address is drawn from a small bounded actor set so
///           collisions (same collector minting/burning/approving
///           repeatedly) happen often, which is where id-set bugs hide.
///         - Negative probes (unauthorized mintTo, unauthorized burn) are
///           wrapped in try/catch: a probe that does NOT revert trips a
///           ghost flag the invariant test asserts false, rather than
///           reverting the whole run (which would silently drop coverage).
contract SurfaceV2Handler is StdInvariant, Test {
    // ─────────────────────────────────────────────────────────────────────
    // Fixed setup
    // ─────────────────────────────────────────────────────────────────────

    SurfaceV2 public immutable collection;
    MockMinterV2 public immutable minter;
    uint256 public immutable cap;

    uint256 public constant NUM_ACTORS = 6;

    // ─────────────────────────────────────────────────────────────────────
    // Ghost state
    // ─────────────────────────────────────────────────────────────────────

    uint256 public ghostMints;
    uint256 public ghostBurns;

    // Live id set: array (enumeration) + membership + index mapping, kept
    // coherent by _liveAdd / _liveRemove so no id can appear twice and
    // removal is O(1).
    uint256[] public liveIds;
    mapping(uint256 => bool) public isLive;
    mapping(uint256 => uint256) private _liveIndex;

    // Ids are 1..mintedEver; once burned they must never be re-minted (no
    // id-choosing entrypoint exists in v2 at all; tracked explicitly anyway).
    mapping(uint256 => bool) public everBurned;

    // Mint order bookkeeping: strictly increasing, never repeats. Sequential
    // id IS the order (id - 1 == mint index).
    mapping(uint256 => bool) public mintIndexSeen;

    // First-observed seed per token id, snapshotted at mint time. The
    // snapshotSeed probe re-reads and requires an exact match forever after
    // (mint or burn), proving the stored seed never changes once set.
    mapping(uint256 => bytes32) public seedSnapshot;
    mapping(uint256 => bool) public seedSnapshotTaken;

    // One-way lock ghosts: true once this handler successfully engaged the
    // lock. Never reset to false.
    bool public ghostRendererLockEngaged;
    bool public ghostSupplyLockEngaged;
    bool public ghostMinterLockEngaged;
    bool public ghostRoyaltyLockEngaged;

    // Negative-probe flags: MUST stay false. Set true only if a probe that
    // is supposed to revert did NOT revert.
    bool public ghostUnauthorizedMintToSucceeded;
    bool public ghostUnauthorizedBurnSucceeded;

    // Call counters, useful for sanity-checking run depth in failure reports.
    uint256 public callsMint;
    uint256 public callsBurn;
    uint256 public callsNegativeProbes;
    uint256 public callsLockAttempts;
    uint256 public callsSeedSnapshots;

    constructor(SurfaceV2 collection_, MockMinterV2 minter_, uint256 cap_) {
        collection = collection_;
        minter = minter_;
        cap = cap_;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Actor helper — a small bounded universe so collisions happen often.
    // ─────────────────────────────────────────────────────────────────────

    function _actor(uint256 seed) internal pure returns (address payable) {
        uint256 idx = seed % NUM_ACTORS;
        return payable(address(uint160(uint256(keccak256(abi.encode("surfacev2-invariant-actor", idx))))));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Live-id set maintenance
    // ─────────────────────────────────────────────────────────────────────

    function _liveAdd(uint256 id) internal {
        require(!isLive[id], "handler: id already live");
        isLive[id] = true;
        _liveIndex[id] = liveIds.length;
        liveIds.push(id);
    }

    function _liveRemove(uint256 id) internal {
        require(isLive[id], "handler: id not live");
        uint256 idx = _liveIndex[id];
        uint256 lastIdx = liveIds.length - 1;
        uint256 lastId = liveIds[lastIdx];
        liveIds[idx] = lastId;
        _liveIndex[lastId] = idx;
        liveIds.pop();
        isLive[id] = false;
        delete _liveIndex[id];
    }

    function liveCount() external view returns (uint256) {
        return liveIds.length;
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: batch-native mintTo via the granted MockMinterV2
    // ─────────────────────────────────────────────────────────────────────

    function mintExtension(uint256 actorSeed, uint256 qtySeed) external {
        address to = _actor(actorSeed);
        uint256 quantity = bound(qtySeed, 1, 4);

        if (cap != 0 && ghostMints >= cap) return;
        if (cap != 0 && ghostMints + quantity > cap) {
            quantity = cap - ghostMints;
        }
        if (quantity == 0) return;

        try minter.callMintTo(ISurfaceV2(address(collection)), to, quantity) returns (uint256 firstTokenId) {
            callsMint++;
            uint256 expectedFirstId = ghostMints + 1;
            require(firstTokenId == expectedFirstId, "handler: mintTo firstTokenId mismatch");
            for (uint256 i = 0; i < quantity; i++) {
                uint256 tokenId = firstTokenId + i;
                _liveAdd(tokenId);
                uint256 mintIndex = ghostMints + i;
                require(!mintIndexSeen[mintIndex], "handler: mintIndex repeat");
                mintIndexSeen[mintIndex] = true;
                seedSnapshot[tokenId] = collection.tokenSeed(tokenId);
                seedSnapshotTaken[tokenId] = true;
            }
            ghostMints += quantity;
        } catch {
            revert("handler: authorized mintTo unexpectedly reverted");
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: burn, by owner or by an approved actor
    // ─────────────────────────────────────────────────────────────────────

    function burn(uint256 idSeed, uint256 actorSeed, bool viaApproval) external {
        if (liveIds.length == 0) return;
        uint256 tokenId = liveIds[idSeed % liveIds.length];
        address currentOwner = collection.ownerOf(tokenId);

        address caller = currentOwner;
        if (viaApproval) {
            address approved = _actor(actorSeed);
            if (approved != currentOwner) {
                vm.prank(currentOwner);
                collection.approve(approved, tokenId);
                caller = approved;
            }
        }

        vm.prank(caller);
        try collection.burn(tokenId) {
            callsBurn++;
            _liveRemove(tokenId);
            everBurned[tokenId] = true;
            ghostBurns += 1;
        } catch {
            revert("handler: authorized burn unexpectedly reverted");
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: re-read a live or burned token's seed and assert it matches
    // the snapshot taken at mint time. Not wrapped in try/catch: a mismatch
    // here IS the bug this probe exists to catch, so it should fail the run
    // loudly rather than being swallowed.
    // ─────────────────────────────────────────────────────────────────────

    function snapshotSeed(uint256 idSeed) external {
        callsSeedSnapshots++;
        uint256 mintedEver = ghostMints;
        if (mintedEver == 0) return;
        uint256 tokenId = bound(idSeed, 1, mintedEver);
        if (!seedSnapshotTaken[tokenId]) return;
        require(collection.tokenSeed(tokenId) == seedSnapshot[tokenId], "handler: stored seed changed after mint");
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: attempt each one-way lock. A second/later attempt reverting
    // once already engaged is expected and swallowed; only success updates
    // the ghost.
    // ─────────────────────────────────────────────────────────────────────

    function lockRenderer() external {
        callsLockAttempts++;
        vm.prank(collection.owner());
        try collection.lockRenderer() {
            ghostRendererLockEngaged = true;
        } catch {}
    }

    function lockSupply() external {
        callsLockAttempts++;
        vm.prank(collection.owner());
        try collection.lockSupply() {
            ghostSupplyLockEngaged = true;
        } catch {}
    }

    function lockMinter() external {
        callsLockAttempts++;
        vm.prank(collection.owner());
        try collection.lockMinter() {
            ghostMinterLockEngaged = true;
        } catch {}
    }

    function lockRoyalty() external {
        callsLockAttempts++;
        vm.prank(collection.owner());
        try collection.lockRoyalty() {
            ghostRoyaltyLockEngaged = true;
        } catch {}
    }

    // ─────────────────────────────────────────────────────────────────────
    // NEGATIVE PROBES — every one of these MUST revert. Wrapped in try/catch
    // so an unexpected success flips a ghost flag instead of killing the run.
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Unauthorized address calling mintTo directly (not via the
    ///      granted MockMinterV2).
    function probeUnauthorizedMintTo(uint256 actorSeed) external {
        callsNegativeProbes++;
        address caller = _actor(actorSeed);
        address to = _actor(actorSeed + 1);
        vm.prank(caller);
        try collection.mintTo(to, 1) returns (uint256) {
            ghostUnauthorizedMintToSucceeded = true;
        } catch {}
    }

    /// @dev A non-owner, non-approved actor burning a live token.
    function probeUnauthorizedBurn(uint256 idSeed, uint256 actorSeed) external {
        callsNegativeProbes++;
        if (liveIds.length == 0) return;
        uint256 tokenId = liveIds[idSeed % liveIds.length];
        address currentOwner = collection.ownerOf(tokenId);
        address caller = _actor(actorSeed);
        // Skip the (rare, bounded-actor-space) collision where the drawn
        // actor happens to already be the owner or an approved operator.
        if (caller == currentOwner) return;
        if (collection.getApproved(tokenId) == caller) return;
        if (collection.isApprovedForAll(currentOwner, caller)) return;

        vm.prank(caller);
        try collection.burn(tokenId) {
            ghostUnauthorizedBurnSucceeded = true;
        } catch {}
    }
}
