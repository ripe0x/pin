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

    struct ContractPointer {
        uint256 chainId;
        address contractAddress;
    }

    struct TokenPointer {
        uint256 chainId;
        address contractAddress;
        uint256 tokenId;
    }

    struct TokenRangePointer {
        uint256 chainId;
        address contractAddress;
        uint256 startTokenId;
        uint256 endTokenId;
    }

    // ─── Storage ────────────────────────────────────────────────────

    // Per-artist enumerable lists. Order is not guaranteed — `swap and
    // pop` removal swaps the last element into the removed slot.
    mapping(address => ContractPointer[]) private _artistContracts;
    mapping(address => TokenPointer[]) private _artistTokens;
    mapping(address => TokenRangePointer[]) private _artistTokenRanges;

    // index-plus-one mappings for O(1) existence checks + swap-and-pop.
    // Zero means "not present"; (index + 1) means "present at array[index]".
    mapping(address => mapping(bytes32 => uint256)) private _contractIndexPlusOne;
    mapping(address => mapping(bytes32 => uint256)) private _tokenIndexPlusOne;
    mapping(address => mapping(bytes32 => uint256)) private _tokenRangeIndexPlusOne;

    // Operator delegation. `isOperator[artist][operator]` is true iff
    // the artist has approved that operator to add/remove pointers on
    // its behalf. Operators cannot themselves approve operators or
    // declare successors.
    mapping(address => mapping(address => bool)) public isOperator;

    // One-way append-only successor pointer. An artist may declare
    // exactly one successor address while its key is healthy; the
    // pointer cannot be changed under that address afterwards. The
    // successor may extend the chain further by declaring its own
    // successor. Downstream indexers walk the forward chain to
    // reconstruct the artist's full record across migrations.
    //
    // This solves planned migrations (key rotation, wallet retirement,
    // splitting personal from studio). It does NOT solve lost keys —
    // that's a wallet-security problem unsolvable at this layer. Set
    // a successor early, while your key is healthy.
    mapping(address => address) private _successor;

    // ─── Events ─────────────────────────────────────────────────────

    event ContractAdded(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress
    );
    event ContractRemoved(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress
    );

    event TokenAdded(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 tokenId
    );
    event TokenRemoved(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 tokenId
    );

    event TokenRangeAdded(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    );
    event TokenRangeRemoved(
        address indexed artist,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    );

    event OperatorSet(
        address indexed artist,
        address indexed operator,
        bool approved
    );

    event SuccessorSet(
        address indexed artist,
        address indexed successor
    );

    // ─── Errors ─────────────────────────────────────────────────────

    error NotAuthorized();
    error InvalidArtist();
    error InvalidContractAddress();
    error InvalidOperator();
    error InvalidTokenRange();
    error InvalidSuccessor();

    error ContractAlreadyRegistered();
    error ContractNotRegistered();
    error TokenAlreadyRegistered();
    error TokenNotRegistered();
    error TokenRangeAlreadyRegistered();
    error TokenRangeNotRegistered();

    error SuccessorAlreadySet();

    // ─── Internal: authorization ────────────────────────────────────

    function _requireAuthorized(address artist) internal view {
        if (artist == address(0)) revert InvalidArtist();
        if (msg.sender != artist && !isOperator[artist][msg.sender]) {
            revert NotAuthorized();
        }
    }

    // ─── Key helpers ────────────────────────────────────────────────

    function getContractKey(
        uint256 chainId,
        address contractAddress
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, contractAddress));
    }

    function getTokenKey(
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, contractAddress, tokenId));
    }

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

    function addContract(uint256 chainId, address contractAddress) external {
        _addContract(msg.sender, chainId, contractAddress);
    }

    function addContractFor(
        address artist,
        uint256 chainId,
        address contractAddress
    ) external {
        _requireAuthorized(artist);
        _addContract(artist, chainId, contractAddress);
    }

    function removeContract(uint256 chainId, address contractAddress) external {
        _removeContract(msg.sender, chainId, contractAddress);
    }

    function removeContractFor(
        address artist,
        uint256 chainId,
        address contractAddress
    ) external {
        _requireAuthorized(artist);
        _removeContract(artist, chainId, contractAddress);
    }

    function _addContract(
        address artist,
        uint256 chainId,
        address contractAddress
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getContractKey(chainId, contractAddress);
        if (_contractIndexPlusOne[artist][key] != 0) {
            revert ContractAlreadyRegistered();
        }
        _artistContracts[artist].push(
            ContractPointer({chainId: chainId, contractAddress: contractAddress})
        );
        _contractIndexPlusOne[artist][key] = _artistContracts[artist].length;
        emit ContractAdded(artist, chainId, contractAddress);
    }

    function _removeContract(
        address artist,
        uint256 chainId,
        address contractAddress
    ) internal {
        if (contractAddress == address(0)) revert InvalidContractAddress();
        bytes32 key = getContractKey(chainId, contractAddress);
        uint256 indexPlusOne = _contractIndexPlusOne[artist][key];
        if (indexPlusOne == 0) revert ContractNotRegistered();

        uint256 index = indexPlusOne - 1;
        ContractPointer[] storage list = _artistContracts[artist];
        uint256 lastIndex = list.length - 1;

        if (index != lastIndex) {
            ContractPointer memory moved = list[lastIndex];
            list[index] = moved;
            bytes32 movedKey = getContractKey(moved.chainId, moved.contractAddress);
            _contractIndexPlusOne[artist][movedKey] = index + 1;
        }

        list.pop();
        delete _contractIndexPlusOne[artist][key];
        emit ContractRemoved(artist, chainId, contractAddress);
    }

    function isContractRegistered(
        address artist,
        uint256 chainId,
        address contractAddress
    ) external view returns (bool) {
        return _contractIndexPlusOne[artist][getContractKey(chainId, contractAddress)] != 0;
    }

    function getContracts(
        address artist
    ) external view returns (ContractPointer[] memory) {
        return _artistContracts[artist];
    }

    function getContractCount(
        address artist
    ) external view returns (uint256) {
        return _artistContracts[artist].length;
    }

    function getContractAt(
        address artist,
        uint256 index
    ) external view returns (uint256 chainId, address contractAddress) {
        ContractPointer memory p = _artistContracts[artist][index];
        return (p.chainId, p.contractAddress);
    }

    // ─── Token pointers ─────────────────────────────────────────────

    function addToken(
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) external {
        _addToken(msg.sender, chainId, contractAddress, tokenId);
    }

    function addTokenFor(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) external {
        _requireAuthorized(artist);
        _addToken(artist, chainId, contractAddress, tokenId);
    }

    function removeToken(
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) external {
        _removeToken(msg.sender, chainId, contractAddress, tokenId);
    }

    function removeTokenFor(
        address artist,
        uint256 chainId,
        address contractAddress,
        uint256 tokenId
    ) external {
        _requireAuthorized(artist);
        _removeToken(artist, chainId, contractAddress, tokenId);
    }

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

    function getTokens(
        address artist
    ) external view returns (TokenPointer[] memory) {
        return _artistTokens[artist];
    }

    function getTokenCount(
        address artist
    ) external view returns (uint256) {
        return _artistTokens[artist].length;
    }

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

    function addTokenRange(
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _addTokenRange(msg.sender, chainId, contractAddress, startTokenId, endTokenId);
    }

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

    function removeTokenRange(
        uint256 chainId,
        address contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    ) external {
        _removeTokenRange(msg.sender, chainId, contractAddress, startTokenId, endTokenId);
    }

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

    function getTokenRanges(
        address artist
    ) external view returns (TokenRangePointer[] memory) {
        return _artistTokenRanges[artist];
    }

    function getTokenRangeCount(
        address artist
    ) external view returns (uint256) {
        return _artistTokenRanges[artist].length;
    }

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

    /// @notice Approve or revoke an operator for the caller.
    /// @dev Always emits `OperatorSet` even when the new value equals
    ///      the existing value — uniform audit trail downstream.
    ///      Only the artist itself may call; operators cannot
    ///      sub-delegate.
    function setOperator(address operator, bool approved) external {
        if (operator == address(0)) revert InvalidOperator();
        isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
    }

    // ─── Successor (key migration) ──────────────────────────────────

    /// @notice Declare the canonical continuation address for the caller.
    /// @dev Append-only. Once set under an address, the pointer cannot
    ///      be changed. To extend the chain further (e.g. rotate keys
    ///      again), the successor calls setSuccessor from its own
    ///      address. Indexers walk the forward chain.
    ///
    ///      Only the artist itself may call. Operators cannot succeed
    ///      an artist's identity — that's a deliberate scope limit on
    ///      the operator role.
    ///
    ///      Cycle detection is not enforced on-chain (an indexer must
    ///      handle cycles via max-depth or seen-set). The contract
    ///      only rejects the trivial self-cycle (msg.sender ==
    ///      newSuccessor).
    function setSuccessor(address newSuccessor) external {
        if (newSuccessor == address(0) || newSuccessor == msg.sender) {
            revert InvalidSuccessor();
        }
        if (_successor[msg.sender] != address(0)) {
            revert SuccessorAlreadySet();
        }
        _successor[msg.sender] = newSuccessor;
        emit SuccessorSet(msg.sender, newSuccessor);
    }

    function getSuccessor(address artist) external view returns (address) {
        return _successor[artist];
    }
}
