// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IAttribution} from "./interfaces/IAttribution.sol";

/// @title Attribution
/// @notice Generic, immutable, public infrastructure recording the
///         works -> artists half of the bilateral attribution handshake.
///         `Catalog.sol` is the other half (artists -> works): an artist
///         calls `Catalog.addContract(collection)` to claim a work as its
///         own. This contract records the reverse direction: a collection's
///         owner (or the collection itself, e.g. a factory writing at init)
///         declares which artist addresses collaborated on it.
///
/// @dev    CORE MEANING (read carefully before consuming this contract):
///
///         This contract only means: "the collection's owner (or the
///         collection itself, acting during its own initialization)
///         asserted that these addresses are this collection's artists."
///
///         It does NOT prove that a listed artist actually contributed,
///         consented, or is even aware of the listing. A roster entry is a
///         one-sided claim, exactly like a `Catalog` pointer is a one-sided
///         claim in the other direction.
///
///         CONFIRMED ATTRIBUTION IS THE INTERSECTION, COMPUTED OFF-CHAIN:
///
///           confirmed(collection, artist) :=
///               artist IN Attribution.artistsOf(collection)
///               AND
///               Catalog.isContractRegistered(artist, collection)
///
///         Neither half proves the other. A collection can list an artist
///         who never claims it in their `Catalog` (an unconfirmed credit).
///         An artist can claim a collection in their `Catalog` that never
///         lists them here (a self-asserted, unconfirmed claim from the
///         other side). Only an indexer or UI that reads both halves and
///         computes the intersection can say "mutually confirmed." This
///         contract does not compute that intersection itself — doing so
///         onchain would require this contract to read `Catalog` (a
///         specific deployment, on a specific chain, at a specific
///         address) and would couple two otherwise-independent singletons.
///         Keeping them decoupled means either can be deployed, replaced,
///         or omitted without touching the other.
///
/// @dev    SCOPE BOUNDARIES:
///
///         No admin, no owner, no upgrade path, no fees, no pause, no
///         protocol logic. The only privileged role is per-collection:
///         either the collection contract itself (`msg.sender ==
///         collection`) or, if the collection exposes a standard
///         `owner()` view (e.g. it inherits OZ `Ownable`), that owner.
///         See `_isAuthorized` for exactly how "the collection has an
///         owner" is determined — many contracts are not `Ownable` at
///         all, and for those only the self-call path ever works.
///
///         Reverse lookups (which collections list a given artist) are
///         intentionally NOT provided here, mirroring `Catalog`'s choice
///         to keep the on-chain surface minimal: enumerating "all
///         collections that name artist X" is an indexer's job (scan
///         `ArtistsSet` events and build the reverse map off-chain), not
///         a storage structure this contract should pay to maintain on
///         every write.
///
///         Key rotation and identity grouping are intentionally outside
///         this contract's scope, exactly as in `Catalog`. Artists,
///         platforms, wallets, and indexers may establish continuity
///         off-chain through signatures, public statements, ENS records,
///         social verification, or other context.
///
/// @dev    PER-CHAIN, DETERMINISTIC DEPLOYMENT:
///
///         Each Attribution instance is scoped to the chain it's deployed
///         on. Rosters reference collections on that same chain — there is
///         no `chainId` field because the deployment chain is the answer.
///         Attribution instances on different chains are independent.
///
///         To land this contract at the same address on every chain,
///         deploy through the canonical CREATE2 deterministic-deployment
///         proxy (0x4e59b44847b379578588920cA78FbF26c0B4956C) with a
///         chosen salt. Identical addresses across chains require ALL of
///         the following to match:
///
///           1. same deployer (the CREATE2 proxy is identical on every
///              EVM chain it's been deployed to, which is most of them)
///           2. same salt
///           3. same init code hash (i.e. the exact same compiled
///              bytecode)
///           4. same Solidity compiler version
///           5. same optimizer settings (including `runs`)
///           6. same source code
///
///         Because this contract has no constructor arguments, the init
///         code hash is a pure function of the compiled bytecode, which
///         in turn depends on items 4-6. Salt alone is not enough —
///         pinning the toolchain matters. Deployments of `Catalog` and
///         `Attribution` are independent singletons; there is no
///         requirement (and no mechanism) linking their addresses to one
///         another, on the same chain or across chains.
contract Attribution is IAttribution {
    // ─── Storage ────────────────────────────────────────────────────

    /// @dev Per-collection artist roster. Replaced wholesale by
    ///      `setArtists`, never appended to incrementally — see
    ///      `setArtists` natspec for why replace-not-append is the
    ///      chosen semantics.
    mapping(address => address[]) private _artists;

    /// @dev One-way lock per collection. Once true, `setArtists` for that
    ///      collection reverts forever. There is no unlock function.
    mapping(address => bool) private _locked;

    // ─── Errors ─────────────────────────────────────────────────────

    /// @notice Caller is neither `collection` itself nor the address
    ///         returned by a successful `owner()` staticcall on
    ///         `collection`.
    error NotAuthorized();

    /// @notice `collection` argument was the zero address.
    error InvalidCollection();

    /// @notice `artists` array was empty. `setArtists` declares a
    ///         roster; an empty roster is a no-op that would only
    ///         confuse indexers watching for `ArtistsSet`, so it is
    ///         rejected rather than silently accepted.
    error EmptyArtists();

    /// @notice The roster for `collection` is locked; `setArtists` can
    ///         never succeed again for that collection.
    error RosterAlreadyLocked();

    // ─── Internal: authorization ────────────────────────────────────

    /// @dev Reverts unless `msg.sender` is authorized to mutate the
    ///      roster for `collection`. Authorized callers are:
    ///
    ///        1. `collection` itself — covers a factory writing the
    ///           roster from inside the collection's own `initialize()`,
    ///           where `msg.sender == address(this) == collection`.
    ///        2. the address `collection.owner()` resolves to, IF
    ///           `collection` exposes a working `owner()` view.
    ///
    ///      Path 2 is evaluated with a raw `staticcall` rather than the
    ///      `Ownable` interface type, because plenty of collections
    ///      (including bespoke or third-party ones) are not `Ownable` at
    ///      all — casting and calling directly would revert with no
    ///      useful signal, or in the worst case hit a fallback function
    ///      that returns unrelated data. The staticcall is decoded
    ///      defensively and any of the following is treated as "this
    ///      collection has no owner we can trust," falling through to
    ///      `NotAuthorized` rather than reverting from inside the
    ///      authorization check itself:
    ///
    ///        - the call reverts (no `owner()` function, or `owner()`
    ///          itself reverts)
    ///        - the call returns no data, or fewer than 32 bytes (not a
    ///          single ABI-encoded address)
    ///        - the returned word, left-padded per ABI encoding, has
    ///          non-zero bits above the low 160 — i.e. it doesn't decode
    ///          to a clean `address` (guards against a fallback function
    ///          or a differently-typed `owner` matching the selector by
    ///          coincidence and returning garbage)
    ///
    ///      For a non-`Ownable` collection, only path 1 (the self-call
    ///      during init, or any other self-call the collection chooses
    ///      to make) can ever authorize a roster write.
    /// @param collection  Collection whose roster is being targeted.
    function _requireAuthorized(address collection) internal view {
        if (collection == address(0)) revert InvalidCollection();
        if (msg.sender == collection) return;

        address collectionOwner = _tryOwnerOf(collection);
        if (collectionOwner != address(0) && msg.sender == collectionOwner) {
            return;
        }
        revert NotAuthorized();
    }

    /// @dev Best-effort `owner()` read via low-level staticcall. Returns
    ///      `address(0)` for "no trustworthy owner" instead of reverting,
    ///      so callers can treat "not Ownable" as a plain negative rather
    ///      than an exceptional control-flow path. See `_requireAuthorized`
    ///      for the full rationale and the exact rejection conditions.
    /// @param collection  Contract to probe.
    /// @return             The decoded owner, or `address(0)` if the probe
    ///                      did not yield a clean, trustworthy address.
    function _tryOwnerOf(address collection) internal view returns (address) {
        // owner() -> selector 0x8da5cb5b, no arguments.
        (bool ok, bytes memory data) =
            collection.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok) return address(0);
        if (data.length < 32) return address(0);

        bytes32 word;
        assembly {
            word := mload(add(data, 32))
        }
        // A properly ABI-encoded `address` return has zero upper 96
        // bits. Anything else did not come from a well-behaved
        // `function owner() view returns (address)` and is rejected
        // rather than silently truncated.
        if (uint256(word) >> 160 != 0) return address(0);
        return address(uint160(uint256(word)));
    }

    // ─── Roster writes ──────────────────────────────────────────────

    /// @inheritdoc IAttribution
    /// @dev    REPLACES the roster; this is not an append/add operation.
    ///         Calling `setArtists` a second time with a different array
    ///         discards the previous roster entirely — there is no
    ///         partial update, no dedupe against the prior list, and no
    ///         historical roster kept in storage (the full history is
    ///         reconstructable off-chain from `ArtistsSet` events, which
    ///         fire on every call with the complete new roster).
    ///
    ///         Duplicate addresses within a single `artists` array are
    ///         not deduplicated or rejected — the array is stored as
    ///         given. Callers that care about uniqueness should dedupe
    ///         client-side; downstream indexers reading `artistsOf` can
    ///         also dedupe on read.
    ///
    ///         Reverts: `InvalidCollection` (zero collection),
    ///         `EmptyArtists` (empty array), `RosterAlreadyLocked` (roster
    ///         was previously locked via `lockRoster`), `NotAuthorized`
    ///         (see `_requireAuthorized`).
    function setArtists(address collection, address[] calldata artists) external override {
        _requireAuthorized(collection);
        if (artists.length == 0) revert EmptyArtists();
        if (_locked[collection]) revert RosterAlreadyLocked();

        _artists[collection] = artists;
        emit ArtistsSet(collection, msg.sender, artists);
    }

    /// @inheritdoc IAttribution
    /// @dev    One-way per collection: once locked, `setArtists` reverts
    ///         forever for that `collection` and there is no unlock
    ///         function. Locking with an empty (never-set) roster is
    ///         allowed and permanently freezes the roster at empty —
    ///         the same authority check applies regardless of whether a
    ///         roster was ever declared.
    ///
    ///         Calling `lockRoster` again after it is already locked is a
    ///         harmless no-op: it re-emits `RosterLocked` rather than
    ///         reverting, matching `Catalog`'s general preference for
    ///         idempotent state-setting over exceptions on redundant
    ///         calls. (Contrast with `setArtists`, which DOES revert
    ///         post-lock — that is the actual invariant being enforced;
    ///         locking twice is not.)
    ///
    ///         Reverts: `InvalidCollection` (zero collection),
    ///         `NotAuthorized` (see `_requireAuthorized`).
    function lockRoster(address collection) external override {
        _requireAuthorized(collection);
        _locked[collection] = true;
        emit RosterLocked(collection);
    }

    // ─── Views ──────────────────────────────────────────────────────

    /// @inheritdoc IAttribution
    /// @dev    Order matches the most recent `setArtists` call for
    ///         `collection`; there is no reordering or dedup on read.
    ///         For very large rosters prefer `artistsSlice` to avoid
    ///         pulling the entire array.
    function artistsOf(address collection) external view override returns (address[] memory) {
        return _artists[collection];
    }

    /// @inheritdoc IAttribution
    function isRosterLocked(address collection) external view override returns (bool) {
        return _locked[collection];
    }

    /// @notice Number of artists in `collection`'s roster.
    /// @param collection  Collection whose roster is being read.
    /// @return              Count of artist entries.
    function artistCountOf(address collection) external view returns (uint256) {
        return _artists[collection].length;
    }

    /// @notice Indexed access to a single roster entry.
    /// @dev    Reverts on out-of-bounds index (default array revert).
    /// @param collection  Collection whose roster is being read.
    /// @param index       Position in the roster array.
    /// @return              Artist address at `index`.
    function artistAt(address collection, uint256 index) external view returns (address) {
        return _artists[collection][index];
    }

    /// @notice Slice access for paginated reads. Returns up to `count`
    ///         artists starting at `start`. Tolerates out-of-range
    ///         requests:
    ///           - if `start >= length`, returns an empty array
    ///           - if `start + count > length`, returns only the
    ///             remaining elements
    /// @dev    Useful for frontends and indexers reading large rosters
    ///         without paying the gas of a full-array copy.
    /// @param collection  Collection whose roster is being read.
    /// @param start       Zero-based offset into the roster array.
    /// @param count       Maximum number of items to return.
    /// @return              Up to `count` artist addresses starting at
    ///                      `start`.
    function artistsSlice(address collection, uint256 start, uint256 count)
        external
        view
        returns (address[] memory)
    {
        address[] storage list = _artists[collection];
        uint256 len = list.length;
        if (start >= len) return new address[](0);
        uint256 available = len - start;
        uint256 take = count < available ? count : available;
        address[] memory result = new address[](take);
        for (uint256 i = 0; i < take; ++i) {
            result[i] = list[start + i];
        }
        return result;
    }
}
