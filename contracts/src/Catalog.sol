// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Multicall} from "openzeppelin-contracts/contracts/utils/Multicall.sol";

/// @title Catalog
/// @notice Immutable public registry where an artist address publishes
///         on-chain pointers. A pointer is one of three types: a
///         contract address, a single token on a contract, or a
///         contiguous range of token IDs on a contract.
///
/// @dev    CORE MEANING:
///
///         A catalog entry records only that a given artist address
///         added a given pointer.
///
///         It does not prove authorship, provenance, token type,
///         authenticity, ownership, creator status, or endorsement.
///         It does not verify that the referenced contract or token
///         exists, behaves as an NFT, or implements any standard.
///
///         Interpreting pointers, checking interfaces, resolving
///         metadata, scoring confidence, and surfacing conflicts are
///         the responsibility of downstream indexers and UIs. The
///         contract holds no semantics; semantics live off-chain.
///
///         Order is not guaranteed because removal uses swap-and-pop:
///         removing an element that is not last moves the tail element
///         into the freed slot. Consumers that need a specific order
///         sort off-chain.
///
///         Overlapping token ranges are allowed. Identity for a range
///         pointer is the exact `(contract, startTokenId, endTokenId)`
///         tuple; two ranges with different bounds are distinct
///         entries even if they overlap.
///
/// @dev    SCOPE BOUNDARIES:
///
///         No admin, owner, upgrade path, fees, pause, or protocol
///         logic. The only privileged role is per-artist: an artist
///         may approve operators to add and remove pointers on its
///         behalf.
///
///         Key rotation and identity grouping are out of scope.
///         Continuity across addresses may be established off-chain
///         via signatures, public statements, ENS records, social
///         verification, or other context. This contract records only
///         pointers added by a specific address; aggregating records
///         across addresses is an off-chain concern.
///
/// @dev    PER-CHAIN, DETERMINISTIC DEPLOYMENT:
///
///         Each catalog instance is scoped to its deployment chain.
///         Pointers reference contracts on that same chain; there is no
///         `chainId` field because the deployment chain is implicit.
///         Catalogs on different chains are independent.
///
///         To deploy the catalog at the same address on every chain,
///         deploy through the canonical CREATE2 deterministic-
///         deployment proxy (0x4e59b44847b379578588920cA78FbF26c0B4956C)
///         with a chosen salt. Identical addresses across chains
///         require ALL of the following to match:
///
///           1. same deployer (the CREATE2 proxy has an identical
///              address on every EVM chain it is deployed to, which is
///              most of them)
///           2. same salt
///           3. same init code hash (the exact same compiled bytecode)
///           4. same Solidity compiler version
///           5. same optimizer settings (including `runs`)
///           6. same source code
///
///         This contract has no constructor arguments, so the init code
///         hash is a function of the compiled bytecode alone, which
///         depends on items 4-6. Salt alone is not sufficient; the
///         toolchain must be pinned.
///
/// @dev    BATCHING VIA MULTICALL:
///
///         Inherits OpenZeppelin's `Multicall`. An artist or approved
///         operator can submit a mix of pointer operations in one
///         transaction via `multicall(bytes[] calls)`, where each
///         `bytes` is an ABI-encoded call to one of this contract's
///         functions.
///
///         When an artist adds N pointers as separate transactions, the
///         dominant cost is per-transaction intrinsic gas (~21k) plus
///         wallet signature friction, both linear in N. Batching
///         reduces these to one transaction and one signature. Each
///         inner call still emits its own event, so indexers see one
///         add/remove event per pointer with no batch-specific
///         decoding.
///
///         Atomicity: `multicall` reverts the entire batch on the first
///         inner revert. A duplicate add, an unauthorized `*For` call,
///         or an invalid range reverts every preceding operation in the
///         same batch. Resolve expected reverts client-side before
///         submission.
///
///         Authorization: each inner call executes via `delegatecall`
///         from this contract to itself, so `msg.sender` is preserved
///         as the original external caller. `addContractFor` and
///         similar enforce the same operator check inside a batch as
///         outside it.
contract Catalog is Multicall {
    // ─── Types ──────────────────────────────────────────────────────

    /// @notice A pointer to a single token on a given contract.
    /// @param contractAddress  The contract that holds the token. Must be non-zero.
    /// @param tokenId          Any uint256. Not bounded.
    struct TokenPointer {
        address contractAddress;
        uint256 tokenId;
    }

    /// @notice A pointer to a contiguous, inclusive range of token IDs
    ///         on a given contract. `startTokenId == endTokenId` is
    ///         allowed and describes one token, but it remains a range
    ///         pointer and is stored independently from a `TokenPointer`:
    ///         the same token can be registered as both an `addToken`
    ///         entry and a single-token range, stored in separate lists
    ///         under separate keys. The catalog does not treat them as
    ///         equivalent or deduplicate across pointer types.
    /// @param contractAddress  The contract that holds the tokens. Must be non-zero.
    /// @param startTokenId     Inclusive lower bound. Must be <= endTokenId.
    /// @param endTokenId       Inclusive upper bound.
    struct TokenRangePointer {
        address contractAddress;
        uint256 startTokenId;
        uint256 endTokenId;
    }

    // ─── Storage ────────────────────────────────────────────────────

    /// @dev Per-artist enumerable list of contract addresses. Order is
    ///      not guaranteed: swap-and-pop removal swaps the last element
    ///      into the removed slot. Contract pointers are stored as plain
    ///      addresses (no struct) since chainId is implicit.
    mapping(address => address[]) private _artistContracts;

    /// @dev Per-artist enumerable list of single-token pointers.
    mapping(address => TokenPointer[]) private _artistTokens;

    /// @dev Per-artist enumerable list of token-range pointers.
    mapping(address => TokenRangePointer[]) private _artistTokenRanges;

    /// @dev index-plus-one map for O(1) contract-pointer existence
    ///      checks and swap-and-pop. Zero means not present; a value of
    ///      (index + 1) means present at _artistContracts[index].
    //
    // The +1 offset provides a sentinel: an unread map entry defaults to
    // zero, so storing raw indices would make "missing" and "present at
    // slot 0" both read as zero. Offsetting by one distinguishes
    // "missing" without a parallel boolean map.
    mapping(address => mapping(bytes32 => uint256)) private _contractIndexPlusOne;

    /// @dev index-plus-one map for token pointers. See _contractIndexPlusOne.
    mapping(address => mapping(bytes32 => uint256)) private _tokenIndexPlusOne;

    /// @dev index-plus-one map for token-range pointers. See _contractIndexPlusOne.
    mapping(address => mapping(bytes32 => uint256)) private _tokenRangeIndexPlusOne;

    /// @notice `isOperator[artist][operator]` is true iff `artist` has
    ///         approved `operator` to add and remove pointers on its
    ///         behalf via the `*For` functions.
    /// @dev    Operators cannot sub-delegate (cannot call setOperator
    ///         for another artist).
    //
    // `public` auto-generates the external getter
    // `isOperator(address, address) returns (bool)`, which is the public
    // read surface; no separate getter is defined.
    mapping(address => mapping(address => bool)) public isOperator;

    // ─── Events ─────────────────────────────────────────────────────

    /// @notice Emitted when a contract pointer is added to an artist's
    ///         catalog.
    /// @dev    `actor` is the `msg.sender` of the originating call:
    ///         either the artist (direct path) or an approved operator
    ///         (`*For` path). Including it in the event makes operator
    ///         attribution self-contained, so consumers need not
    ///         correlate against the transaction sender separately. For
    ///         `*For` calls `artist != actor`; for direct calls
    ///         `artist == actor`.
    /// @param artist           The artist whose catalog was modified.
    /// @param actor            The address that initiated the mutation.
    /// @param contractAddress  The contract address pointed at.
    event ContractAdded(
        address indexed artist,
        address indexed actor,
        address indexed contractAddress
    );

    /// @notice Emitted when a contract pointer is removed from an
    ///         artist's catalog.
    /// @dev    See `ContractAdded` for the `actor` rationale.
    /// @param artist           The artist whose catalog was modified.
    /// @param actor            The address that initiated the mutation.
    /// @param contractAddress  The contract address that was removed.
    event ContractRemoved(
        address indexed artist,
        address indexed actor,
        address indexed contractAddress
    );

    /// @notice Emitted when a single-token pointer is added to an
    ///         artist's catalog.
    /// @dev    `tokenId` is not indexed: log topic slots are limited to
    ///         three, and `artist`, `actor`, and `contractAddress` are
    ///         the more frequently filtered fields. Indexers needing
    ///         per-tokenId filtering decode it from the data segment.
    /// @param artist           The artist whose catalog was modified.
    /// @param actor            The address that initiated the mutation.
    /// @param contractAddress  The contract that holds the token.
    /// @param tokenId          The specific token being pointed at.
    event TokenAdded(
        address indexed artist,
        address indexed actor,
        address indexed contractAddress,
        uint256 tokenId
    );

    /// @notice Emitted when a single-token pointer is removed from an
    ///         artist's catalog.
    /// @dev    See `TokenAdded` for the indexing rationale.
    /// @param artist           The artist whose catalog was modified.
    /// @param actor            The address that initiated the mutation.
    /// @param contractAddress  The contract that held the token.
    /// @param tokenId          The token id that was removed.
    event TokenRemoved(
        address indexed artist,
        address indexed actor,
        address indexed contractAddress,
        uint256 tokenId
    );

    /// @notice Emitted when a token-range pointer is added to an
    ///         artist's catalog.
    /// @param artist           The artist whose catalog was modified.
    /// @param actor            The address that initiated the mutation.
    /// @param contractAddress  The contract that holds the tokens.
    /// @param startTokenId     Inclusive lower bound of the range.
    /// @param endTokenId       Inclusive upper bound of the range.
    event TokenRangeAdded(
        address indexed artist,
        address indexed actor,
        address indexed contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    );

    /// @notice Emitted when a token-range pointer is removed from an
    ///         artist's catalog.
    /// @param artist           The artist whose catalog was modified.
    /// @param actor            The address that initiated the mutation.
    /// @param contractAddress  The contract that held the tokens.
    /// @param startTokenId     Inclusive lower bound that was removed.
    /// @param endTokenId       Inclusive upper bound that was removed.
    event TokenRangeRemoved(
        address indexed artist,
        address indexed actor,
        address indexed contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    );

    /// @notice Emitted whenever `setOperator` is called, including when
    ///         the new value equals the existing value, providing a
    ///         uniform audit trail downstream.
    /// @param artist    The artist whose operator slot was set.
    /// @param operator  The address being approved or revoked.
    /// @param approved  New value of `isOperator[artist][operator]`.
    event OperatorSet(
        address indexed artist,
        address indexed operator,
        bool approved
    );

    // ─── Errors ─────────────────────────────────────────────────────

    /// @notice Caller is neither the artist nor an approved operator
    ///         for the artist parameter of a `*For` function.
    error NotAuthorized();

    /// @notice Artist parameter on a `*For` function was the zero
    ///         address.
    error InvalidArtist();

    /// @notice Pointer's contract address was the zero address.
    error InvalidContractAddress();

    /// @notice Operator argument to `setOperator` was the zero address.
    error InvalidOperator();

    /// @notice Token range had `startTokenId > endTokenId`. Raised on
    ///         both add and remove so the two paths reject the same
    ///         malformed inputs.
    error InvalidTokenRange();

    /// @notice Attempted to add a contract pointer that already exists
    ///         in this artist's catalog.
    error ContractAlreadyRegistered();

    /// @notice Attempted to remove a contract pointer that doesn't
    ///         exist in this artist's catalog.
    error ContractNotRegistered();

    /// @notice Attempted to add a token pointer that already exists in
    ///         this artist's catalog.
    error TokenAlreadyRegistered();

    /// @notice Attempted to remove a token pointer that doesn't exist
    ///         in this artist's catalog.
    error TokenNotRegistered();

    /// @notice Attempted to add a token-range pointer that already
    ///         exists in this artist's catalog. (Identity is the exact
    ///         (contract, start, end) tuple; overlapping ranges with
    ///         different bounds are independent entries.)
    error TokenRangeAlreadyRegistered();

    /// @notice Attempted to remove a token-range pointer that doesn't
    ///         exist in this artist's catalog.
    error TokenRangeNotRegistered();

    // ─── Internal: authorization ────────────────────────────────────

    /// @dev Reverts when `msg.sender` is not authorized to mutate the
    ///      pointer storage for `artist`. Authorized callers are the
    ///      artist itself and any address it has approved as an
    ///      operator.
    /// @param artist  Artist whose storage is being targeted.
    function _requireAuthorized(address artist) internal view {
        // Validate the artist param first so a caller passing
        // address(0) gets `InvalidArtist` rather than `NotAuthorized`.
        if (artist == address(0)) revert InvalidArtist();
        if (msg.sender != artist && !isOperator[artist][msg.sender]) {
            revert NotAuthorized();
        }
    }

    // ─── Key helpers ────────────────────────────────────────────────

    /// @notice Compute the deterministic key used internally for
    ///         contract-pointer existence checks.
    /// @dev    `keccak256(abi.encode(contractAddress))`.
    ///
    ///         Uses `abi.encode` (32-byte-aligned) rather than
    ///         `abi.encodePacked` so a contract-pointer key cannot
    ///         collide with a key for any other pointer type even when
    ///         their packed bytes would coincide. The key spaces are
    ///         also separated by distinct mappings; `encode` keeps the
    ///         non-collision property self-contained at the hashing
    ///         step.
    /// @param contractAddress  Contract address.
    /// @return                 32-byte key.
    function getContractKey(
        address contractAddress
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(contractAddress));
    }

    /// @notice Compute the deterministic key used internally for
    ///         single-token-pointer existence checks.
    /// @dev    `keccak256(abi.encode(contractAddress, tokenId))`.
    /// @param contractAddress  Contract address.
    /// @param tokenId          Token id.
    /// @return                 32-byte key.
    function getTokenKey(
        address contractAddress,
        uint256 tokenId
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(contractAddress, tokenId));
    }

    /// @notice Compute the deterministic key used internally for
    ///         token-range-pointer existence checks. Identity is the
    ///         exact tuple; two ranges with different bounds are
    ///         distinct keys even if they overlap.
    /// @dev    `keccak256(abi.encode(contractAddress, start, end))`.
    /// @param contractAddress  Contract address.
    /// @param startTokenId     Inclusive lower bound.
    /// @param endTokenId       Inclusive upper bound.
    /// @return                 32-byte key.
    function getTokenRangeKey(
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(contractAddress, startTokenId, endTokenId)
        );
    }

    // ─── Contract pointers ──────────────────────────────────────────

    /// @notice Add a contract pointer to the caller's catalog.
    /// @dev Reverts if the pointer already exists. Any address,
    ///      including an EOA, may be referenced; the only check is
    ///      non-zero.
    /// @param contractAddress  Contract being pointed at. Must be non-zero.
    function addContract(address contractAddress) external {
        _addContract(msg.sender, contractAddress);
    }

    /// @notice Add a contract pointer to `artist`'s catalog on its
    ///         behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose catalog is being updated.
    /// @param contractAddress  Contract being pointed at. Must be non-zero.
    function addContractFor(
        address artist,
        address contractAddress
    ) external {
        _requireAuthorized(artist);
        _addContract(artist, contractAddress);
    }

    /// @notice Remove a contract pointer from the caller's catalog.
    /// @dev Reverts if the pointer doesn't exist.
    /// @param contractAddress  Contract to remove from the catalog.
    function removeContract(address contractAddress) external {
        _removeContract(msg.sender, contractAddress);
    }

    /// @notice Remove a contract pointer from `artist`'s catalog on its
    ///         behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose catalog is being updated.
    /// @param contractAddress  Contract to remove from the catalog.
    function removeContractFor(
        address artist,
        address contractAddress
    ) external {
        _requireAuthorized(artist);
        _removeContract(artist, contractAddress);
    }

    /// @dev Push a contract pointer to `artist`'s list and record its
    ///      index. Emits `ContractAdded`.
    function _addContract(
        address artist,
        address contractAddress
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getContractKey(contractAddress);
        // Non-zero indexPlusOne means the pointer is already in the list
        // at array position (indexPlusOne - 1).
        if (_contractIndexPlusOne[artist][key] != 0) {
            revert ContractAlreadyRegistered();
        }
        _artistContracts[artist].push(contractAddress);
        // After push, the new entry is at `length - 1`. Store `length`
        // (index + 1) directly; equivalent and avoids a subtraction.
        _contractIndexPlusOne[artist][key] = _artistContracts[artist].length;
        emit ContractAdded(artist, msg.sender, contractAddress);
    }

    /// @dev Remove a contract pointer via swap-and-pop. When the removed
    ///      entry is not the last one, the last entry is moved into the
    ///      removed slot and its index-plus-one value is rewritten.
    ///      Emits `ContractRemoved`.
    function _removeContract(
        address artist,
        address contractAddress
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getContractKey(contractAddress);
        // Step 1: look up the stored position (one-indexed).
        uint256 indexPlusOne = _contractIndexPlusOne[artist][key];
        if (indexPlusOne == 0) revert ContractNotRegistered();

        // Step 2: convert to the array index.
        uint256 index = indexPlusOne - 1;
        address[] storage list = _artistContracts[artist];
        uint256 lastIndex = list.length - 1;

        // Step 3: when removing from the middle, move the last entry
        // into the freed slot and rewrite its index-plus-one value.
        // Skipping this branch when the removed entry is the last one
        // saves an SSTORE on stack-like removal.
        if (index != lastIndex) {
            address moved = list[lastIndex];
            list[index] = moved;
            bytes32 movedKey = getContractKey(moved);
            _contractIndexPlusOne[artist][movedKey] = index + 1;
        }

        // Step 4: shrink the array and clear the removed entry's
        // index-plus-one value. The two SSTOREs are independent; order
        // does not affect correctness.
        list.pop();
        delete _contractIndexPlusOne[artist][key];
        emit ContractRemoved(artist, msg.sender, contractAddress);
    }

    /// @notice Check whether `artist` has registered a contract pointer
    ///         matching `contractAddress`.
    /// @param artist           Artist whose catalog is being queried.
    /// @param contractAddress  Contract being queried.
    /// @return                 True iff the pointer exists.
    function isContractRegistered(
        address artist,
        address contractAddress
    ) external view returns (bool) {
        return _contractIndexPlusOne[artist][getContractKey(contractAddress)] != 0;
    }

    /// @notice Return every contract pointer in `artist`'s catalog.
    /// @dev    Order is not guaranteed. For very large records prefer
    ///         `getContractsSlice` to avoid pulling the entire list.
    /// @param artist  Artist whose catalog is being read.
    /// @return        Array of contract addresses.
    function getContracts(
        address artist
    ) external view returns (address[] memory) {
        return _artistContracts[artist];
    }

    /// @notice Number of contract pointers in `artist`'s catalog.
    /// @param artist  Artist whose catalog is being read.
    /// @return        Count of pointers.
    function getContractCount(
        address artist
    ) external view returns (uint256) {
        return _artistContracts[artist].length;
    }

    /// @notice Indexed access to a single contract pointer.
    /// @dev    Reverts on out-of-bounds index (default array revert).
    /// @param artist  Artist whose catalog is being read.
    /// @param index   Position in the unordered list.
    /// @return        Contract address of the pointer at `index`.
    function getContractAt(
        address artist,
        uint256 index
    ) external view returns (address) {
        return _artistContracts[artist][index];
    }

    /// @notice Slice access for paginated reads. Returns up to `count`
    ///         contracts starting at `start`. Tolerates out-of-range
    ///         requests:
    ///           - if `start >= length`, returns an empty array
    ///           - if `start + count > length`, returns only the
    ///             remaining elements
    /// @dev    Lets frontends and indexers read large records without a
    ///         full-array copy.
    /// @param artist  Artist whose catalog is being read.
    /// @param start   Zero-based offset into the unordered list.
    /// @param count   Maximum number of items to return.
    /// @return        Up to `count` contract addresses starting at `start`.
    function getContractsSlice(
        address artist,
        uint256 start,
        uint256 count
    ) external view returns (address[] memory) {
        address[] storage list = _artistContracts[artist];
        return _sliceAddresses(list, start, count);
    }

    /// @dev Slice helper for the address array (contract pointers). The
    ///      struct lists inline their own copy because Solidity cannot
    ///      generically copy storage to memory across different value
    ///      types.
    function _sliceAddresses(
        address[] storage list,
        uint256 start,
        uint256 count
    ) private view returns (address[] memory) {
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

    // ─── Token pointers ─────────────────────────────────────────────

    /// @notice Add a single-token pointer to the caller's catalog.
    /// @param contractAddress  Contract that holds the token. Must be non-zero.
    /// @param tokenId          Token id being pointed at.
    function addToken(
        address contractAddress,
        uint256 tokenId
    ) external {
        _addToken(msg.sender, contractAddress, tokenId);
    }

    /// @notice Add a single-token pointer to `artist`'s catalog on its
    ///         behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose catalog is being updated.
    /// @param contractAddress  Contract that holds the token. Must be non-zero.
    /// @param tokenId          Token id being pointed at.
    function addTokenFor(
        address artist,
        address contractAddress,
        uint256 tokenId
    ) external {
        _requireAuthorized(artist);
        _addToken(artist, contractAddress, tokenId);
    }

    /// @notice Remove a single-token pointer from the caller's catalog.
    /// @param contractAddress  Contract that held the token.
    /// @param tokenId          Token id to remove from the catalog.
    function removeToken(
        address contractAddress,
        uint256 tokenId
    ) external {
        _removeToken(msg.sender, contractAddress, tokenId);
    }

    /// @notice Remove a single-token pointer from `artist`'s catalog on
    ///         its behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose catalog is being updated.
    /// @param contractAddress  Contract that held the token.
    /// @param tokenId          Token id to remove from the catalog.
    function removeTokenFor(
        address artist,
        address contractAddress,
        uint256 tokenId
    ) external {
        _requireAuthorized(artist);
        _removeToken(artist, contractAddress, tokenId);
    }

    /// @dev Push a token pointer to `artist`'s list and record its
    ///      index. Emits `TokenAdded`.
    function _addToken(
        address artist,
        address contractAddress,
        uint256 tokenId
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getTokenKey(contractAddress, tokenId);
        if (_tokenIndexPlusOne[artist][key] != 0) {
            revert TokenAlreadyRegistered();
        }
        _artistTokens[artist].push(
            TokenPointer({
                contractAddress: contractAddress,
                tokenId: tokenId
            })
        );
        _tokenIndexPlusOne[artist][key] = _artistTokens[artist].length;
        emit TokenAdded(artist, msg.sender, contractAddress, tokenId);
    }

    /// @dev Remove a token pointer via swap-and-pop. Same algorithm as
    ///      `_removeContract`; see its step comments. Emits
    ///      `TokenRemoved`.
    function _removeToken(
        address artist,
        address contractAddress,
        uint256 tokenId
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getTokenKey(contractAddress, tokenId);
        uint256 indexPlusOne = _tokenIndexPlusOne[artist][key];
        if (indexPlusOne == 0) revert TokenNotRegistered();

        uint256 index = indexPlusOne - 1;
        TokenPointer[] storage list = _artistTokens[artist];
        uint256 lastIndex = list.length - 1;

        if (index != lastIndex) {
            TokenPointer memory moved = list[lastIndex];
            list[index] = moved;
            bytes32 movedKey = getTokenKey(
                moved.contractAddress,
                moved.tokenId
            );
            _tokenIndexPlusOne[artist][movedKey] = index + 1;
        }

        list.pop();
        delete _tokenIndexPlusOne[artist][key];
        emit TokenRemoved(artist, msg.sender, contractAddress, tokenId);
    }

    /// @notice Check whether `artist` has registered a single-token
    ///         pointer matching `(contractAddress, tokenId)`.
    /// @param artist           Artist whose catalog is being queried.
    /// @param contractAddress  Contract being queried.
    /// @param tokenId          Token id being queried.
    /// @return                 True iff the pointer exists.
    function isTokenRegistered(
        address artist,
        address contractAddress,
        uint256 tokenId
    ) external view returns (bool) {
        return _tokenIndexPlusOne[artist][
            getTokenKey(contractAddress, tokenId)
        ] != 0;
    }

    /// @notice Return every single-token pointer in `artist`'s catalog.
    /// @dev    Order is not guaranteed. For very large records prefer
    ///         `getTokensSlice` to avoid pulling the entire list.
    /// @param artist  Artist whose catalog is being read.
    /// @return        Array of `TokenPointer` structs.
    function getTokens(
        address artist
    ) external view returns (TokenPointer[] memory) {
        return _artistTokens[artist];
    }

    /// @notice Number of single-token pointers in `artist`'s catalog.
    /// @param artist  Artist whose catalog is being read.
    /// @return        Count of pointers.
    function getTokenCount(
        address artist
    ) external view returns (uint256) {
        return _artistTokens[artist].length;
    }

    /// @notice Indexed access to a single token pointer.
    /// @dev    Reverts on out-of-bounds index (default array revert).
    /// @param artist           Artist whose catalog is being read.
    /// @param index            Position in the unordered list.
    /// @return contractAddress Contract address of the pointer at `index`.
    /// @return tokenId         Token id of the pointer at `index`.
    function getTokenAt(
        address artist,
        uint256 index
    ) external view returns (
        address contractAddress,
        uint256 tokenId
    ) {
        TokenPointer memory p = _artistTokens[artist][index];
        return (p.contractAddress, p.tokenId);
    }

    /// @notice Slice access for paginated reads. See
    ///         `getContractsSlice` for the out-of-range semantics.
    /// @param artist  Artist whose catalog is being read.
    /// @param start   Zero-based offset into the unordered list.
    /// @param count   Maximum number of items to return.
    /// @return        Up to `count` token pointers starting at `start`.
    function getTokensSlice(
        address artist,
        uint256 start,
        uint256 count
    ) external view returns (TokenPointer[] memory) {
        TokenPointer[] storage list = _artistTokens[artist];
        uint256 len = list.length;
        if (start >= len) return new TokenPointer[](0);
        uint256 available = len - start;
        uint256 take = count < available ? count : available;
        TokenPointer[] memory result = new TokenPointer[](take);
        for (uint256 i = 0; i < take; ++i) {
            result[i] = list[start + i];
        }
        return result;
    }

    // ─── Token range pointers ───────────────────────────────────────

    /// @notice Add a token-range pointer to the caller's catalog.
    /// @dev    Overlapping ranges are allowed; identity is the exact
    ///         `(contract, start, end)` tuple. Single-token ranges
    ///         (`start == end`) are valid.
    /// @param contractAddress  Contract that holds the tokens. Must be non-zero.
    /// @param startTokenId     Inclusive lower bound. Must be <= endTokenId.
    /// @param endTokenId       Inclusive upper bound.
    function addTokenRange(
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _addTokenRange(msg.sender, contractAddress, startTokenId, endTokenId);
    }

    /// @notice Add a token-range pointer to `artist`'s catalog on its
    ///         behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose catalog is being updated.
    /// @param contractAddress  Contract that holds the tokens. Must be non-zero.
    /// @param startTokenId     Inclusive lower bound. Must be <= endTokenId.
    /// @param endTokenId       Inclusive upper bound.
    function addTokenRangeFor(
        address artist,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _requireAuthorized(artist);
        _addTokenRange(artist, contractAddress, startTokenId, endTokenId);
    }

    /// @notice Remove a token-range pointer from the caller's catalog.
    /// @param contractAddress  Contract that held the tokens.
    /// @param startTokenId     Inclusive lower bound that was added.
    /// @param endTokenId       Inclusive upper bound that was added.
    function removeTokenRange(
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _removeTokenRange(msg.sender, contractAddress, startTokenId, endTokenId);
    }

    /// @notice Remove a token-range pointer from `artist`'s catalog on
    ///         its behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose catalog is being updated.
    /// @param contractAddress  Contract that held the tokens.
    /// @param startTokenId     Inclusive lower bound that was added.
    /// @param endTokenId       Inclusive upper bound that was added.
    function removeTokenRangeFor(
        address artist,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _requireAuthorized(artist);
        _removeTokenRange(artist, contractAddress, startTokenId, endTokenId);
    }

    /// @dev Push a token-range pointer to `artist`'s list and record its
    ///      index. Reverts on inverted range. Emits `TokenRangeAdded`.
    function _addTokenRange(
        address artist,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        if (startTokenId > endTokenId) revert InvalidTokenRange();
        bytes32 key = getTokenRangeKey(
            contractAddress,
            startTokenId,
            endTokenId
        );
        if (_tokenRangeIndexPlusOne[artist][key] != 0) {
            revert TokenRangeAlreadyRegistered();
        }
        _artistTokenRanges[artist].push(
            TokenRangePointer({
                contractAddress: contractAddress,
                startTokenId: startTokenId,
                endTokenId: endTokenId
            })
        );
        _tokenRangeIndexPlusOne[artist][key] = _artistTokenRanges[artist].length;
        emit TokenRangeAdded(
            artist,
            msg.sender,
            contractAddress,
            startTokenId,
            endTokenId
        );
    }

    /// @dev Remove a token-range pointer via swap-and-pop. Same
    ///      algorithm as `_removeContract`; see its step comments.
    ///      Emits `TokenRangeRemoved`.
    ///
    ///      Reverts on inverted range (`start > end`) for symmetry with
    ///      `_addTokenRange`: a tuple that can never be added can never
    ///      be removed either, and rejecting it early returns
    ///      `InvalidTokenRange` rather than `TokenRangeNotRegistered`.
    function _removeTokenRange(
        address artist,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        if (startTokenId > endTokenId) revert InvalidTokenRange();
        bytes32 key = getTokenRangeKey(
            contractAddress,
            startTokenId,
            endTokenId
        );
        uint256 indexPlusOne = _tokenRangeIndexPlusOne[artist][key];
        if (indexPlusOne == 0) revert TokenRangeNotRegistered();

        uint256 index = indexPlusOne - 1;
        TokenRangePointer[] storage list = _artistTokenRanges[artist];
        uint256 lastIndex = list.length - 1;

        if (index != lastIndex) {
            TokenRangePointer memory moved = list[lastIndex];
            list[index] = moved;
            bytes32 movedKey = getTokenRangeKey(
                moved.contractAddress,
                moved.startTokenId,
                moved.endTokenId
            );
            _tokenRangeIndexPlusOne[artist][movedKey] = index + 1;
        }

        list.pop();
        delete _tokenRangeIndexPlusOne[artist][key];
        emit TokenRangeRemoved(
            artist,
            msg.sender,
            contractAddress,
            startTokenId,
            endTokenId
        );
    }

    /// @notice Check whether `artist` has registered a token-range
    ///         pointer matching the exact tuple.
    /// @dev    Identity is the exact `(contract, start, end)` tuple;
    ///         this does not report ranges that merely cover the queried
    ///         bounds. Coverage checks are performed by indexers.
    /// @param artist           Artist whose catalog is being queried.
    /// @param contractAddress  Contract being queried.
    /// @param startTokenId     Inclusive lower bound being queried.
    /// @param endTokenId       Inclusive upper bound being queried.
    /// @return                 True iff a pointer with exactly these
    ///                         bounds exists.
    function isTokenRangeRegistered(
        address artist,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external view returns (bool) {
        return _tokenRangeIndexPlusOne[artist][
            getTokenRangeKey(contractAddress, startTokenId, endTokenId)
        ] != 0;
    }

    /// @notice Return every token-range pointer in `artist`'s catalog.
    /// @dev    Order is not guaranteed. For very large records prefer
    ///         `getTokenRangesSlice` to avoid pulling the entire list.
    /// @param artist  Artist whose catalog is being read.
    /// @return        Array of `TokenRangePointer` structs.
    function getTokenRanges(
        address artist
    ) external view returns (TokenRangePointer[] memory) {
        return _artistTokenRanges[artist];
    }

    /// @notice Number of token-range pointers in `artist`'s catalog.
    /// @param artist  Artist whose catalog is being read.
    /// @return        Count of pointers.
    function getTokenRangeCount(
        address artist
    ) external view returns (uint256) {
        return _artistTokenRanges[artist].length;
    }

    /// @notice Indexed access to a single token-range pointer.
    /// @dev    Reverts on out-of-bounds index (default array revert).
    /// @param artist           Artist whose catalog is being read.
    /// @param index            Position in the unordered list.
    /// @return contractAddress Contract address of the pointer at `index`.
    /// @return startTokenId    Inclusive lower bound of the pointer at `index`.
    /// @return endTokenId      Inclusive upper bound of the pointer at `index`.
    function getTokenRangeAt(
        address artist,
        uint256 index
    ) external view returns (
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) {
        TokenRangePointer memory p = _artistTokenRanges[artist][index];
        return (p.contractAddress, p.startTokenId, p.endTokenId);
    }

    /// @notice Slice access for paginated reads. See
    ///         `getContractsSlice` for the out-of-range semantics.
    /// @param artist  Artist whose catalog is being read.
    /// @param start   Zero-based offset into the unordered list.
    /// @param count   Maximum number of items to return.
    /// @return        Up to `count` range pointers starting at `start`.
    function getTokenRangesSlice(
        address artist,
        uint256 start,
        uint256 count
    ) external view returns (TokenRangePointer[] memory) {
        TokenRangePointer[] storage list = _artistTokenRanges[artist];
        uint256 len = list.length;
        if (start >= len) return new TokenRangePointer[](0);
        uint256 available = len - start;
        uint256 take = count < available ? count : available;
        TokenRangePointer[] memory result = new TokenRangePointer[](take);
        for (uint256 i = 0; i < take; ++i) {
            result[i] = list[start + i];
        }
        return result;
    }

    // ─── Combined catalog reads ─────────────────────────────────────

    /// @notice Return every pointer in `artist`'s catalog (contracts,
    ///         single tokens, and token ranges) in a single call.
    /// @dev    Wrapper over `getContracts`, `getTokens`, and
    ///         `getTokenRanges`: one `eth_call` returns all three lists
    ///         instead of three round-trips, with the same data and
    ///         shapes. Consumers that need only one or two lists should
    ///         call the per-type getters to avoid copying unneeded
    ///         storage.
    ///
    ///         All caveats from the per-type getters apply:
    ///           - Order is not stable across reads (swap-and-pop
    ///             removal). Sort client-side if a stable ordering is
    ///             required.
    ///           - For very large catalogs, gas cost grows linearly
    ///             across all three lists combined and the response may
    ///             approach or exceed RPC return-size limits. For a
    ///             known-large catalog, prefer the `*Slice` getters and
    ///             paginate per type.
    ///           - The arrays are independent; a token registered both
    ///             as `addToken(c, id)` and `addTokenRange(c, id, id)`
    ///             appears in both `tokens` and `tokenRanges`. Pointer
    ///             types are distinct sets, not a single deduplicated
    ///             collection.
    ///
    ///         Reverts: none. `artist = address(0)` or any address with
    ///         no entries returns three empty arrays.
    /// @param  artist           Artist whose catalog is being read.
    /// @return contracts        Array of contract pointers.
    /// @return tokens           Array of single-token pointers.
    /// @return tokenRanges      Array of token-range pointers.
    function getCatalogOf(
        address artist
    ) external view returns (
        address[] memory contracts,
        TokenPointer[] memory tokens,
        TokenRangePointer[] memory tokenRanges
    ) {
        return (
            _artistContracts[artist],
            _artistTokens[artist],
            _artistTokenRanges[artist]
        );
    }

    /// @notice Return the size of `artist`'s catalog across all three
    ///         pointer types in a single call.
    /// @dev    Cheaper than `getCatalogOf` when the caller only needs
    ///         each list's length, e.g. a summary header, an empty-state
    ///         check, or a paginating UI deciding how many `*Slice`
    ///         pages to fetch.
    ///
    ///         Reverts: none. An address with no entries returns
    ///         `(0, 0, 0)`.
    /// @param  artist           Artist whose catalog is being measured.
    /// @return contracts        Number of contract pointers.
    /// @return tokens           Number of single-token pointers.
    /// @return tokenRanges      Number of token-range pointers.
    function getCatalogCountsOf(
        address artist
    ) external view returns (
        uint256 contracts,
        uint256 tokens,
        uint256 tokenRanges
    ) {
        return (
            _artistContracts[artist].length,
            _artistTokens[artist].length,
            _artistTokenRanges[artist].length
        );
    }

    // ─── Operator delegation ────────────────────────────────────────

    /// @notice Approve or revoke an operator for the caller. The
    ///         operator may then call any `*For` pointer function on
    ///         the caller's behalf.
    /// @dev    Always emits `OperatorSet`, including when the new value
    ///         equals the existing value, for a uniform audit trail.
    ///         Only the artist itself may call; operators cannot
    ///         sub-delegate (calling `setOperator` from an operator
    ///         address sets that operator's own slot, not the
    ///         artist's).
    /// @param operator  Address being approved or revoked. Must be
    ///                  non-zero.
    /// @param approved  New value for `isOperator[msg.sender][operator]`.
    function setOperator(address operator, bool approved) external {
        if (operator == address(0)) revert InvalidOperator();
        // Scope is enforced by the `msg.sender` key: there is no
        // `setOperatorFor(artist, ...)`, so a caller can only mutate its
        // own operator slot. An operator invoking this function sets its
        // own operators, not the artist's.
        isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
    }
}
