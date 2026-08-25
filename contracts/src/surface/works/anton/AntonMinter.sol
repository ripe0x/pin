// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

import {IMinter} from "../../interfaces/IMinter.sol";
import {ISurface} from "../../interfaces/ISurface.sol";
import {ISurfaceView} from "../../interfaces/IRenderer.sol";
import {ISurfaceAuth} from "../../interfaces/ISurfaceAuth.sol";
import {AntonParams} from "./AntonParams.sol";

/// @title AntonMinter
/// @notice Fixed-price minter for the anton work. Palette and tone are not
///         chosen: the minter mints the tokens through the collection core, then
///         draws each one's (palette, tone) from its own seed (prevrandao-based,
///         stamped in mintTo) and writes them to AntonParams. Random at mint,
///         not caller-supplied. The token owner can re-pick later through
///         AntonParams directly.
///
///         Bespoke single deploy, not a factory clone: a normal constructor
///         sets the collection, params registry, and payout address once.
///         Proceeds are held by pull payment; config authority (price, window)
///         is borrowed from the collection owner/admin, the same root that
///         gates the collection's own setters. Up to MAX_PER_MINT per call;
///         each token draws its own identity from its own seed.
contract AntonMinter is IMinter, ReentrancyGuard {
    /// @notice The collection this minter sells for.
    address public immutable collection;

    /// @notice The params registry this minter writes each mint's selection to.
    AntonParams public immutable params;

    /// @notice Artist payout address. Proceeds accrue here by pull payment.
    address public payoutRecipient;

    /// @notice Price in wei per token.
    uint256 public price;

    /// @notice Mint window in unix seconds. start 0 = open immediately;
    ///         end 0 = open-ended.
    uint64 public mintStart;
    uint64 public mintEnd;

    /// @notice Count minted through this minter.
    uint256 public totalMinted;

    mapping(address => uint256) private _pending;
    uint256 private _totalPending;

    error CollectionRequired();
    error ParamsRequired();
    error PayoutRecipientRequired();
    error NotAuthorized();
    error BadMintWindow();
    error TooManyPerMint(uint256 max, uint256 attempted);
    error ZeroAccount();
    error NothingToWithdraw();
    error WithdrawFailed();

    event MinterConfigured(address indexed collection, address params, uint256 price, address payoutRecipient);
    event PriceSet(uint256 price);
    event MintWindowSet(uint64 mintStart, uint64 mintEnd);
    event PayoutRecipientSet(address indexed payoutRecipient);
    event Withdrawn(address indexed account, uint256 amount);

    constructor(
        address collection_,
        address params_,
        uint256 price_,
        uint64 mintStart_,
        uint64 mintEnd_,
        address payoutRecipient_
    ) {
        if (collection_ == address(0)) revert CollectionRequired();
        if (params_ == address(0)) revert ParamsRequired();
        if (payoutRecipient_ == address(0)) revert PayoutRecipientRequired();
        if (mintEnd_ != 0 && mintEnd_ <= mintStart_) revert BadMintWindow();
        collection = collection_;
        params = AntonParams(params_);
        price = price_;
        mintStart = mintStart_;
        mintEnd = mintEnd_;
        payoutRecipient = payoutRecipient_;
        emit MinterConfigured(collection_, params_, price_, payoutRecipient_);
    }

    // ── mint ────────────────────────────────────────────────────────────────

    /// @notice Max tokens per mint call. ponytail: fixed cap that keeps a batch
    ///         mint well under the block gas limit (each token writes params);
    ///         raise it if a larger batch is ever wanted.
    uint256 public constant MAX_PER_MINT = 20;

    /// @notice Mint `quantity` tokens to the caller. Palette and tone are not
    ///         chosen: each token draws its own from its own seed (see `_mint`).
    function mint(uint256 quantity) external payable nonReentrant {
        _mint(msg.sender, msg.sender, quantity, address(0));
    }

    /// @inheritdoc IMinter
    /// @dev Standard integration entrypoint. `data` is unused (identity is random
    ///      from each token's seed). `to` is the recipient (paid gift-mint when
    ///      it differs from the caller); `referrer` is accepted for interface
    ///      parity and folded into the artist payout (no referral split).
    function mint(address to, uint256 quantity, address referrer, bytes calldata)
        external
        payable
        override
        nonReentrant
    {
        _mint(msg.sender, to, quantity, referrer);
    }

    function _mint(
        address payer,
        address to,
        uint256 quantity,
        address // referrer, folded into payout in this work
    ) private {
        if (quantity == 0) revert ZeroQuantity();
        if (quantity > MAX_PER_MINT) revert TooManyPerMint(MAX_PER_MINT, quantity);
        if (mintStart != 0 && block.timestamp < mintStart) revert MintNotStarted();
        if (mintEnd != 0 && block.timestamp >= mintEnd) revert MintEnded();

        uint256 required = price * quantity;
        if (msg.value != required) revert WrongPayment(required, msg.value);

        uint256 firstTokenId = ISurface(collection).mintTo(to, quantity);
        totalMinted += quantity;

        uint8 pc = params.paletteCount();
        uint8 tc = params.toneCount();
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = firstTokenId + i;
            // Each token draws palette + tone from its own seed (prevrandao-based,
            // stamped in mintTo): random at mint, not chosen.
            uint256 seed = uint256(ISurfaceView(collection).tokenSeed(tokenId));
            params.initParams(collection, tokenId, uint8(seed % pc), uint8((seed >> 8) % tc));
        }

        if (required > 0) {
            _pending[payoutRecipient] += required;
            _totalPending += required;
        }

        emit Sold(payer, to, address(0), quantity, required, firstTokenId);
    }

    /// @inheritdoc IMinter
    function priceOf(address, uint256 quantity) external view override returns (uint256) {
        return price * quantity;
    }

    // ── pull payments ─────────────────────────────────────────────────────────

    function withdraw(address account) external nonReentrant {
        if (account == address(0)) revert ZeroAccount();
        uint256 amount = _pending[account];
        if (amount == 0) revert NothingToWithdraw();
        _pending[account] = 0;
        _totalPending -= amount;
        (bool ok,) = payable(account).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(account, amount);
    }

    function pendingWithdrawal(address account) external view returns (uint256) {
        return _pending[account];
    }

    // ── config (borrowed collection authority) ──────────────────────────────

    modifier onlyCollectionOwnerOrAdmin() {
        if (msg.sender != ISurfaceAuth(collection).owner() && !ISurfaceAuth(collection).isAdmin(msg.sender)) {
            revert NotAuthorized();
        }
        _;
    }

    function setPrice(uint256 price_) external onlyCollectionOwnerOrAdmin {
        price = price_;
        emit PriceSet(price_);
    }

    function setMintWindow(uint64 start, uint64 end) external onlyCollectionOwnerOrAdmin {
        if (end != 0 && end <= start) revert BadMintWindow();
        mintStart = start;
        mintEnd = end;
        emit MintWindowSet(start, end);
    }

    function setPayoutRecipient(address payoutRecipient_) external onlyCollectionOwnerOrAdmin {
        if (payoutRecipient_ == address(0)) revert PayoutRecipientRequired();
        payoutRecipient = payoutRecipient_;
        emit PayoutRecipientSet(payoutRecipient_);
    }
}
