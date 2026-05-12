// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArtistRecordRegistry
/// @notice Generic, immutable, public infrastructure where an artist
///         address can publish on-chain pointers that belong in its
///         public artist record. A pointer is a contract address, a
///         single token, or a contiguous token range.
///
/// @dev    CORE MEANING (read carefully before consuming this contract):
///
///         The registry only means: "this artist address added this
///         pointer to its public artist record."
///
///         It does NOT prove authorship, provenance, token type,
///         authenticity, ownership, creator status, or endorsement.
///         It does NOT verify that the referenced contract or token
///         exists, behaves as an NFT, or implements any standard.
///
///         Downstream indexers and UIs are responsible for interpreting
///         pointers — checking interfaces, resolving metadata, scoring
///         confidence, surfacing conflicts. The contract stays small on
///         purpose; semantics live off-chain.
///
///         No admin, no owner, no upgrade path, no fees, no pause, no
///         protocol logic. The only privileged role is per-artist:
///         an artist may approve operators to add and remove pointers
///         on its behalf, and may declare a one-way successor address
///         that downstream indexers should follow when reconstructing
///         the artist's full record across key rotations or wallet
///         retirements.
contract ArtistRecordRegistry {
    // ─── Types ──────────────────────────────────────────────────────

    /// @notice A pointer to an entire contract on a given chain.
    /// @param chainId          EIP-155 chain identifier. Not restricted.
    /// @param contractAddress  The contract being pointed at. Must be non-zero.
    struct ContractPointer {
        uint256 chainId;
        address contractAddress;
    }

    /// @notice A pointer to a single token on a given contract.
    /// @param chainId          EIP-155 chain identifier. Not restricted.
    /// @param contractAddress  The contract that holds the token. Must be non-zero.
    /// @param tokenId          Any uint256. Not bounded.
    struct TokenPointer {
        uint256 chainId;
        address contractAddress;
        uint256 tokenId;
    }

    /// @notice A pointer to a contiguous, inclusive range of token IDs on
    ///         a given contract. `startTokenId == endTokenId` is allowed
    ///         and effectively represents a single-token pointer.
    /// @param chainId          EIP-155 chain identifier. Not restricted.
    /// @param contractAddress  The contract that holds the tokens. Must be non-zero.
    /// @param startTokenId     Inclusive lower bound. Must be <= endTokenId.
    /// @param endTokenId       Inclusive upper bound.
    struct TokenRangePointer {
        uint256 chainId;
        address contractAddress;
        uint256 startTokenId;
        uint256 endTokenId;
    }

    // ─── Storage ────────────────────────────────────────────────────

    /// @dev Per-artist enumerable list of contract pointers. Order is
    ///      not guaranteed — `swap and pop` removal swaps the last
    ///      element into the removed slot.
    mapping(address => ContractPointer[]) private _artistContracts;

    /// @dev Per-artist enumerable list of single-token pointers.
    mapping(address => TokenPointer[]) private _artistTokens;

    /// @dev Per-artist enumerable list of token-range pointers.
    mapping(address => TokenRangePointer[]) private _artistTokenRanges;

    /// @dev index-plus-one map for O(1) contract-pointer existence
    ///      checks + swap-and-pop. Zero means "not present"; a value
    ///      of (index + 1) means "present at _artistContracts[index]".
    //
    // Why "+1" instead of storing the raw index: Solidity's default for
    // an unread map entry is zero. If we stored raw indices, "missing"
    // and "present at slot 0" would both read as zero, breaking the
    // existence check. Shifting by one preserves a unique sentinel for
    // "missing" without paying the gas of a parallel boolean map.
    mapping(address => mapping(bytes32 => uint256)) private _contractIndexPlusOne;

    /// @dev index-plus-one map for token pointers. See _contractIndexPlusOne.
    mapping(address => mapping(bytes32 => uint256)) private _tokenIndexPlusOne;

    /// @dev index-plus-one map for token-range pointers. See _contractIndexPlusOne.
    mapping(address => mapping(bytes32 => uint256)) private _tokenRangeIndexPlusOne;

    /// @notice `isOperator[artist][operator]` is true iff `artist` has
    ///         approved `operator` to add and remove pointers on its
    ///         behalf via the `*For` functions.
    /// @dev    Operators cannot sub-delegate (cannot call setOperator
    ///         for another artist) and cannot set a successor (that
    ///         function is scoped to the caller's own slot).
    //
    // `public` auto-generates an external `isOperator(address, address)
    // returns (bool)` getter, which is the public read surface — no
    // separate `function isOperator(...)` is needed.
    mapping(address => mapping(address => bool)) public isOperator;

    /// @dev One-way, append-only successor pointer. An artist may
    ///      declare exactly one successor address while its key is
    ///      healthy; the pointer cannot be changed under that address
    ///      afterwards. The successor may extend the chain further by
    ///      declaring its own successor. Downstream indexers walk the
    ///      forward chain to reconstruct the artist's full record
    ///      across migrations.
    ///
    ///      This solves planned migrations (key rotation, wallet
    ///      retirement, splitting personal from studio). It does NOT
    ///      solve lost keys — that's a wallet-security problem
    ///      unsolvable at this layer. Set a successor early, while
    ///      your key is healthy.
    mapping(address => address) private _successor;

    // ─── Events ─────────────────────────────────────────────────────

    /// @notice Emitted when an artist adds a contract pointer.
    /// @param artist           The artist whose record was modified.
    /// @param chainId          The chain the pointer references.
    /// @param contractAddress  The contract address pointed at.
    event ContractAdded(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress
    );

    /// @notice Emitted when an artist removes a contract pointer.
    /// @param artist           The artist whose record was modified.
    /// @param chainId          The chain the pointer referenced.
    /// @param contractAddress  The contract address that was removed.
    event ContractRemoved(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress
    );

    /// @notice Emitted when an artist adds a single-token pointer.
    /// @param artist           The artist whose record was modified.
    /// @param chainId          The chain the pointer references.
    /// @param contractAddress  The contract that holds the token.
    /// @param tokenId          The specific token being pointed at.
    event TokenAdded(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 tokenId
    );

    /// @notice Emitted when an artist removes a single-token pointer.
    /// @param artist           The artist whose record was modified.
    /// @param chainId          The chain the pointer referenced.
    /// @param contractAddress  The contract that held the token.
    /// @param tokenId          The token id that was removed.
    event TokenRemoved(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 tokenId
    );

    /// @notice Emitted when an artist adds a token-range pointer.
    /// @param artist           The artist whose record was modified.
    /// @param chainId          The chain the pointer references.
    /// @param contractAddress  The contract that holds the tokens.
    /// @param startTokenId     Inclusive lower bound of the range.
    /// @param endTokenId       Inclusive upper bound of the range.
    event TokenRangeAdded(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    );

    /// @notice Emitted when an artist removes a token-range pointer.
    /// @param artist           The artist whose record was modified.
    /// @param chainId          The chain the pointer referenced.
    /// @param contractAddress  The contract that held the tokens.
    /// @param startTokenId     Inclusive lower bound that was removed.
    /// @param endTokenId       Inclusive upper bound that was removed.
    event TokenRangeRemoved(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    );

    /// @notice Emitted whenever `setOperator` is called. Emitted even
    ///         when the new value equals the existing value, so a
    ///         downstream consumer can rely on a uniform audit trail.
    /// @param artist    The artist whose operator slot was set.
    /// @param operator  The address being approved or revoked.
    /// @param approved  New value of `isOperator[artist][operator]`.
    event OperatorSet(
        address indexed artist,
        address indexed operator,
        bool approved
    );

    /// @notice Emitted when an artist declares a successor. Emitted at
    ///         most once per artist address (the successor pointer is
    ///         append-only).
    /// @param artist     The address declaring the successor.
    /// @param successor  The canonical continuation address.
    event SuccessorSet(
        address indexed artist,
        address indexed successor
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

    /// @notice Token range had `startTokenId > endTokenId`.
    error InvalidTokenRange();

    /// @notice Successor argument to `setSuccessor` was the zero
    ///         address or equal to `msg.sender` (trivial self-cycle).
    error InvalidSuccessor();

    /// @notice Attempted to add a contract pointer that already exists
    ///         in this artist's record.
    error ContractAlreadyRegistered();

    /// @notice Attempted to remove a contract pointer that doesn't
    ///         exist in this artist's record.
    error ContractNotRegistered();

    /// @notice Attempted to add a token pointer that already exists in
    ///         this artist's record.
    error TokenAlreadyRegistered();

    /// @notice Attempted to remove a token pointer that doesn't exist
    ///         in this artist's record.
    error TokenNotRegistered();

    /// @notice Attempted to add a token-range pointer that already
    ///         exists in this artist's record. (Identity is the exact
    ///         (chainId, contract, start, end) tuple; overlapping
    ///         ranges with different bounds are independent entries.)
    error TokenRangeAlreadyRegistered();

    /// @notice Attempted to remove a token-range pointer that doesn't
    ///         exist in this artist's record.
    error TokenRangeNotRegistered();

    /// @notice Attempted to set a successor on an address that already
    ///         has one. The successor pointer is append-only; extend
    ///         the chain by calling `setSuccessor` from the successor
    ///         itself.
    error SuccessorAlreadySet();

    // ─── Internal: authorization ────────────────────────────────────

    /// @dev Reverts when `msg.sender` is not authorized to mutate the
    ///      pointer storage for `artist`. Authorized callers are the
    ///      artist itself and any address it has approved as an
    ///      operator.
    /// @param artist  Artist whose storage is being targeted.
    function _requireAuthorized(address artist) internal view {
        // Validate the artist param first so a caller passing
        // address(0) gets a precise `InvalidArtist` error instead of a
        // generic `NotAuthorized`. Useful for clients debugging bad
        // input.
        if (artist == address(0)) revert InvalidArtist();
        if (msg.sender != artist && !isOperator[artist][msg.sender]) {
            revert NotAuthorized();
        }
    }

    // ─── Key helpers ────────────────────────────────────────────────

    /// @notice Compute the deterministic key used internally for
    ///         contract-pointer existence checks.
    /// @dev    `keccak256(abi.encode(chainId, contractAddress))`.
    ///
    ///         We use `abi.encode` (32-byte-aligned) rather than
    ///         `abi.encodePacked` so the key for a contract pointer
    ///         cannot collide with the key for any other pointer type
    ///         even when their packed bytes would coincide. The key
    ///         spaces are also kept separate by living in distinct
    ///         mappings, but using `encode` keeps the safety property
    ///         self-contained at the hashing step.
    /// @param chainId          EIP-155 chain id.
    /// @param contractAddress  Contract address.
    /// @return                 32-byte key.
    function getContractKey(
        uint256 chainId,
        address contractAddress
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, contractAddress));
    }

    /// @notice Compute the deterministic key used internally for
    ///         single-token-pointer existence checks.
    /// @dev    `keccak256(abi.encode(chainId, contractAddress, tokenId))`.
    /// @param chainId          EIP-155 chain id.
    /// @param contractAddress  Contract address.
    /// @param tokenId          Token id.
    /// @return                 32-byte key.
    function getTokenKey(
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, contractAddress, tokenId));
    }

    /// @notice Compute the deterministic key used internally for
    ///         token-range-pointer existence checks. Identity is the
    ///         exact tuple; two ranges with different bounds are
    ///         distinct keys even if they overlap.
    /// @dev    `keccak256(abi.encode(chainId, contractAddress, start, end))`.
    /// @param chainId          EIP-155 chain id.
    /// @param contractAddress  Contract address.
    /// @param startTokenId     Inclusive lower bound.
    /// @param endTokenId       Inclusive upper bound.
    /// @return                 32-byte key.
    function getTokenRangeKey(
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(chainId, contractAddress, startTokenId, endTokenId)
        );
    }

    // ─── Contract pointers ──────────────────────────────────────────

    /// @notice Add a contract pointer to the caller's record.
    /// @dev Reverts if the pointer already exists. Anyone (including
    ///      an EOA) may be referenced — the contract performs no
    ///      semantic checks beyond non-zero.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract being pointed at. Must be non-zero.
    function addContract(uint256 chainId, address contractAddress) external {
        _addContract(msg.sender, chainId, contractAddress);
    }

    /// @notice Add a contract pointer to `artist`'s record on its
    ///         behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose record is being updated.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract being pointed at. Must be non-zero.
    function addContractFor(
        address artist,
        uint256 chainId,
        address contractAddress
    ) external {
        _requireAuthorized(artist);
        _addContract(artist, chainId, contractAddress);
    }

    /// @notice Remove a contract pointer from the caller's record.
    /// @dev Reverts if the pointer doesn't exist.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract to remove from the record.
    function removeContract(uint256 chainId, address contractAddress) external {
        _removeContract(msg.sender, chainId, contractAddress);
    }

    /// @notice Remove a contract pointer from `artist`'s record on its
    ///         behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose record is being updated.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract to remove from the record.
    function removeContractFor(
        address artist,
        uint256 chainId,
        address contractAddress
    ) external {
        _requireAuthorized(artist);
        _removeContract(artist, chainId, contractAddress);
    }

    /// @dev Push a contract pointer to `artist`'s list and record its
    ///      index. Emits `ContractAdded`.
    function _addContract(
        address artist,
        uint256 chainId,
        address contractAddress
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getContractKey(chainId, contractAddress);
        // A non-zero indexPlusOne means the pointer is already in the
        // list at array position (indexPlusOne - 1).
        if (_contractIndexPlusOne[artist][key] != 0) {
            revert ContractAlreadyRegistered();
        }
        _artistContracts[artist].push(
            ContractPointer({chainId: chainId, contractAddress: contractAddress})
        );
        // After push, the new entry sits at `length - 1`. We store
        // `length` (i.e. index + 1) directly — equivalent and avoids
        // an extra subtraction.
        _contractIndexPlusOne[artist][key] = _artistContracts[artist].length;
        emit ContractAdded(artist, chainId, contractAddress);
    }

    /// @dev Remove a contract pointer via swap-and-pop. When the
    ///      removed entry is not the last one, the last entry is moved
    ///      into the removed slot and its index-plus-one value is
    ///      rewritten. Emits `ContractRemoved`.
    function _removeContract(
        address artist,
        uint256 chainId,
        address contractAddress
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getContractKey(chainId, contractAddress);
        // Step 1: look up the stored position (one-indexed).
        uint256 indexPlusOne = _contractIndexPlusOne[artist][key];
        if (indexPlusOne == 0) revert ContractNotRegistered();

        // Step 2: convert to the actual array index.
        uint256 index = indexPlusOne - 1;
        ContractPointer[] storage list = _artistContracts[artist];
        uint256 lastIndex = list.length - 1;

        // Step 3: if we're removing from the middle, move the last
        // entry into the gap and rewrite its position pointer.
        // Skipping this branch when the removed entry IS the last one
        // saves an SSTORE on the common case of stack-like removal.
        if (index != lastIndex) {
            ContractPointer memory moved = list[lastIndex];
            list[index] = moved;
            bytes32 movedKey = getContractKey(moved.chainId, moved.contractAddress);
            _contractIndexPlusOne[artist][movedKey] = index + 1;
        }

        // Step 4: shrink the array and clear the removed entry's
        // position pointer. Order matters for clarity but not for
        // correctness — both operations are independent SSTOREs.
        list.pop();
        delete _contractIndexPlusOne[artist][key];
        emit ContractRemoved(artist, chainId, contractAddress);
    }

    /// @notice Check whether `artist` has registered a contract pointer
    ///         matching `(chainId, contractAddress)`.
    /// @param artist           Artist whose record is being queried.
    /// @param chainId          Chain the pointer would reference.
    /// @param contractAddress  Contract being queried.
    /// @return                 True iff the pointer exists.
    function isContractRegistered(
        address artist,
        uint256 chainId,
        address contractAddress
    ) external view returns (bool) {
        return _contractIndexPlusOne[artist][getContractKey(chainId, contractAddress)] != 0;
    }

    /// @notice Return every contract pointer in `artist`'s record.
    /// @dev    Order is not guaranteed.
    /// @param artist  Artist whose record is being read.
    /// @return        Array of `ContractPointer` structs.
    function getContracts(
        address artist
    ) external view returns (ContractPointer[] memory) {
        return _artistContracts[artist];
    }

    /// @notice Number of contract pointers in `artist`'s record.
    /// @param artist  Artist whose record is being read.
    /// @return        Count of pointers.
    function getContractCount(
        address artist
    ) external view returns (uint256) {
        return _artistContracts[artist].length;
    }

    /// @notice Indexed access to a single contract pointer.
    /// @dev    Reverts on out-of-bounds index (default array revert).
    /// @param artist           Artist whose record is being read.
    /// @param index            Position in the unordered list.
    /// @return chainId         Chain of the pointer at `index`.
    /// @return contractAddress Contract address of the pointer at `index`.
    function getContractAt(
        address artist,
        uint256 index
    ) external view returns (uint256 chainId, address contractAddress) {
        ContractPointer memory p = _artistContracts[artist][index];
        return (p.chainId, p.contractAddress);
    }

    // ─── Token pointers ─────────────────────────────────────────────

    /// @notice Add a single-token pointer to the caller's record.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract that holds the token. Must be non-zero.
    /// @param tokenId          Token id being pointed at.
    function addToken(
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) external {
        _addToken(msg.sender, chainId, contractAddress, tokenId);
    }

    /// @notice Add a single-token pointer to `artist`'s record on its
    ///         behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose record is being updated.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract that holds the token. Must be non-zero.
    /// @param tokenId          Token id being pointed at.
    function addTokenFor(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) external {
        _requireAuthorized(artist);
        _addToken(artist, chainId, contractAddress, tokenId);
    }

    /// @notice Remove a single-token pointer from the caller's record.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract that held the token.
    /// @param tokenId          Token id to remove from the record.
    function removeToken(
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) external {
        _removeToken(msg.sender, chainId, contractAddress, tokenId);
    }

    /// @notice Remove a single-token pointer from `artist`'s record on
    ///         its behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose record is being updated.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract that held the token.
    /// @param tokenId          Token id to remove from the record.
    function removeTokenFor(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) external {
        _requireAuthorized(artist);
        _removeToken(artist, chainId, contractAddress, tokenId);
    }

    /// @dev Push a token pointer to `artist`'s list and record its
    ///      index. Emits `TokenAdded`.
    function _addToken(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getTokenKey(chainId, contractAddress, tokenId);
        if (_tokenIndexPlusOne[artist][key] != 0) {
            revert TokenAlreadyRegistered();
        }
        _artistTokens[artist].push(
            TokenPointer({
                chainId: chainId,
                contractAddress: contractAddress,
                tokenId: tokenId
            })
        );
        _tokenIndexPlusOne[artist][key] = _artistTokens[artist].length;
        emit TokenAdded(artist, chainId, contractAddress, tokenId);
    }

    /// @dev Remove a token pointer via swap-and-pop. The algorithm
    ///      mirrors `_removeContract` — see those step comments for
    ///      the walk-through. Emits `TokenRemoved`.
    function _removeToken(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getTokenKey(chainId, contractAddress, tokenId);
        uint256 indexPlusOne = _tokenIndexPlusOne[artist][key];
        if (indexPlusOne == 0) revert TokenNotRegistered();

        uint256 index = indexPlusOne - 1;
        TokenPointer[] storage list = _artistTokens[artist];
        uint256 lastIndex = list.length - 1;

        if (index != lastIndex) {
            TokenPointer memory moved = list[lastIndex];
            list[index] = moved;
            bytes32 movedKey = getTokenKey(
                moved.chainId,
                moved.contractAddress,
                moved.tokenId
            );
            _tokenIndexPlusOne[artist][movedKey] = index + 1;
        }

        list.pop();
        delete _tokenIndexPlusOne[artist][key];
        emit TokenRemoved(artist, chainId, contractAddress, tokenId);
    }

    /// @notice Check whether `artist` has registered a single-token
    ///         pointer matching `(chainId, contractAddress, tokenId)`.
    /// @param artist           Artist whose record is being queried.
    /// @param chainId          Chain the pointer would reference.
    /// @param contractAddress  Contract being queried.
    /// @param tokenId          Token id being queried.
    /// @return                 True iff the pointer exists.
    function isTokenRegistered(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) external view returns (bool) {
        return _tokenIndexPlusOne[artist][
            getTokenKey(chainId, contractAddress, tokenId)
        ] != 0;
    }

    /// @notice Return every single-token pointer in `artist`'s record.
    /// @dev    Order is not guaranteed.
    /// @param artist  Artist whose record is being read.
    /// @return        Array of `TokenPointer` structs.
    function getTokens(
        address artist
    ) external view returns (TokenPointer[] memory) {
        return _artistTokens[artist];
    }

    /// @notice Number of single-token pointers in `artist`'s record.
    /// @param artist  Artist whose record is being read.
    /// @return        Count of pointers.
    function getTokenCount(
        address artist
    ) external view returns (uint256) {
        return _artistTokens[artist].length;
    }

    /// @notice Indexed access to a single token pointer.
    /// @dev    Reverts on out-of-bounds index (default array revert).
    /// @param artist           Artist whose record is being read.
    /// @param index            Position in the unordered list.
    /// @return chainId         Chain of the pointer at `index`.
    /// @return contractAddress Contract address of the pointer at `index`.
    /// @return tokenId         Token id of the pointer at `index`.
    function getTokenAt(
        address artist,
        uint256 index
    ) external view returns (
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) {
        TokenPointer memory p = _artistTokens[artist][index];
        return (p.chainId, p.contractAddress, p.tokenId);
    }

    // ─── Token range pointers ───────────────────────────────────────

    /// @notice Add a token-range pointer to the caller's record.
    /// @dev    Overlapping ranges are allowed; identity is the exact
    ///         `(chainId, contract, start, end)` tuple. Single-token
    ///         ranges (`start == end`) are valid.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract that holds the tokens. Must be non-zero.
    /// @param startTokenId     Inclusive lower bound. Must be <= endTokenId.
    /// @param endTokenId       Inclusive upper bound.
    function addTokenRange(
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _addTokenRange(msg.sender, chainId, contractAddress, startTokenId, endTokenId);
    }

    /// @notice Add a token-range pointer to `artist`'s record on its
    ///         behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose record is being updated.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract that holds the tokens. Must be non-zero.
    /// @param startTokenId     Inclusive lower bound. Must be <= endTokenId.
    /// @param endTokenId       Inclusive upper bound.
    function addTokenRangeFor(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _requireAuthorized(artist);
        _addTokenRange(artist, chainId, contractAddress, startTokenId, endTokenId);
    }

    /// @notice Remove a token-range pointer from the caller's record.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract that held the tokens.
    /// @param startTokenId     Inclusive lower bound that was added.
    /// @param endTokenId       Inclusive upper bound that was added.
    function removeTokenRange(
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _removeTokenRange(msg.sender, chainId, contractAddress, startTokenId, endTokenId);
    }

    /// @notice Remove a token-range pointer from `artist`'s record on
    ///         its behalf. Caller must be the artist or an approved
    ///         operator.
    /// @param artist           Artist whose record is being updated.
    /// @param chainId          Chain the pointer references.
    /// @param contractAddress  Contract that held the tokens.
    /// @param startTokenId     Inclusive lower bound that was added.
    /// @param endTokenId       Inclusive upper bound that was added.
    function removeTokenRangeFor(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _requireAuthorized(artist);
        _removeTokenRange(artist, chainId, contractAddress, startTokenId, endTokenId);
    }

    /// @dev Push a token-range pointer to `artist`'s list and record
    ///      its index. Reverts on inverted range. Emits `TokenRangeAdded`.
    function _addTokenRange(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        if (startTokenId > endTokenId) revert InvalidTokenRange();
        bytes32 key = getTokenRangeKey(
            chainId,
            contractAddress,
            startTokenId,
            endTokenId
        );
        if (_tokenRangeIndexPlusOne[artist][key] != 0) {
            revert TokenRangeAlreadyRegistered();
        }
        _artistTokenRanges[artist].push(
            TokenRangePointer({
                chainId: chainId,
                contractAddress: contractAddress,
                startTokenId: startTokenId,
                endTokenId: endTokenId
            })
        );
        _tokenRangeIndexPlusOne[artist][key] = _artistTokenRanges[artist].length;
        emit TokenRangeAdded(
            artist,
            chainId,
            contractAddress,
            startTokenId,
            endTokenId
        );
    }

    /// @dev Remove a token-range pointer via swap-and-pop. The
    ///      algorithm mirrors `_removeContract` — see those step
    ///      comments for the walk-through. Emits `TokenRangeRemoved`.
    function _removeTokenRange(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getTokenRangeKey(
            chainId,
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
                moved.chainId,
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
            chainId,
            contractAddress,
            startTokenId,
            endTokenId
        );
    }

    /// @notice Check whether `artist` has registered a token-range
    ///         pointer matching the exact tuple.
    /// @dev    Identity is the exact `(chainId, contract, start, end)`
    ///         tuple; this does NOT report ranges that merely cover
    ///         the queried bounds. Coverage logic belongs in indexers.
    /// @param artist           Artist whose record is being queried.
    /// @param chainId          Chain the pointer would reference.
    /// @param contractAddress  Contract being queried.
    /// @param startTokenId     Inclusive lower bound being queried.
    /// @param endTokenId       Inclusive upper bound being queried.
    /// @return                 True iff a pointer with exactly these
    ///                         bounds exists.
    function isTokenRangeRegistered(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external view returns (bool) {
        return _tokenRangeIndexPlusOne[artist][
            getTokenRangeKey(chainId, contractAddress, startTokenId, endTokenId)
        ] != 0;
    }

    /// @notice Return every token-range pointer in `artist`'s record.
    /// @dev    Order is not guaranteed.
    /// @param artist  Artist whose record is being read.
    /// @return        Array of `TokenRangePointer` structs.
    function getTokenRanges(
        address artist
    ) external view returns (TokenRangePointer[] memory) {
        return _artistTokenRanges[artist];
    }

    /// @notice Number of token-range pointers in `artist`'s record.
    /// @param artist  Artist whose record is being read.
    /// @return        Count of pointers.
    function getTokenRangeCount(
        address artist
    ) external view returns (uint256) {
        return _artistTokenRanges[artist].length;
    }

    /// @notice Indexed access to a single token-range pointer.
    /// @dev    Reverts on out-of-bounds index (default array revert).
    /// @param artist           Artist whose record is being read.
    /// @param index            Position in the unordered list.
    /// @return chainId         Chain of the pointer at `index`.
    /// @return contractAddress Contract address of the pointer at `index`.
    /// @return startTokenId    Inclusive lower bound of the pointer at `index`.
    /// @return endTokenId      Inclusive upper bound of the pointer at `index`.
    function getTokenRangeAt(
        address artist,
        uint256 index
    ) external view returns (
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) {
        TokenRangePointer memory p = _artistTokenRanges[artist][index];
        return (p.chainId, p.contractAddress, p.startTokenId, p.endTokenId);
    }

    // ─── Operator delegation ────────────────────────────────────────

    /// @notice Approve or revoke an operator for the caller. The
    ///         operator may then call any `*For` pointer function on
    ///         the caller's behalf.
    /// @dev    Always emits `OperatorSet` even when the new value
    ///         equals the existing value — uniform audit trail
    ///         downstream. Only the artist itself may call; operators
    ///         cannot sub-delegate (calling `setOperator` from an
    ///         operator address sets that operator's own slot, not
    ///         the artist's).
    /// @param operator  Address being approved or revoked. Must be
    ///                  non-zero.
    /// @param approved  New value for `isOperator[msg.sender][operator]`.
    function setOperator(address operator, bool approved) external {
        if (operator == address(0)) revert InvalidOperator();
        // Scope is enforced by the `msg.sender` key: there is no
        // `setOperatorFor(artist, …)`, so a caller can only mutate
        // its own operator slot. An operator invoking this function
        // sets *its own* operators, not the artist's.
        isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
    }

    // ─── Successor (key migration) ──────────────────────────────────

    /// @notice Declare the canonical continuation address for the
    ///         caller. Indexers walk the forward chain from a starting
    ///         address to aggregate the artist's full record across
    ///         migrations.
    /// @dev    Append-only. Once set under an address the pointer
    ///         cannot be changed under that address. To extend the
    ///         chain further (e.g. rotate keys again), the successor
    ///         calls `setSuccessor` from its own address.
    ///
    ///         Only the artist itself may call. Operators cannot
    ///         succeed an artist's identity — that's a deliberate
    ///         scope limit on the operator role. A compromised
    ///         operator can write nuisance pointers (removable by
    ///         the artist with its own key) but cannot permanently
    ///         take over the artist's identity.
    ///
    ///         Cycle detection is not enforced on-chain; indexers
    ///         handle cycles via max-depth or seen-set. The contract
    ///         only rejects the trivial self-cycle (msg.sender ==
    ///         newSuccessor) and zero address.
    /// @param newSuccessor  Canonical continuation address. Must be
    ///                      non-zero and not equal to msg.sender.
    function setSuccessor(address newSuccessor) external {
        if (newSuccessor == address(0) || newSuccessor == msg.sender) {
            revert InvalidSuccessor();
        }
        // Append-only: once an address has declared a successor that
        // pointer is permanent. An attacker who later compromises the
        // key cannot rewrite the chain backwards.
        if (_successor[msg.sender] != address(0)) {
            revert SuccessorAlreadySet();
        }
        // Scope mirrors `setOperator`: only `msg.sender` can write
        // its own slot. There is intentionally no `setSuccessorFor`
        // — operators must not be able to take over an artist's
        // identity.
        _successor[msg.sender] = newSuccessor;
        emit SuccessorSet(msg.sender, newSuccessor);
    }

    /// @notice Return the canonical continuation address declared by
    ///         `artist`, or the zero address if none.
    /// @dev    To follow the full forward chain, callers should call
    ///         repeatedly with the returned address until it returns
    ///         the zero address. Bound the walk with a max-depth
    ///         (cycles are not prevented on-chain).
    /// @param artist  Address whose successor is being read.
    /// @return        The declared successor address, or `address(0)`.
    function getSuccessor(address artist) external view returns (address) {
        return _successor[artist];
    }
}
