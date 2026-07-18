// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceCore} from "./SurfaceCore.sol";
import {ISurface} from "./interfaces/ISurface.sol";
import {ISurfaceCore} from "./interfaces/ISurfaceCore.sol";
import {SurfaceStatus, IdMode} from "./SurfaceTypes.sol";
import {IPriceStrategy} from "./interfaces/IPriceStrategy.sol";

/// @title Surface
/// @notice A collection whose token id is its mint order: ids are assigned
///         1, 2, 3, ... and are never reused after a burn, so an edition of
///         100 stays 100 for the life of the contract. Collectors buy through
///         the paid paths below; an authorized minter can also mint through
///         mintTo on its own schedule.
contract Surface is SurfaceCore, ISurface {
    function idMode() public pure override(SurfaceCore, ISurfaceCore) returns (IdMode) {
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
        _mintPaid(msg.sender, quantity, address(0), "");
    }

    /// @notice Mint crediting `referrer` its share. referrer 0 folds the
    ///         share back to the artist. `hookData` reaches the hook and the
    ///         price strategy.
    function mintWithReferral(uint256 quantity, address referrer, bytes calldata hookData)
        external
        payable
        override
        nonReentrant
    {
        _mintPaid(msg.sender, quantity, referrer, hookData);
    }

    /// @notice Paid mint to someone else: same paid path and price, only the
    ///         recipient differs. The event records the true first owner.
    ///         `to` is who the hook and the price strategy judge (an
    ///         allowlist gates the collector, not their payer); any
    ///         overpayment refund accrues to the payer.
    function mintFor(address to, uint256 quantity, address referrer, bytes calldata hookData)
        external
        payable
        override
        nonReentrant
    {
        _mintPaid(to, quantity, referrer, hookData);
    }

    function _mintPaid(address to, uint256 quantity, address referrer, bytes memory hookData) private {
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
            required = IPriceStrategy(strategy).priceOf(address(this), to, quantity, hookData);
            if (msg.value < required) revert Underpayment(required, msg.value);
            uint256 excess = msg.value - required;
            if (excess > 0) {
                _pending[msg.sender] += excess;
                _totalPending += excess;
            }
        }

        uint256 firstMintIndex = _mintedEver;
        uint256 firstTokenId = firstMintIndex + 1;
        _runBeforeHook(to, quantity, firstTokenId, referrer, hookData);

        SurfaceStatus statusAtMint = _lifecycleStatus(); // always Open here
        for (uint256 i = 0; i < quantity; i++) {
            _mintOne(to, firstTokenId + i);
        }

        _settle(required, referrer);
        _runAfterHook(to, quantity, firstTokenId, referrer, hookData);

        emit Minted(to, referrer, firstTokenId, quantity, firstMintIndex, statusAtMint);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint: extension path (economics live in the authorized minter)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Authorized minters only. Non-payable: the calling minter
    ///         carries all value handling. Hooks and the cap apply exactly as
    ///         on the paid path; the sale window does not, since an extension
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
        SurfaceStatus statusAtMint = _lifecycleStatus();
        _mintOne(to, tokenId);
        _runAfterHook(to, 1, tokenId, referrer, hookData);
        emit Minted(to, referrer, tokenId, 1, mintIndex, statusAtMint);
    }
}
