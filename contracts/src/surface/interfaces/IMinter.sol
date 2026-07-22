// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IMinter
/// @notice Value-facing mint ABI shared by stock minters, so a frontend and
///         indexer see one shape regardless of which minter a collection
///         uses. Per-minter config (price, window, gates, payout) is not
///         part of this interface; each minter owns its own config surface.
///         Withdrawal and admin-config errors are likewise minter-specific
///         and not declared here.
interface IMinter {
    /// @notice Mint `quantity` tokens to `to`. `to` is both the recipient and
    ///         the address any gate evaluates (an allowlist gates the
    ///         collector, not the payer). `referrer` receives the minter's
    ///         referral share when nonzero; with a zero referrer the entire
    ///         amount accrues to the artist payout. `data` is the allowlist
    ///         Merkle proof and nothing else: it is consumed only by the gate
    ///         and never forwarded to the price strategy. A collection with no
    ///         allowlist ignores it (pass empty). Overpayment on a
    ///         strategy-priced mint accrues to the payer (`msg.sender`) by pull
    ///         payment.
    function mint(address to, uint256 quantity, address referrer, bytes calldata data) external payable;

    /// @notice Price in wei to mint `quantity` tokens to `to`: the stored fixed
    ///         price, or the price strategy's quote when one is set. The quote
    ///         is a function of `(to, quantity)` and chain state; it takes no
    ///         caller data. Does not evaluate gates or the mint window.
    function priceOf(address to, uint256 quantity) external view returns (uint256);

    // ── errors: mint()'s own checks ──────────────────────────────────────────
    error ZeroQuantity();
    error MintNotStarted();
    error MintEnded();
    error MaxMintsExceeded(uint256 maxMints, uint256 attempted);
    error NotAllowlisted();
    error WalletCapExceeded(uint256 cap, uint256 attempted);
    /// @dev Fixed-price branch: payment must equal price * quantity exactly.
    error WrongPayment(uint256 required, uint256 sent);
    /// @dev Strategy-price branch: payment must at least cover the quote;
    ///      the quote is read once and reused for the settle.
    error Underpayment(uint256 required, uint256 sent);

    // ── events: the sale record, uniform across canonical-minter clones ─────
    /// @notice One per successful mint call. `paid` is the required price
    ///         actually settled (excludes any refunded excess).
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
