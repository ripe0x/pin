// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceCore} from "./SurfaceCore.sol";
import {ISurface} from "./interfaces/ISurface.sol";
import {ISurfaceCore} from "./interfaces/ISurfaceCore.sol";
import {SurfaceStatus, IdMode} from "./SurfaceTypes.sol";
import {IPriceStrategy} from "./interfaces/IPriceStrategy.sol";

/// @title Surface
/// @notice Sequential collection form. Token ids are assigned in mint order
///         (1, 2, 3, ...) and never reused after a burn, so a supply cap of
///         100 remains 100 for the life of the contract. Paid mint paths below
///         are for collectors; an authorized minter can also mint via mintTo.
contract Surface is SurfaceCore, ISurface {
    function idMode() public pure override(SurfaceCore, ISurfaceCore) returns (IdMode) {
        return IdMode.Sequential;
    }

    /// @dev Cap bounds total mints ever; burning a token does not free capacity.
    function _capUsage() internal view override returns (uint256) {
        return _mintedEver;
    }

    /// @dev A filled cap closes the collection permanently.
    function _capFilled() internal view override returns (bool) {
        return _cfg.supplyCap != 0 && _mintedEver >= _cfg.supplyCap;
    }

    /// @dev Burn allowed for the token holder or an address the holder approved.
    function _burnAuthorized(address tokenOwner, uint256 tokenId) internal view override returns (bool) {
        return _isAuthorized(tokenOwner, msg.sender, tokenId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint: built-in paid paths (value custody stays here)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Mint with no referrer; the referral share accrues to the artist.
    function mint(uint256 quantity) external payable override nonReentrant {
        _mintPaid(msg.sender, quantity, address(0), "");
    }

    /// @notice Mint crediting `referrer` its share. referrer 0 accrues the
    ///         share to the artist. `hookData` is passed to the hook and the
    ///         price strategy.
    function mintWithReferral(uint256 quantity, address referrer, bytes calldata hookData)
        external
        payable
        override
        nonReentrant
    {
        _mintPaid(msg.sender, quantity, referrer, hookData);
    }

    /// @notice Paid mint to a different recipient: same path and price, only
    ///         the recipient differs. The Minted event records the first owner
    ///         as `to`. `to` is the address the hook and price strategy
    ///         evaluate (an allowlist gates the recipient, not the payer). Any
    ///         overpayment refund accrues to the payer (msg.sender).
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

        // Fixed price: require exact match. With a strategy set, the price can
        // move between quote and inclusion (basefee terms), so accept >= and
        // accrue the excess to the payer. `required` is read from the strategy
        // once and reused for the settle, so a misbehaving strategy cannot
        // split value the contract never received.
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
    ///         handles all value. Hooks and the cap apply as on the paid path;
    ///         the sale window does not, since an extension minter controls its
    ///         own schedule. The artist's control is revoking the grant.
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
