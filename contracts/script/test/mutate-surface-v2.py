#!/usr/bin/env python3
"""Run curated Surface v2 mutants against the complete v2 Foundry suite.

The script copies contracts into a temporary directory. It never edits the
checkout, and a compilation failure is not counted as a killed mutant.
Usage: cd contracts && python3 script/test/mutate-surface-v2.py --output /tmp/mutations.json
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SRC = "src/surface/v2/"


def mutant(name, file, old, new, note=""):
    return {"id": name, "file": SRC + file + ".sol", "old": old, "new": new, "note": note}


SALE = "FixedPriceSale"
TOKEN = "Surface"
FACTORY = "CloneFactory"
LAUNCHER = "Launcher"
GATE = "AllowlistGate"

MUTANTS = [
    mutant("sale_check_01_closed", SALE, "if (closed) revert SaleClosed();", "if (false && closed) revert SaleClosed();"),
    mutant("sale_check_02_start", SALE, "if (mintStart != 0 && block.timestamp < mintStart)", "if (false && mintStart != 0 && block.timestamp < mintStart)"),
    mutant("sale_check_02_end", SALE, "if (mintEnd != 0 && block.timestamp >= mintEnd)", "if (false && mintEnd != 0 && block.timestamp >= mintEnd)"),
    mutant("sale_check_03_max", SALE, "if (maxMints != 0 && minted + quantity > maxMints)", "if (false && maxMints != 0 && minted + quantity > maxMints)"),
    mutant("sale_check_04_gate", SALE, "if (gate != address(0) && !IGate(gate).check", "if (false && gate != address(0) && !IGate(gate).check"),
    mutant("sale_check_05_wallet", SALE, "if (walletCap != 0 && mintedByTo + quantity > walletCap)", "if (false && walletCap != 0 && mintedByTo + quantity > walletCap)"),
    mutant("sale_check_06_payment", SALE, "if (msg.value != paid) revert WrongPayment", "if (false && msg.value != paid) revert WrongPayment"),
    mutant("sale_check_07_receiver", SALE, "if (to.code.length != 0) _checkReceiver", "if (false && to.code.length != 0) _checkReceiver"),
    mutant("sale_check_08_mint", SALE, "uint256 firstTokenId = ISurface(collection_).mintTo(to, quantity);", "uint256 firstTokenId = 0;"),
    mutant("sale_check_09_count", SALE, "totalMinted = minted + quantity;", "totalMinted = minted;"),
    mutant("sale_check_10_settle", SALE, "if (paid != 0) {", "if (false && paid != 0) {"),
    mutant("sale_reorder_03_05", SALE,
           "if (maxMints != 0 && minted + quantity > maxMints) revert MaxMintsExceeded(maxMints, minted + quantity); // 3\n        address collection_ = collection;\n        if (gate != address(0) && !IGate(gate).check(collection_, to, quantity, data)) revert GateRejected(); // 4\n        uint256 mintedByTo = mintedBy[to];\n        if (walletCap != 0 && mintedByTo + quantity > walletCap) {\n            revert WalletCapExceeded(walletCap, mintedByTo + quantity); // 5\n        }",
           "uint256 mintedByTo = mintedBy[to];\n        if (walletCap != 0 && mintedByTo + quantity > walletCap) {\n            revert WalletCapExceeded(walletCap, mintedByTo + quantity);\n        }\n        address collection_ = collection;\n        if (gate != address(0) && !IGate(gate).check(collection_, to, quantity, data)) revert GateRejected();\n        if (maxMints != 0 && minted + quantity > maxMints) revert MaxMintsExceeded(maxMints, minted + quantity);"),
    mutant("sale_minted_by_dropped", SALE, "mintedBy[to] = mintedByTo + quantity;", "mintedBy[to] = mintedByTo;"),
    mutant("sale_minted_by_only_when_capped", SALE, "mintedBy[to] = mintedByTo + quantity;", "if (walletCap != 0) mintedBy[to] = mintedByTo + quantity;"),
    mutant("sale_referral_wrong_base", SALE, "(paid * REFERRAL_SHARE_BPS) / BPS", "(price * REFERRAL_SHARE_BPS) / BPS"),
    mutant("sale_referral_wrong_party", SALE, "_pending[referrer] += referral;", "_pending[payoutRecipient] += referral;"),
    mutant("sale_referral_share", SALE, "REFERRAL_SHARE_BPS = 500", "REFERRAL_SHARE_BPS = 501"),
    mutant("sale_withdraw_to_caller", SALE, "_withdraw(account, account);", "_withdraw(account, msg.sender);"),
    mutant("sale_withdraw_to_wrong_balance", SALE, "_withdraw(msg.sender, to);", "_withdraw(to, to);"),
    mutant("sale_close_reversible", SALE, "closed = true;", "closed = !closed;"),
    mutant("sale_init_without_minter_path", SALE, "ISurface(collection_).minter() != address(this) && msg.sender != ISurface(collection_).owner()", "msg.sender != ISurface(collection_).owner()"),
    mutant("sale_init_without_owner_path", SALE, "ISurface(collection_).minter() != address(this) && msg.sender != ISurface(collection_).owner()", "ISurface(collection_).minter() != address(this)"),
    mutant("sale_init_paths_and", SALE, "ISurface(collection_).minter() != address(this) && msg.sender != ISurface(collection_).owner()", "ISurface(collection_).minter() != address(this) || msg.sender != ISurface(collection_).owner()"),
    mutant("surface_minter_authority", TOKEN, "if (msg.sender != minter) revert NotMinter();", "if (false && msg.sender != minter) revert NotMinter();"),
    mutant("surface_cap_off_by_one", TOKEN, "mintedEver + quantity > cap", "mintedEver + quantity >= cap"),
    mutant("surface_minted_ever_dropped", TOKEN, "_mintedEver = mintedEver + quantity;", "_mintedEver = mintedEver;"),
    mutant("surface_seed_recipient", TOKEN, "abi.encode(block.prevrandao, address(this), tokenId)", "abi.encode(block.prevrandao, address(this), tokenId, to)"),
    mutant("surface_seed_no_token_id", TOKEN, "abi.encode(block.prevrandao, address(this), tokenId)", "abi.encode(block.prevrandao, address(this))"),
    mutant("surface_burn_without_auth", TOKEN, "_update(address(0), tokenId, msg.sender);", "_update(address(0), tokenId, address(0));"),
    mutant("surface_burn_count_dropped", TOKEN, "_burnedCount += 1;", "_burnedCount += 0;"),
    mutant("surface_self_custody_dropped", TOKEN, "if (to == address(this)) revert SelfCustodyRejected();", "if (false && to == address(this)) revert SelfCustodyRejected();"),
    mutant("surface_cap_floor_dropped", TOKEN, "if (supplyCap_ != 0 && supplyCap_ < mintedEver)", "if (false && supplyCap_ != 0 && supplyCap_ < mintedEver)"),
    mutant("surface_notify_widened", TOKEN, "if (msg.sender != renderer && msg.sender != owner())", "if (false && msg.sender != renderer && msg.sender != owner())"),
    mutant("factory_init_selector_dropped", FACTORY, "if (selector != initSelector) revert NotInitializer(selector);", "if (false && selector != initSelector) revert NotInitializer(selector);"),
    mutant("factory_create_salt_not_namespaced", FACTORY, "abi.encode(caller, \"create\", nonce)", "abi.encode(\"create\", nonce)"),
    mutant("factory_create_nonce_dropped", FACTORY, "createNonce[msg.sender]++", "createNonce[msg.sender]"),
    mutant("factory_instance_before_init", FACTORY, "Address.functionCall(instance, initData);\n        isInstance[instance] = true;", "isInstance[instance] = true;\n        Address.functionCall(instance, initData);", "A collection called by sale initialization can observe premature registration."),
    mutant("launcher_default_referrer_dropped", LAUNCHER, "defaultReferrer\n            )", "address(0)\n            )"),
    {"id": "launcher_royalty_fallback_caller", "file": SRC + LAUNCHER + ".sol", "note": "",
     "edits": [
         ("function _tokenInit(TokenParams calldata t, address minter) internal pure", "function _tokenInit(TokenParams calldata t, address minter) internal view"),
         ("t.royaltyReceiver == address(0) ? t.owner : t.royaltyReceiver", "t.royaltyReceiver == address(0) ? msg.sender : t.royaltyReceiver"),
     ]},
    mutant("launcher_payout_fallback_caller", LAUNCHER, "s.payoutRecipient == address(0) ? owner_ : s.payoutRecipient", "s.payoutRecipient == address(0) ? msg.sender : s.payoutRecipient"),
    mutant("gate_single_hash_leaf", GATE, "keccak256(bytes.concat(keccak256(abi.encode(to))))", "keccak256(abi.encode(to))"),
    mutant("gate_owner_check_dropped", GATE, "if (msg.sender != ISurface(collection).owner())", "if (false && msg.sender != ISurface(collection).owner())"),
    mutant("gate_empty_data_true", GATE, "if (r == bytes32(0) || data.length == 0) return false;", "if (r == bytes32(0) || data.length == 0) return true;"),
]

for setter in ("setPrice", "setMintWindow", "setMaxMints", "setWalletCap", "setPayoutRecipient", "setGate", "close"):
    pattern = re.compile(r"(function " + setter + r"\([^)]*\) external) onlyCollectionOwner")
    MUTANTS.append({"id": "sale_auth_" + setter, "file": SRC + SALE + ".sol", "regex": pattern, "new": r"\1", "note": ""})

for setter in ("setRenderer", "setMinter", "setSupplyCap", "setRoyalty", "setName"):
    pattern = re.compile(r"(function " + setter + r"\([^)]*\) external override) onlyOwner")
    MUTANTS.append({"id": "surface_auth_" + setter, "file": SRC + TOKEN + ".sol", "regex": pattern, "new": r"\1", "note": ""})


def apply_mutant(path, mutation):
    original = path.read_text()
    if "regex" in mutation:
        changed, count = mutation["regex"].subn(mutation["new"], original)
    elif "edits" in mutation:
        changed = original
        for old, new in mutation["edits"]:
            if changed.count(old) != 1:
                raise ValueError(f"{mutation['id']}: expected exactly one source match for {old!r}")
            changed = changed.replace(old, new, 1)
        count = 1
    else:
        count = original.count(mutation["old"])
        changed = original.replace(mutation["old"], mutation["new"], 1)
    if count != 1 or changed == original:
        raise ValueError(f"{mutation['id']}: expected exactly one source match, got {count}")
    path.write_text(changed)
    return original


def run_forge(cwd, timeout):
    started = time.monotonic()
    try:
        run = subprocess.run(
            ["forge", "test", "--match-path", "test/surface/v2/**", "--summary"],
            cwd=cwd,
            env={**os.environ, "FOUNDRY_PROFILE": "default"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = run.stdout
        if run.returncode == 0:
            status = "survived"
        elif re.search(r"Compiler run failed|Compilation failed|Error \([0-9]+\):|Error: Compiler", output):
            status = "compile_error"
        elif re.search(r"^\[FAIL", output, flags=re.MULTILINE):
            status = "killed"
        else:
            status = "harness_error"
        return status, run.returncode, output, round(time.monotonic() - started, 2)
    except subprocess.TimeoutExpired as error:
        return "timeout", None, str(error), round(time.monotonic() - started, 2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ids", nargs="*", help="Run only the named mutants")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--keep-workdir", action="store_true")
    args = parser.parse_args()
    selected = [m for m in MUTANTS if args.ids is None or m["id"] in args.ids]
    if args.ids is not None and len(selected) != len(set(args.ids)):
        parser.error("unknown or duplicate mutant id")
    if not selected:
        parser.error("no mutants selected")

    temp = tempfile.mkdtemp(prefix="surface-v2-mutation-")
    work = Path(temp) / "contracts"
    try:
        # Copy only build inputs. A copied Foundry cache can silently reuse
        # unmutated bytecode, and deployment credentials never belong here.
        work.mkdir()
        ignore = shutil.ignore_patterns(".env", ".env.*", "out", "cache", "broadcast", ".git")
        for directory in ("src", "test", "script", "lib"):
            shutil.copytree(ROOT / directory, work / directory, symlinks=True, ignore=ignore)
        for filename in ("foundry.toml", "deployments.mainnet.json", "deployments.sepolia.json", "deployments.anvil.json"):
            source = ROOT / filename
            if source.exists():
                shutil.copy2(source, work / filename)
        results = []
        for index, mutation in enumerate(selected, start=1):
            path = work / mutation["file"]
            original = apply_mutant(path, mutation)
            try:
                status, exit_code, output, seconds = run_forge(work, args.timeout)
            finally:
                path.write_text(original)
            failed_tests = re.findall(r"^\[FAIL[^\]]*\] ([^\n]+)", output, flags=re.MULTILINE)
            result = {"id": mutation["id"], "file": mutation["file"], "status": status,
                      "exit_code": exit_code, "seconds": seconds, "failed_tests": failed_tests,
                      "note": mutation["note"], "tail": output[-1200:]}
            results.append(result)
            print(f"[{index:02}/{len(selected)}] {mutation['id']}: {status} ({seconds:.1f}s)", flush=True)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            killed = sum(r["status"] == "killed" for r in results)
            survived = sum(r["status"] == "survived" for r in results)
            report = {"revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT.parent, text=True).strip(),
                      "command": "forge test --match-path 'test/surface/v2/**' --summary",
                      "score": {"killed": killed, "survived": survived,
                                "percent": round(100 * killed / (killed + survived), 2) if killed + survived else None},
                      "results": results}
            args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(f"Score: {killed}/{killed + survived} = {report['score']['percent']}%", flush=True)
        print(f"Report: {args.output}", flush=True)
        invalid = [r["id"] for r in results if r["status"] not in ("killed", "survived")]
        if invalid:
            raise SystemExit(f"Invalid mutant runs (not scored): {', '.join(invalid)}")
    finally:
        if args.keep_workdir:
            print(f"Temporary workdir: {work}")
        else:
            shutil.rmtree(temp)


if __name__ == "__main__":
    main()
