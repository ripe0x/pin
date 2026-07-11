// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionCore} from "./CollectionCore.sol";
import {ICollection} from "./interfaces/ICollection.sol";
import {ICollectionCore} from "./interfaces/ICollectionCore.sol";
import {CollectionStatus, IdMode} from "./CollectionTypes.sol";
import {IPriceStrategy} from "./interfaces/IPriceStrategy.sol";

/// @title Collection
/// @notice The sequential collection — the common form. The contract counts
///         1, 2, 3: the token id IS the mint order, and ids never come back
///         after a burn. An edition of 100 is 100, forever.
///
///         Collectors buy through the built-in paid paths below; authorized
///         minters may also mint through mintTo on their own schedules. There
///         is no id-choosing entrypoint anywhere in this contract — that is
///         the whole guarantee, made by the ABI rather than by a check.
contract Collection is CollectionCore, ICollection {
    function idMode() public pure override(CollectionCore, ICollectionCore) returns (IdMode) {
        return IdMode.Sequential;
    }

    /// @dev The cap bounds mints EVER: burning a token does not free a seat.
    function _capUsage() internal view override returns (uint256) {
        return _mintedEver;
    }

    /// @dev A full cap closes the collection for good.
    function _capFilled() internal view override returns (bool) {
        return _cfg.supplyCap != 0 && _mintedEver >= _cfg.supplyCap;
    }

    /// @dev The standard rule: the holder, or someone the holder approved.
    function _burnAuthorized(address tokenOwner, uint256 tokenId) internal view override returns (bool) {
        return _isAuthorized(tokenOwner, msg.sender, tokenId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint: built-in paid paths (value custody stays here)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Simple mint. No referrer, so the artist keeps the full price.
    function mint(uint256 quantity) external payable override nonReentrant {
        _mintPaid(quantity, address(0), "");
    }

    /// @notice Mint crediting `referrer` its share — PND on PND, the artist
    ///         on their own site. referrer 0 folds the share back to the
    ///         artist. `hookData` reaches the hook and the price strategy.
    function mintWithReferral(uint256 quantity, address referrer, bytes calldata hookData)
        external
        payable
        override
        nonReentrant
    {
        _mintPaid(quantity, referrer, hookData);
    }

    function _mintPaid(uint256 quantity, address referrer, bytes memory hookData) private {
        if (quantity == 0) revert ZeroQuantity();
        if (block.timestamp < _cfg.mintStart) revert MintNotStarted();
        if (_cfg.mintEnd != 0 && block.timestamp >= _cfg.mintEnd) revert MintEnded();
        _checkCap(quantity);

        // Fixed price: exact match, honest pricing. With a strategy set the
        // price can move between quote and inclusion (basefee terms), so
        // accept >= and accrue the excess back to the payer. `required` is
        // read from the strategy exactly once and reused for the settle, so a
        // misbehaving strategy can never split money the contract never got.
        uint256 required;
        address strategy = _cfg.priceStrategy;
        if (strategy == address(0)) {
            required = _cfg.price * quantity;
            if (msg.value != required) revert WrongPayment(required, msg.value);
        } else {
            required = IPriceStrategy(strategy).priceOf(address(this), msg.sender, quantity, hookData);
            if (msg.value < required) revert Underpayment(required, msg.value);
            uint256 excess = msg.value - required;
            if (excess > 0) {
                _pending[msg.sender] += excess;
                _totalPending += excess;
            }
        }

        uint256 firstMintIndex = _mintedEver;
        uint256 firstTokenId = firstMintIndex + 1;
        _runBeforeHook(msg.sender, quantity, firstTokenId, referrer, hookData);

        CollectionStatus statusAtMint = _lifecycleStatus(); // always Open here
        for (uint256 i = 0; i < quantity; i++) {
            _mintOne(msg.sender, firstTokenId + i);
        }

        _settle(required, referrer);
        _runAfterHook(msg.sender, quantity, firstTokenId, referrer, hookData);

        emit Minted(msg.sender, referrer, firstTokenId, quantity, firstMintIndex, statusAtMint);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint: extension path (economics live in the authorized minter)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Authorized minters only. Non-payable: the calling minter
    ///         carries all value handling. Hooks and the cap apply exactly as
    ///         on the paid path; the sale window does not — an extension
    ///         minter owns its own schedule, and the artist's lever is
    ///         revoking the grant.
    function mintTo(address to, address referrer, bytes calldata hookData)
        external
        override
        nonReentrant
        returns (uint256 tokenId)
    {
        if (!_minters[msg.sender]) revert NotMinter();
        _checkCap(1);
        uint256 mintIndex = _mintedEver;
        tokenId = mintIndex + 1;
        _runBeforeHook(to, 1, tokenId, referrer, hookData);
        CollectionStatus statusAtMint = _lifecycleStatus();
        _mintOne(to, tokenId);
        _runAfterHook(to, 1, tokenId, referrer, hookData);
        emit Minted(to, referrer, tokenId, 1, mintIndex, statusAtMint);
    }
}
