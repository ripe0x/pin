"""Curated mutation run for the Surface v2 contracts.

Each mutant is one targeted edit to contracts/src/surface/v2 (a deleted or
flipped check, a reordered check, a wrong payee, a dropped modifier). For
each, the v2 suites run; a mutant must make at least one test fail. The
source file is restored after every mutant, even on error.

    cd contracts && python3 -I script/test/mutate.py . [label-filter]

Results: cache/mutation-results.json. Exit 1 if any mutant survives.
"""
import subprocess, sys, json, os
D = sys.argv[1]
FILTER = sys.argv[2] if len(sys.argv) > 2 else ""
S = "src/surface/v2/"
FPS, SUR, CF, LA, AG = S+"FixedPriceSale.sol", S+"Surface.sol", S+"CloneFactory.sol", S+"Launcher.sol", S+"AllowlistGate.sol"
M = [
 # FixedPriceSale: the ten checks
 ("sale:1 closed check deleted", FPS, "if (closed) revert SaleClosed(); // 1", "// 1"),
 ("sale:2 start check deleted", FPS, "if (mintStart != 0 && block.timestamp < mintStart) revert MintNotStarted(); // 2", "// 2"),
 ("sale:2 start < -> <=", FPS, "block.timestamp < mintStart", "block.timestamp <= mintStart"),
 ("sale:2 end check deleted", FPS, "if (mintEnd != 0 && block.timestamp >= mintEnd) revert MintEnded();", ""),
 ("sale:2 end >= -> >", FPS, "block.timestamp >= mintEnd", "block.timestamp > mintEnd"),
 ("sale:3 maxMints deleted", FPS, "if (maxMints != 0 && minted + quantity > maxMints) revert MaxMintsExceeded(maxMints, minted + quantity); // 3", "// 3"),
 ("sale:3 maxMints > -> >=", FPS, "minted + quantity > maxMints)", "minted + quantity >= maxMints)"),
 ("sale:4 gate check deleted", FPS, "if (gate != address(0) && !IGate(gate).check(collection_, to, quantity, data)) revert GateRejected(); // 4", "// 4"),
 ("sale:4 gate result ignored", FPS, "&& !IGate(gate).check(", "&& IGate(gate).check(collection_, to, quantity, data) && !IGate(gate).check("),
 ("sale:4 gate gets payer not to", FPS, "IGate(gate).check(collection_, to, quantity, data)", "IGate(gate).check(collection_, msg.sender, quantity, data)"),
 ("sale:5 walletCap deleted", FPS, "if (walletCap != 0 && mintedByTo + quantity > walletCap) {", "if (false) {"),
 ("sale:5 walletCap > -> >=", FPS, "mintedByTo + quantity > walletCap)", "mintedByTo + quantity >= walletCap)"),
 ("sale:6 payment check deleted", FPS, "if (msg.value != paid) revert WrongPayment(paid, msg.value); // 6", "// 6"),
 ("sale:6 payment != -> <", FPS, "if (msg.value != paid)", "if (msg.value < paid)"),
 ("sale:7 receiver check deleted", FPS, "if (to.code.length != 0) _checkReceiver(collection_, to, quantity); // 7", "// 7"),
 ("sale:7 receiver selector unchecked", FPS, "if (ret != IERC721Receiver.onERC721Received.selector) revert ReceiverRejected(to);", "ret;"),
 ("sale:7 receiver catch swallowed", FPS, "        } catch {\n            revert ReceiverRejected(to);\n        }", "        } catch {}"),
 ("sale:9 totalMinted not advanced", FPS, "totalMinted = minted + quantity; // 9", "// 9"),
 ("sale:9 mintedBy only when capped", FPS, "        mintedBy[to] = mintedByTo + quantity;", "        if (walletCap != 0) mintedBy[to] = mintedByTo + quantity;"),
 ("sale:9 mintedBy dropped", FPS, "        mintedBy[to] = mintedByTo + quantity;", ""),
 ("sale:order 3<->5 swapped", FPS, "        if (maxMints != 0 && minted + quantity > maxMints) revert MaxMintsExceeded(maxMints, minted + quantity); // 3\n        address collection_ = collection;\n        if (gate != address(0) && !IGate(gate).check(collection_, to, quantity, data)) revert GateRejected(); // 4\n        uint256 mintedByTo = mintedBy[to];\n        if (walletCap != 0 && mintedByTo + quantity > walletCap) {\n            revert WalletCapExceeded(walletCap, mintedByTo + quantity); // 5\n        }",
   "        address collection_ = collection;\n        uint256 mintedByTo = mintedBy[to];\n        if (walletCap != 0 && mintedByTo + quantity > walletCap) {\n            revert WalletCapExceeded(walletCap, mintedByTo + quantity); // 5\n        }\n        if (gate != address(0) && !IGate(gate).check(collection_, to, quantity, data)) revert GateRejected(); // 4\n        if (maxMints != 0 && minted + quantity > maxMints) revert MaxMintsExceeded(maxMints, minted + quantity); // 3"),
 ("sale:order 1<->2 swapped", FPS, "        if (closed) revert SaleClosed(); // 1\n        if (mintStart != 0 && block.timestamp < mintStart) revert MintNotStarted(); // 2", "        if (mintStart != 0 && block.timestamp < mintStart) revert MintNotStarted(); // 2\n        if (closed) revert SaleClosed(); // 1"),
 ("sale:order 6<->7 swapped", FPS, "        if (msg.value != paid) revert WrongPayment(paid, msg.value); // 6\n        if (to.code.length != 0) _checkReceiver(collection_, to, quantity); // 7", "        if (to.code.length != 0) _checkReceiver(collection_, to, quantity); // 7\n        if (msg.value != paid) revert WrongPayment(paid, msg.value); // 6"),
 # settlement
 ("settle:referral bps 500->1000", FPS, "uint16 public constant REFERRAL_SHARE_BPS = 500;", "uint16 public constant REFERRAL_SHARE_BPS = 1000;"),
 ("settle:referral paid even with zero referrer", FPS, "referrer == address(0) ? 0 : (paid * REFERRAL_SHARE_BPS) / BPS", "(paid * REFERRAL_SHARE_BPS) / BPS"),
 ("settle:referral to payout recipient", FPS, "_pending[referrer] += referral;", "_pending[payoutRecipient] += referral;"),
 ("settle:artist gets full paid", FPS, "_pending[payoutRecipient] += paid - referral;", "_pending[payoutRecipient] += paid;"),
 ("settle:mint() ignores defaultReferrer", FPS, "_mint(msg.sender, quantity, defaultReferrer, \"\");", "_mint(msg.sender, quantity, address(0), \"\");"),
 ("settle:mint() mints to tx.origin", FPS, "_mint(msg.sender, quantity, defaultReferrer, \"\");", "_mint(tx.origin, quantity, defaultReferrer, \"\");"),
 # payouts
 ("pay:withdraw pays caller", FPS, "        _withdraw(account, account);", "        _withdraw(account, msg.sender);"),
 ("pay:withdrawTo reads `to` balance", FPS, "        _withdraw(msg.sender, to);", "        _withdraw(to, to);"),
 ("pay:balance not zeroed", FPS, "        _pending[account] = 0;\n", ""),
 ("pay:failed transfer ignored", FPS, "if (!ok) revert WithdrawFailed();", "ok;"),
 ("pay:zero-to check deleted", FPS, "if (to == address(0)) revert ZeroAccount();", ""),
 # config authority
 ("cfg:onlyCollectionOwner removed", FPS, "        if (msg.sender != ISurface(collection).owner()) revert NotAuthorized();\n        _;", "        _;"),
 ("cfg:close reversible (no-op)", FPS, "        closed = true;\n        emit Closed();", "        closed = !closed;\n        emit Closed();"),
 ("cfg:payout zero allowed", FPS, "if (payoutRecipient_ == address(0)) revert PayoutRecipientRequired();", ""),
 ("cfg:window check deleted", FPS, "if (end != 0 && end <= start) revert BadMintWindow();", ""),
 ("cfg:gate code check deleted", FPS, "if (gate_ != address(0) && gate_.code.length == 0) revert NotAContract(gate_);", ""),
 ("init:authority OR -> AND", FPS, "if (ISurface(collection_).minter() != address(this) && msg.sender != ISurface(collection_).owner()) {", "if (ISurface(collection_).minter() != address(this) || msg.sender != ISurface(collection_).owner()) {"),
 ("init:authority removed", FPS, "            revert NotAuthorized();\n        }\n        __ReentrancyGuard_init();", "        }\n        __ReentrancyGuard_init();"),
 ("init:minter path removed", FPS, "if (ISurface(collection_).minter() != address(this) && msg.sender != ISurface(collection_).owner()) {", "if (msg.sender != ISurface(collection_).owner()) {"),
 ("id:supportsInterface wrong id", FPS, "interfaceId == type(IMinter).interfaceId ||", "interfaceId == bytes4(0x12345678) ||"),
 # Surface
 ("tok:minter check removed", SUR, "if (msg.sender != minter) revert NotMinter();", ""),
 ("tok:zero quantity allowed", SUR, "if (quantity == 0) revert ZeroQuantity();", ""),
 ("tok:cap > -> >=", SUR, "mintedEver + quantity > cap)", "mintedEver + quantity >= cap)"),
 ("tok:cap check removed", SUR, "if (cap != 0 && mintedEver + quantity > cap) revert ExceedsCap(cap, mintedEver + quantity);", ""),
 ("tok:mintedEver not advanced", SUR, "_mintedEver = mintedEver + quantity;", "_mintedEver = mintedEver + 1;"),
 ("tok:ids start at 0", SUR, "firstTokenId = mintedEver + 1;", "firstTokenId = mintedEver;"),
 ("tok:seed adds recipient", SUR, "keccak256(abi.encode(block.prevrandao, address(this), tokenId))", "keccak256(abi.encode(block.prevrandao, address(this), tokenId, to))"),
 ("tok:seed drops tokenId", SUR, "keccak256(abi.encode(block.prevrandao, address(this), tokenId))", "keccak256(abi.encode(block.prevrandao, address(this)))"),
 ("tok:burn without auth", SUR, "_update(address(0), tokenId, msg.sender);", "_update(address(0), tokenId, address(0));"),
 ("tok:burnedCount not incremented", SUR, "_burnedCount += 1;", ""),
 ("tok:self-custody removed", SUR, "if (to == address(this)) revert SelfCustodyRejected();", ""),
 ("tok:setMinter not onlyOwner", SUR, "function setMinter(address minter_) external override onlyOwner {", "function setMinter(address minter_) external override {"),
 ("tok:setRenderer not onlyOwner", SUR, "function setRenderer(address renderer_) external override onlyOwner {", "function setRenderer(address renderer_) external override {"),
 ("tok:setSupplyCap not onlyOwner", SUR, "function setSupplyCap(uint256 supplyCap_) external override onlyOwner {", "function setSupplyCap(uint256 supplyCap_) external override {"),
 ("tok:setRoyalty not onlyOwner", SUR, "function setRoyalty(uint16 bps, address receiver) external override onlyOwner {", "function setRoyalty(uint16 bps, address receiver) external override {"),
 ("tok:setName not onlyOwner", SUR, "function setName(string calldata name_, string calldata symbol_) external override onlyOwner {", "function setName(string calldata name_, string calldata symbol_) external override {"),
 ("tok:supply floor removed", SUR, "if (supplyCap_ != 0 && supplyCap_ < mintedEver) revert BadSupplyCap(mintedEver, supplyCap_);", ""),
 ("tok:notify widened", SUR, "if (msg.sender != renderer && msg.sender != owner()) revert NotAuthorized();", ""),
 ("tok:royalty cap 5000->10000", SUR, "uint16 internal constant MAX_ROYALTY_BPS = 5_000;", "uint16 internal constant MAX_ROYALTY_BPS = 10_000;"),
 ("tok:royalty receiver zero allowed", SUR, "if (receiver == address(0)) revert RoyaltyReceiverRequired();", ""),
 ("tok:renderer code check removed", SUR, "if (renderer_.code.length == 0) revert RendererNotContract(renderer_);", ""),
 ("tok:init minter zero allowed", SUR, "if (minter_ == address(0)) revert MinterRequired();", ""),
 ("tok:tokenSeed range off", SUR, "if (tokenId == 0 || tokenId > _mintedEver) revert NeverMinted(tokenId);", "if (tokenId > _mintedEver) revert NeverMinted(tokenId);"),
 ("tok:totalSupply ignores burns", SUR, "return _mintedEver - _burnedCount;", "return _mintedEver;"),
 ("tok:4906 not advertised", SUR, "interfaceId == INTERFACE_ID_ERC2981 || interfaceId == INTERFACE_ID_ERC4906", "interfaceId == INTERFACE_ID_ERC2981"),
 # CloneFactory
 ("cf:initSelector check removed", CF, "if (selector != initSelector) revert NotInitializer(selector);", ""),
 ("cf:create salt not caller-namespaced", CF, "return keccak256(abi.encode(caller, \"create\", nonce));", "return keccak256(abi.encode(\"create\", nonce));"),
 ("cf:createNonce not incremented", CF, "_createSalt(msg.sender, createNonce[msg.sender]++)", "_createSalt(msg.sender, createNonce[msg.sender])"),
 ("cf:deterministic salt not namespaced", CF, "return keccak256(abi.encode(caller, salt));", "return keccak256(abi.encode(salt));"),
 ("cf:pause ignored", CF, "if (paused) revert FactoryPaused();", ""),
 ("cf:deprecate not one-way", CF, "if (deprecated) revert AlreadyDeprecated();", ""),
 ("cf:setPaused not deployer-only", CF, "        if (msg.sender != deployer) revert NotDeployer();\n        paused = paused_;", "        paused = paused_;"),
 ("cf:isInstance not set", CF, "isInstance[instance] = true;", ""),
 # Launcher
 ("la:defaultReferrer not passed", LA, "                s.gate,\n                defaultReferrer", "                s.gate,\n                address(0)"),
 ("la:royalty fallback msg.sender", LA, "t.royaltyReceiver == address(0) ? t.owner : t.royaltyReceiver", "t.royaltyReceiver == address(0) ? msg.sender : t.royaltyReceiver"),
 ("la:payout fallback msg.sender", LA, "s.payoutRecipient == address(0) ? owner_ : s.payoutRecipient", "s.payoutRecipient == address(0) ? msg.sender : s.payoutRecipient"),
 ("la:nonce not incremented", LA, "keccak256(abi.encode(msg.sender, nonce++))", "keccak256(abi.encode(msg.sender, nonce))"),
 ("la:setDefaultReferrer not onlyOwner", LA, "function setDefaultReferrer(address defaultReferrer_) external onlyOwner {", "function setDefaultReferrer(address defaultReferrer_) external {"),
 # AllowlistGate
 ("ag:single-hash leaf", AG, "keccak256(bytes.concat(keccak256(abi.encode(to))))", "keccak256(abi.encode(to))"),
 ("ag:owner check removed", AG, "if (msg.sender != ISurface(collection).owner()) revert NotAuthorized();", ""),
 ("ag:empty data passes", AG, "if (r == bytes32(0) || data.length == 0) return false;", "if (data.length == 0) return true;\n        if (r == bytes32(0)) return false;"),
 ("ag:unset root passes", AG, "if (r == bytes32(0) || data.length == 0) return false;", "if (r == bytes32(0)) return true;\n        if (data.length == 0) return false;"),
]
results = []
for label, f, old, new in M:
    if FILTER and FILTER not in label: continue
    path = os.path.join(D, f)
    src = open(path).read()
    n = src.count(old)
    if n != 1:
        results.append((label, f"BAD-PATTERN({n})")); print(f"{label}: BAD PATTERN ({n})", flush=True); continue
    open(path, "w").write(src.replace(old, new))
    try:
        p = subprocess.run(["forge", "test", "--match-path", "test/surface/v2/**", "--fail-fast"], cwd=D,
                           capture_output=True, text=True, timeout=600)
        out = p.stdout + p.stderr
        if "Compiler run failed" in out: verdict = "killed(compile)"
        elif p.returncode != 0: verdict = "killed"
        else: verdict = "SURVIVED"
    finally:
        open(path, "w").write(src)
    results.append((label, verdict)); print(f"{label}: {verdict}", flush=True)
os.makedirs(os.path.join(D, "cache"), exist_ok=True)
json.dump(results, open(os.path.join(D, "cache", "mutation-results.json"), "w"), indent=1)
k = sum(1 for _, v in results if v.startswith("killed")); print(f"\nkilled {k}/{len(results)}")
sys.exit(0 if k == len(results) else 1)
