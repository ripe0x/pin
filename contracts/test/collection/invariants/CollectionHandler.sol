// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {Collection} from "../../../src/collection/Collection.sol";
import {ICollection} from "../../../src/collection/interfaces/ICollection.sol";
import {MockMinter} from "../mocks/CollectionMocks.sol";

/// @title CollectionHandler
/// @notice Bounded random-walk handler driving two Collection
///         instances (one Sequential, one Pooled) through every public mint /
///         burn / withdraw entrypoint, while maintaining ghost-truth state the
///         invariant test asserts against.
///
/// @dev    Design notes:
///         - Sequential collection: fixed price, supply-capped, sells through
///           both the built-in paid path (mint/mintWithReferral) AND a granted
///           MockMinter (mintTo).
///         - Pooled collection: no built-in paid path (the core rejects it);
///           sells exclusively through a granted MockMinter calling mintToId
///           with ids bounded to [0, POOLED_ID_MAX], so burn -> re-mint of the
///           same id is exercised constantly. Also supply-capped, bounding
///           LIVE totalSupply per pooled cap semantics.
///         - Every actor address is drawn from a small bounded actor set so
///           collisions (same collector minting/burning/approving repeatedly)
///           happen often, which is where id-set and pull-accounting bugs
///           tend to hide.
///         - Negative probes (unauthorized mintTo, wrong-mode mint, wrong
///           payment) are wrapped in try/catch: a probe that does NOT revert
///           trips a ghost flag the invariant test asserts false, rather than
///           reverting the whole run (which would silently drop coverage).
contract CollectionHandler is StdInvariant, Test {
    // ─────────────────────────────────────────────────────────────────────
    // Fixed setup
    // ─────────────────────────────────────────────────────────────────────

    Collection public immutable seq; // Sequential mode
    Collection public immutable pooled; // Pooled mode
    MockMinter public immutable seqMinter; // granted on seq (mintTo)
    MockMinter public immutable pooledMinter; // granted on pooled (mintToId)

    uint256 public immutable seqPrice;
    uint256 public immutable seqCap;
    uint256 public immutable pooledCap;

    uint256 public constant POOLED_ID_MAX = 50; // bounded id space [0, 50]
    uint256 public constant NUM_ACTORS = 6;

    // ─────────────────────────────────────────────────────────────────────
    // Ghost state (the handler's own truth, checked against the contracts)
    // ─────────────────────────────────────────────────────────────────────

    // Funds
    uint256 public ghostTotalPaidIn; // sum of all msg.value that entered settle() across both collections
    uint256 public ghostTotalWithdrawn; // sum of every successful withdraw() amount
    mapping(address => uint256) public ghostPending; // mirrored per-payee pull balance, both collections combined
    address[] public ghostPayeesEver; // de-duplicated list of every address ever credited
    mapping(address => bool) public ghostIsKnownPayee;

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
    // increase across BOTH paths, on a single shared counter, and never
    // repeat. Mint order is 0-based and global per collection, stamped in
    // the Minted event (sequential id == index + 1); ghosts derive it.
    uint256 public seqLastMintIndex; // last observed mintIndex + 1 (0 means "none yet")
    bool public seqHasMinted;
    uint256 public pooledLastMintIndex;
    bool public pooledHasMinted;
    mapping(uint256 => bool) public seqMintIndexSeen;
    mapping(uint256 => bool) public pooledMintIndexSeen;

    // Negative-probe flags: MUST stay false. Set true only if a probe that
    // is supposed to revert did NOT revert.
    bool public ghostUnauthorizedMintToSucceeded;
    bool public ghostWrongModeMintSucceeded;
    bool public ghostWrongPaymentMintSucceeded;

    // Call counters, useful for sanity-checking run depth in failure reports.
    uint256 public callsMintSeqPaid;
    uint256 public callsMintSeqExtension;
    uint256 public callsMintPooledExtension;
    uint256 public callsBurnSeq;
    uint256 public callsBurnPooled;
    uint256 public callsWithdraw;
    uint256 public callsNegativeProbes;

    constructor(
        Collection seq_,
        Collection pooled_,
        MockMinter seqMinter_,
        MockMinter pooledMinter_,
        uint256 seqPrice_,
        uint256 seqCap_,
        uint256 pooledCap_
    ) {
        seq = seq_;
        pooled = pooled_;
        seqMinter = seqMinter_;
        pooledMinter = pooledMinter_;
        seqPrice = seqPrice_;
        seqCap = seqCap_;
        pooledCap = pooledCap_;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Actor / referrer helpers — small bounded universes so collisions and
    // repeat interactions (re-approve, re-burn, re-withdraw) happen often.
    // ─────────────────────────────────────────────────────────────────────

    function _actor(uint256 seed) internal pure returns (address payable) {
        uint256 idx = seed % NUM_ACTORS;
        return payable(address(uint160(uint256(keccak256(abi.encode("collection-invariant-actor", idx))))));
    }

    function _referrer(uint256 seed) internal pure returns (address) {
        // Include address(0) in the referrer universe deliberately: referrer==0
        // folds the whole amount to the artist, a distinct accounting path.
        uint256 idx = seed % (NUM_ACTORS + 1);
        if (idx == NUM_ACTORS) return address(0);
        return address(uint160(uint256(keccak256(abi.encode("collection-invariant-referrer", idx)))));
    }

    function _trackPayee(address payee) internal {
        if (!ghostIsKnownPayee[payee]) {
            ghostIsKnownPayee[payee] = true;
            ghostPayeesEver.push(payee);
        }
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

    function ghostPayeeCount() external view returns (uint256) {
        return ghostPayeesEver.length;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Shared settle-accounting mirror: replicates Collection's
    // _settle() split exactly (10% referral share, folds to artist when
    // referrer == 0), so ghostPending matches pendingWithdrawal() precisely.
    // ─────────────────────────────────────────────────────────────────────

    uint16 private constant BPS = 10_000;
    uint16 private constant REFERRAL_SHARE_BPS = 1_000;

    function _mirrorSettle(uint256 total, address referrer, address artistPayout) internal {
        if (total == 0) return;
        ghostTotalPaidIn += total;
        uint256 referralCut = referrer == address(0) ? 0 : (total * REFERRAL_SHARE_BPS) / BPS;
        if (referralCut > 0) {
            ghostPending[referrer] += referralCut;
            _trackPayee(referrer);
        }
        uint256 artistCut = total - referralCut;
        if (artistCut > 0) {
            ghostPending[artistPayout] += artistCut;
            _trackPayee(artistPayout);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: paid mint on the sequential collection (mint / mintWithReferral)
    // ─────────────────────────────────────────────────────────────────────

    function mintSeqPaid(uint256 actorSeed, uint256 referrerSeed, uint256 qtySeed, bool useReferral) external {
        address payable buyer = _actor(actorSeed);
        address referrer = useReferral ? _referrer(referrerSeed) : address(0);
        uint256 quantity = bound(qtySeed, 1, 4);

        // Respect the cap so this is a "normal" action, not a probe: bound
        // quantity down to whatever room remains (skip the call entirely if
        // the cap is already exhausted, exercised separately as a probe).
        if (seqCap != 0 && ghostSeqMints >= seqCap) return;
        if (seqCap != 0 && ghostSeqMints + quantity > seqCap) {
            quantity = seqCap - ghostSeqMints;
        }
        if (quantity == 0) return;

        uint256 value = seqPrice * quantity;
        vm.deal(buyer, value);
        vm.prank(buyer);
        if (useReferral) {
            try seq.mintWithReferral{value: value}(quantity, referrer, "") {
                _afterSeqMint(quantity, referrer, value);
                callsMintSeqPaid++;
            } catch {
                revert("handler: sequential mintWithReferral unexpectedly reverted");
            }
        } else {
            try seq.mint{value: value}(quantity) {
                _afterSeqMint(quantity, address(0), value);
                callsMintSeqPaid++;
            } catch {
                revert("handler: sequential mint unexpectedly reverted");
            }
        }
    }

    function _afterSeqMint(uint256 quantity, address referrer, uint256 value) internal {
        // firstTokenId is whatever _nextId was before this call, which is
        // ghostSeqMints + 1 (sequential ids start at 1, never recycle).
        uint256 firstTokenId = ghostSeqMints + 1;
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = firstTokenId + i;
            _seqLiveAdd(tokenId);
            uint256 mintIndex = ghostSeqMints + i;
            require(!seqMintIndexSeen[mintIndex], "handler: seq mintIndex repeat");
            seqMintIndexSeen[mintIndex] = true;
        }
        ghostSeqMints += quantity;
        seqHasMinted = true;
        seqLastMintIndex = ghostSeqMints; // next expected mintIndex

        _mirrorSettle(value, referrer, seq.owner());
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: extension mintTo on the sequential collection
    // ─────────────────────────────────────────────────────────────────────

    function mintSeqExtension(uint256 actorSeed, uint256 referrerSeed) external {
        address to = _actor(actorSeed);
        address referrer = _referrer(referrerSeed);

        if (seqCap != 0 && ghostSeqMints >= seqCap) return;

        try seqMinter.callMintTo(ICollection(address(seq)), to, referrer, "") returns (uint256 tokenId) {
            callsMintSeqExtension++;
            uint256 expectedId = ghostSeqMints + 1;
            require(tokenId == expectedId, "handler: seq mintTo id mismatch");
            _seqLiveAdd(tokenId);
            uint256 mintIndex = ghostSeqMints;
            require(!seqMintIndexSeen[mintIndex], "handler: seq mintIndex repeat (extension)");
            seqMintIndexSeen[mintIndex] = true;
            ghostSeqMints += 1;
            seqHasMinted = true;
            seqLastMintIndex = ghostSeqMints;
            // mintTo is non-payable / gas-only from the core's perspective:
            // no settle() runs, so no ghost funds move. (A real extension
            // minter might collect its own payment out-of-band, but that
            // money never touches this collection's pull-accounting.)
        } catch {
            revert("handler: authorized seq mintTo unexpectedly reverted");
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: extension mintToId on the pooled collection (bounded id space,
    // including deliberate re-mints of previously burned ids)
    // ─────────────────────────────────────────────────────────────────────

    function mintPooledExtension(uint256 actorSeed, uint256 referrerSeed, uint256 idSeed) external {
        address to = _actor(actorSeed);
        address referrer = _referrer(referrerSeed);
        uint256 tokenId = bound(idSeed, 0, POOLED_ID_MAX);

        if (pooledIsLive[tokenId]) return; // OZ _mint reverts on a live id; skip (not this action's probe)
        if (pooledCap != 0) {
            uint256 liveSupply = pooledLiveIds.length;
            if (liveSupply >= pooledCap) return;
        }

        try pooledMinter.callMintToId(ICollection(address(pooled)), to, tokenId, referrer, "") {
            callsMintPooledExtension++;
            _pooledLiveAdd(tokenId);
            uint256 mintIndex = ghostPooledMints;
            require(!pooledMintIndexSeen[mintIndex], "handler: pooled mintIndex repeat");
            pooledMintIndexSeen[mintIndex] = true;
            ghostPooledMints += 1;
            pooledHasMinted = true;
            pooledLastMintIndex = ghostPooledMints;
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

    function burnPooled(uint256 idSeed, uint256 actorSeed, bool viaApproval) external {
        if (pooledLiveIds.length == 0) return;
        uint256 tokenId = pooledLiveIds[idSeed % pooledLiveIds.length];
        address currentOwner = pooled.ownerOf(tokenId);

        address caller = currentOwner;
        if (viaApproval) {
            address approved = _actor(actorSeed);
            if (approved != currentOwner) {
                vm.prank(currentOwner);
                pooled.approve(approved, tokenId);
                caller = approved;
            }
        }

        vm.prank(caller);
        try pooled.burn(tokenId) {
            callsBurnPooled++;
            _pooledLiveRemove(tokenId);
            ghostPooledBurns += 1;
        } catch {
            revert("handler: authorized pooled burn unexpectedly reverted");
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ACTION: withdraw, for any address ever credited on either collection
    // ─────────────────────────────────────────────────────────────────────

    function withdrawSeq(uint256 payeeSeed) external {
        if (ghostPayeesEver.length == 0) return;
        address payee = ghostPayeesEver[payeeSeed % ghostPayeesEver.length];
        uint256 owed = seq.pendingWithdrawal(payee);
        if (owed == 0) return;
        seq.withdraw(payee); // permissionless trigger
        callsWithdraw++;
        ghostPending[payee] -= owed;
        ghostTotalWithdrawn += owed;
    }

    function withdrawPooled(uint256 payeeSeed) external {
        if (ghostPayeesEver.length == 0) return;
        address payee = ghostPayeesEver[payeeSeed % ghostPayeesEver.length];
        uint256 owed = pooled.pendingWithdrawal(payee);
        if (owed == 0) return;
        pooled.withdraw(payee);
        callsWithdraw++;
        ghostPending[payee] -= owed;
        ghostTotalWithdrawn += owed;
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
        try seq.mintTo(to, address(0), "") returns (uint256) {
            ghostUnauthorizedMintToSucceeded = true;
        } catch {}
    }

    /// @dev Wrong-mode mint calls: mintToId on the sequential collection
    ///      (sequential assigns its own ids) and mint()/mintTo() on the
    ///      pooled collection (pooled has no built-in paid path and no
    ///      sequential extension entrypoint).
    function probeWrongModeMint(uint256 actorSeed, uint256 idSeed) external {
        callsNegativeProbes++;
        address actor = _actor(actorSeed);
        uint256 id = bound(idSeed, 0, POOLED_ID_MAX);

        // (a) mintToId on Sequential, via the granted seq minter (authorized,
        // but wrong mode — must fail on mode, not on authorization).
        try seqMinter.callMintToId(ICollection(address(seq)), actor, id, address(0), "") {
            ghostWrongModeMintSucceeded = true;
        } catch {}

        // (b) paid mint() on Pooled (no built-in paid path in pooled mode).
        vm.deal(actor, 1 ether);
        vm.prank(actor);
        try pooled.mint{value: 0}(1) {
            ghostWrongModeMintSucceeded = true;
        } catch {}

        // (c) extension mintTo on Pooled, via the granted pooled minter
        // (authorized, but wrong entrypoint for pooled mode).
        try pooledMinter.callMintTo(ICollection(address(pooled)), actor, address(0), "") returns (uint256) {
            ghostWrongModeMintSucceeded = true;
        } catch {}
    }

    /// @dev Wrong payment on the sequential paid path: off-by-one under AND
    ///      over the exact required value must both revert ("SC: wrong
    ///      payment" — the fixed-price path requires an exact match).
    function probeWrongPayment(uint256 actorSeed, uint256 qtySeed, bool over) external {
        callsNegativeProbes++;
        if (seqPrice == 0) return; // no wrong-payment concept on a gas-only price
        address payable actor = _actor(actorSeed);
        uint256 quantity = bound(qtySeed, 1, 4);
        uint256 exact = seqPrice * quantity;
        uint256 wrongValue = over ? exact + 1 : (exact == 0 ? 0 : exact - 1);
        if (!over && wrongValue == exact) return; // exact was already 0; nothing "under" to test

        vm.deal(actor, wrongValue + 1 ether);
        vm.prank(actor);
        try seq.mint{value: wrongValue}(quantity) {
            ghostWrongPaymentMintSucceeded = true;
        } catch {}
    }
}
