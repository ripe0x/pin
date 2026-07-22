// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {
    ReentrancyGuardUpgradeable
} from "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";

import {IMinter} from "../interfaces/IMinter.sol";
import {ISurface} from "../interfaces/ISurface.sol";
import {ISurfaceAuth} from "../interfaces/ISurfaceAuth.sol";
import {IPriceStrategy} from "../interfaces/IPriceStrategy.sol";

/// @notice All parameters initialize() needs, in one struct so the call
///         stays within legacy-codegen stack limits and can grow without
///         changing the signature.
struct FixedPriceMinterInitParams {
    address collection;
    uint256 price; // wei; used when priceStrategy is unset
    address priceStrategy; // 0 = fixed price
    uint64 mintStart; // unix seconds; 0 = open immediately
    uint64 mintEnd; // unix seconds; 0 = open-ended
    address payoutRecipient; // stored artist payout address; must be nonzero
    uint256 maxMints; // 0 = unlimited; this minter's own sale ceiling
    bytes32 allowlistRoot; // 0 = open
    uint256 walletCap; // 0 = unlimited; per-recipient
}

/// @title FixedPriceMinter
/// @notice Canonical fixed-price/referral minter for a sequential Surface
///         collection: one EIP-1167 clone per collection, calling
///         `ISurface(collection).mintTo`. Pooled collections assign ids
///         through their own minter (there is no general id-assignment
///         policy a fixed-price pooled sale could use), so this minter is
///         sequential-only.
///
///         Holds proceeds by pull payment (recipients withdraw); config
///         authority is borrowed from the collection (owner or admin, the
///         pattern the deleted HookBase used). Every mint through this
///         contract is paid: price 0 is legal config but not a free-mint
///         special case, and there is no owner-mint path. Owner airdrops go
///         around the minter (grant a one-off minter, mint, revoke).
///
/// @dev    Deployed as an immutable EIP-1167 clone: no proxy admin, no
///         upgrade path. The OZ "Upgradeable" bases are used only for the
///         initializer pattern (a clone runs no constructor); the collection
///         binding is set once in initialize() with no setter.
contract FixedPriceMinter is Initializable, ReentrancyGuardUpgradeable, IMinter {
    uint16 internal constant BPS = 10_000;
    /// @notice Hard ceiling for the referral share (10%). setReferralShareBps
    ///         reverts above it.
    uint16 public constant MAX_REFERRAL_SHARE_BPS = 1_000;

    /// @notice The collection this clone sells for. Set once at
    ///         initialize(); no setter.
    address public collection;

    /// @notice Referral share paid to the referrer that hosts a mint, in bps.
    ///         Initialized to MAX_REFERRAL_SHARE_BPS; collection owner/admin
    ///         settable via setReferralShareBps, capped at
    ///         MAX_REFERRAL_SHARE_BPS. Not a protocol fee. A mint with no
    ///         referrer accrues the full share to the artist.
    uint16 public referralShareBps;

    uint256 public price;
    address public priceStrategy;
    uint64 public mintStart;
    uint64 public mintEnd;
    /// @notice The artist payout address. A concrete stored value set at
    ///         initialize() and updatable via setPayoutRecipient(); never
    ///         derived from the collection's owner(). Enforced nonzero at
    ///         both write points, so renouncing collection ownership does
    ///         not affect where proceeds go, only whether this can still be
    ///         changed.
    address public payoutRecipient;
    /// @notice This minter clone's own sale ceiling (0 = unlimited),
    ///         distinct from the collection's supplyCap: maxMints bounds
    ///         what this clone alone can sell, supplyCap bounds the
    ///         collection across every minter it grants. See saleCap() for
    ///         the same value under an integration-facing name.
    uint256 public maxMints;
    bytes32 public allowlistRoot;
    uint256 public walletCap;

    /// @notice Count minted through this minter clone across its lifetime,
    ///         for the maxMints ceiling. Not the collection's lifetime mint
    ///         count: other minters granted on the same collection mint
    ///         against their own totalMinted, and the collection's own
    ///         mint-order counter is separate state. See
    ///         totalMintedByThisMinter() for the same value under an
    ///         integration-facing name.
    uint256 public totalMinted;
    /// @notice Tokens minted to `to` through this clone, for the wallet cap.
    ///         Counted after a mint succeeds, matching the deleted
    ///         GateHook's ordering.
    mapping(address => uint256) public mintedBy;

    // Pull-payment balances: mints accrue here, recipients claim via
    // withdraw(). No external transfer during a mint, so a reverting
    // recipient cannot block minting. Overpayment on a strategy price
    // accrues back to the payer the same way.
    mapping(address => uint256) internal _pending;
    // Sum of all _pending balances. rescueStrayETH may only sweep the
    // balance above this amount; owed funds are never swept.
    uint256 internal _totalPending;

    error CollectionRequired();
    error NotAContract(address account);
    error BadMintWindow();
    error NotAuthorized();
    error ZeroAccount();
    error NothingToWithdraw();
    error WithdrawFailed();
    error NoStrayETH();
    error RescueFailed();
    error ReferralShareAboveCap(uint16 requested, uint16 cap);
    /// @dev initialize() and setPayoutRecipient() both reject a zero
    ///      payoutRecipient, so _settle never has to resolve one.
    error PayoutRecipientRequired();

    event MinterConfigured(
        address indexed collection,
        uint256 price,
        address priceStrategy,
        uint64 mintStart,
        uint64 mintEnd,
        address payoutRecipient,
        uint256 maxMints,
        bytes32 allowlistRoot,
        uint256 walletCap
    );
    event PriceSet(uint256 price);
    event PriceStrategySet(address indexed strategy);
    event MintWindowSet(uint64 mintStart, uint64 mintEnd);
    event PayoutRecipientSet(address indexed payoutRecipient);
    event MaxMintsSet(uint256 maxMints);
    event AllowlistRootSet(bytes32 root);
    event WalletCapSet(uint256 cap);
    event ReferralShareSet(uint16 bps);
    event Withdrawn(address indexed account, uint256 amount);
    event StrayETHRescued(address indexed to, uint256 amount);

    constructor() {
        _disableInitializers();
    }

    /// @dev Caller authority: permitted when the collection clone is not yet
    ///      initialized (owner() == address(0), the window the factory's
    ///      atomic createSurface uses: token clones first, then the minter
    ///      clones and initializes against it, then the token initializes),
    ///      or when the caller is that collection's live owner or admin
    ///      (standalone deployment against an already-live collection).
    function initialize(FixedPriceMinterInitParams calldata p) external initializer {
        if (p.collection == address(0)) revert CollectionRequired();
        if (p.collection.code.length == 0) revert NotAContract(p.collection);
        address collectionOwner = ISurfaceAuth(p.collection).owner();
        if (collectionOwner != address(0)) {
            if (msg.sender != collectionOwner && !ISurfaceAuth(p.collection).isAdmin(msg.sender)) {
                revert NotAuthorized();
            }
        }
        if (p.priceStrategy != address(0) && p.priceStrategy.code.length == 0) {
            revert NotAContract(p.priceStrategy);
        }
        if (p.mintEnd != 0 && p.mintEnd <= p.mintStart) revert BadMintWindow();
        if (p.payoutRecipient == address(0)) revert PayoutRecipientRequired();
        __ReentrancyGuard_init();
        collection = p.collection;
        referralShareBps = MAX_REFERRAL_SHARE_BPS;
        price = p.price;
        priceStrategy = p.priceStrategy;
        mintStart = p.mintStart;
        mintEnd = p.mintEnd;
        payoutRecipient = p.payoutRecipient;
        maxMints = p.maxMints;
        allowlistRoot = p.allowlistRoot;
        walletCap = p.walletCap;
        emit MinterConfigured(
            p.collection,
            p.price,
            p.priceStrategy,
            p.mintStart,
            p.mintEnd,
            p.payoutRecipient,
            p.maxMints,
            p.allowlistRoot,
            p.walletCap
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IMinter
    function mint(address to, uint256 quantity, address referrer, bytes calldata data)
        external
        payable
        override
        nonReentrant
    {
        _executeMint(msg.sender, to, quantity, referrer, data);
    }

    /// @notice Ergonomic overload for the common case: mint to the caller,
    ///         no referrer, no gate data. Same guarded path as the 4-arg
    ///         entrypoint (`_executeMint`), so settlement, gates, and
    ///         reentrancy protection are identical.
    function mint(uint256 quantity) external payable nonReentrant {
        _executeMint(msg.sender, msg.sender, quantity, address(0), "");
    }

    /// @dev The mint body shared by both external entrypoints. `payer` is
    ///      msg.sender at the call site, passed explicitly rather than read
    ///      here so this can only ever be reached through one of the two
    ///      nonReentrant externals, never a self-call that would change
    ///      msg.sender and misroute the excess-refund accrual or the Sold
    ///      event's payer field. Reads msg.value directly: it is preserved
    ///      across an internal call.
    function _executeMint(address payer, address to, uint256 quantity, address referrer, bytes memory data)
        internal
    {
        if (quantity == 0) revert ZeroQuantity();
        if (mintStart != 0 && block.timestamp < mintStart) revert MintNotStarted();
        if (mintEnd != 0 && block.timestamp >= mintEnd) revert MintEnded();

        // This minter's own sale ceiling, not the collection's supplyCap (that
        // cap is enforced separately, inside the collection's mintTo).
        uint256 max = maxMints;
        uint256 mintedSoFar = totalMinted;
        if (max != 0 && mintedSoFar + quantity > max) revert MaxMintsExceeded(max, mintedSoFar + quantity);

        bytes32 root = allowlistRoot;
        if (root != bytes32(0)) {
            bytes32[] memory proof = abi.decode(data, (bytes32[]));
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(to))));
            if (!MerkleProof.verify(proof, root, leaf)) revert NotAllowlisted();
        }

        uint256 cap = walletCap;
        uint256 mintedByRecipient = mintedBy[to];
        if (cap != 0) {
            uint256 attempted = mintedByRecipient + quantity;
            if (attempted > cap) revert WalletCapExceeded(cap, attempted);
        }

        // Fixed price: require exact match. With a strategy set, the price
        // can move between quote and inclusion (basefee terms), so accept
        // >= and accrue the excess to the payer. `required` is read from the
        // strategy once and reused for the settle, so a misbehaving
        // strategy cannot split value this contract never received.
        uint256 required;
        address strategy = priceStrategy;
        if (strategy == address(0)) {
            required = price * quantity;
            if (msg.value != required) revert WrongPayment(required, msg.value);
        } else {
            required = IPriceStrategy(strategy).priceOf(collection, to, quantity, data);
            if (msg.value < required) revert Underpayment(required, msg.value);
            uint256 excess = msg.value - required;
            if (excess > 0) {
                _pending[payer] += excess;
                _totalPending += excess;
            }
        }

        uint256 firstTokenId = ISurface(collection).mintTo(to, quantity);

        totalMinted = mintedSoFar + quantity;
        if (cap != 0) {
            mintedBy[to] = mintedByRecipient + quantity;
        }

        _settle(required, referrer);

        emit Sold(payer, to, referrer, quantity, required, firstTokenId);
    }

    /// @inheritdoc IMinter
    function priceOf(address to, uint256 quantity, bytes calldata data) external view override returns (uint256) {
        address strategy = priceStrategy;
        if (strategy == address(0)) return price * quantity;
        return IPriceStrategy(strategy).priceOf(collection, to, quantity, data);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Integration aliases (same value as the underlying public getter, under
    // a clearer name for a client reading across multiple minters/forms)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Alias for totalMinted: the count minted through this minter
    ///         clone, not the collection's lifetime count.
    function totalMintedByThisMinter() external view returns (uint256) {
        return totalMinted;
    }

    /// @notice Alias for maxMints: this minter clone's own sale ceiling,
    ///         distinct from the collection's supplyCap.
    function saleCap() external view returns (uint256) {
        return maxMints;
    }

    /// @dev Accrue `total`, split between the referral share and the artist
    ///      payout. referrer 0 accrues the full amount to payoutRecipient. No
    ///      external call here; recipients claim via withdraw(). payoutRecipient
    ///      is a stored value enforced nonzero at both write points (initialize,
    ///      setPayoutRecipient), so it is never resolved here and a renounced
    ///      collection keeps paying it.
    function _settle(uint256 total, address referrer) internal {
        if (total == 0) return;
        uint256 referralCut = referrer == address(0) ? 0 : (total * referralShareBps) / BPS;
        uint256 artistCut = total - referralCut;
        _totalPending += total;
        if (referralCut > 0) {
            _pending[referrer] += referralCut;
            emit ReferralPaid(referrer, referralCut);
        }
        if (artistCut > 0) {
            _pending[payoutRecipient] += artistCut;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pull payments
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Send `account` its owed balance. Callable by anyone; funds go
    ///         only to the owed address.
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

    /// @notice Sweep only ETH nobody is owed (for example, forced in via
    ///         selfdestruct). The balance up to _totalPending is not swept.
    function rescueStrayETH(address to) external onlyCollectionOwnerOrAdmin nonReentrant {
        if (to == address(0)) revert ZeroAccount();
        uint256 stray = address(this).balance - _totalPending;
        if (stray == 0) revert NoStrayETH();
        (bool ok,) = payable(to).call{value: stray}("");
        if (!ok) revert RescueFailed();
        emit StrayETHRescued(to, stray);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config (borrowed authority: the collection's owner or admin)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Same authority root as the collection's own setters: owner or
    ///      admin. Borrowed rather than a separate Ownable, so one keyring
    ///      governs both contracts and an ownership transfer invalidates
    ///      delegated admins for minter config too.
    modifier onlyCollectionOwnerOrAdmin() {
        address c = collection;
        if (msg.sender != ISurfaceAuth(c).owner() && !ISurfaceAuth(c).isAdmin(msg.sender)) {
            revert NotAuthorized();
        }
        _;
    }

    function setPrice(uint256 price_) external onlyCollectionOwnerOrAdmin {
        price = price_;
        emit PriceSet(price_);
    }

    function setPriceStrategy(address strategy) external onlyCollectionOwnerOrAdmin {
        if (strategy != address(0) && strategy.code.length == 0) revert NotAContract(strategy);
        priceStrategy = strategy;
        emit PriceStrategySet(strategy);
    }

    function setMintWindow(uint64 start, uint64 end) external onlyCollectionOwnerOrAdmin {
        if (end != 0 && end <= start) revert BadMintWindow();
        mintStart = start;
        mintEnd = end;
        emit MintWindowSet(start, end);
    }

    /// @notice Update the stored artist payout address. Same borrowed
    ///         authority as the other config setters (collection owner or
    ///         admin); if the collection's owner has renounced and no admin
    ///         is granted, this can no longer be called, but the existing
    ///         stored value keeps paying out.
    function setPayoutRecipient(address payoutRecipient_) external onlyCollectionOwnerOrAdmin {
        if (payoutRecipient_ == address(0)) revert PayoutRecipientRequired();
        payoutRecipient = payoutRecipient_;
        emit PayoutRecipientSet(payoutRecipient_);
    }

    function setMaxMints(uint256 maxMints_) external onlyCollectionOwnerOrAdmin {
        maxMints = maxMints_;
        emit MaxMintsSet(maxMints_);
    }

    function setAllowlistRoot(bytes32 root) external onlyCollectionOwnerOrAdmin {
        allowlistRoot = root;
        emit AllowlistRootSet(root);
    }

    function setWalletCap(uint256 cap) external onlyCollectionOwnerOrAdmin {
        walletCap = cap;
        emit WalletCapSet(cap);
    }

    /// @notice Set the referral share, up to MAX_REFERRAL_SHARE_BPS.
    function setReferralShareBps(uint16 bps) external onlyCollectionOwnerOrAdmin {
        if (bps > MAX_REFERRAL_SHARE_BPS) revert ReferralShareAboveCap(bps, MAX_REFERRAL_SHARE_BPS);
        referralShareBps = bps;
        emit ReferralShareSet(bps);
    }
}
