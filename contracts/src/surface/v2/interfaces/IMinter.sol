// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IMinter (v2)
/// @notice The value-facing mint ABI of a canonical Surface v2 sale. A
///         client that reads a collection's `minter()` detects this
///         interface over ERC-165 to tell a canonical sale from a bespoke
///         minter. Per-sale config (price, window, gate, payout) is not part
///         of it.
interface IMinter {
    /// @notice Mint `quantity` tokens to the caller. The referral share goes
    ///         to the sale's fixed default referrer; no gate data is sent.
    function mint(uint256 quantity) external payable;

    /// @notice Mint `quantity` tokens to `to`. `to` is both the recipient
    ///         and the address the gate and wallet cap evaluate. `referrer`
    ///         receives the referral share when nonzero; with a zero
    ///         referrer the whole payment accrues to the payout recipient.
    ///         `data` is passed to the gate and nothing else.
    function mintWithReferral(address to, uint256 quantity, address referrer, bytes calldata data) external payable;

    /// @notice Price in wei to mint `quantity` tokens to `to`. Does not
    ///         evaluate the gate or the window.
    function priceOf(address to, uint256 quantity) external view returns (uint256);

    // ── errors: the mint checks, in the order they run ─────────────────────
    error SaleClosed();
    error MintNotStarted();
    error MintEnded();
    error MaxMintsExceeded(uint256 maxMints, uint256 attempted);
    error GateRejected();
    error WalletCapExceeded(uint256 cap, uint256 attempted);
    error WrongPayment(uint256 required, uint256 sent);
    error ReceiverRejected(address to);

    // ── events ──────────────────────────────────────────────────────────────
    /// @notice One per successful mint call. `paid` is the exact payment.
    event Sold(
        address indexed payer,
        address indexed to,
        address indexed referrer,
        uint256 quantity,
        uint256 paid,
        uint256 firstTokenId
    );
    event ReferralPaid(address indexed referrer, uint256 amount);
}
