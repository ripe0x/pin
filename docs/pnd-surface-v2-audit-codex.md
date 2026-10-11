# Surface v2 audit

Commit reviewed: `34f2a43b893aea8ae3857b9e48f59de788f95f8c`.

| Severity | Title | Status |
| --- | --- | --- |
| Low | Verification API key is exposed in the deployment process arguments | Open |

## Findings

### Low: Verification API key is exposed in the deployment process arguments

Location: `contracts/script/deploy.sh:208` at commit `34f2a43b`.

The verification branch constructs the Forge command with
`--etherscan-api-key "$ETHERSCAN_API_KEY"`. Shell argument lists are visible to
other local users through process inspection and are commonly captured by CI
process telemetry. The wrapper also accepts its API key only through an
environment variable, so passing it back into argv defeats that boundary.

Impact: an observer of the host process list or CI command telemetry can obtain
the Etherscan API key. This does not change deployed contract state, but it can
allow use of the project's Etherscan quota and any account capability attached
to that key.

Reproduction: `DeployWrapperSecretsAuditTest.test_deployWrapper_doesNotPassEtherscanApiKeyInArgv` in
`contracts/test/surface/v2/audit/DeployWrapperSecrets.t.sol` fails on the
reviewed code. Run:

```bash
cd contracts
forge test --match-path 'test/surface/v2/audit/DeployWrapperSecrets.t.sol' --ffi -vvv
```

The trace returns `unsafe` because `rg` finds `--etherscan-api-key` in the
wrapper, then the assertion reverts.

Recommendation: keep the key in the environment and configure Foundry to read
it there, rather than supplying `--etherscan-api-key`. Apply the same rule to
any credential-bearing RPC URL: do not pass it as `--rpc-url` or print it.

## Scope invariants

| Invariant | Verdict | Supporting test |
| --- | --- | --- |
| Sequential ids equal mint order, are monotonic, and are never reused after burn. | Holds. | `SurfaceV2Invariants.invariant_idsAreExactlyOneToMintedEver`, `SurfaceV2Test.test_mintTo_batchIdsContinueFromMintedEver` |
| Mints-ever cap applies to both mint paths and burns do not restore capacity. | Holds. | `SurfaceV2Invariants.invariant_mintsNeverExceedCap`, `SurfaceV2SeedTest.test_mintToSeeded_capEnforced` |
| Seal engages all locks, then renounces ownership, and no-minter seal ends minting. | Holds. | `SurfaceV2SealTest.test_seal_engagesAllLocksAndRenounces`, `SurfaceV2SealTest.test_seal_withNoMinters_endsMintingForever` |
| Default seed derivation, seed-source fallback, and supplied-seed precedence are correct. | Holds. | `SurfaceV2SeedTest.test_seed_defaultDerivation`, `test_seedSource_minterSuppliedSeedWinsOverSource` |
| Self-custody is rejected without changing normal transfers or burns. | Holds. | `SurfaceV2TransferTest.test_transferFrom_toSelf_reverts`, `test_burn_unaffected` |
| Ownership transfer or renounce invalidates all existing admin grants. | Holds. | `SurfaceV2Test.test_adminGrant_expiresOnOwnershipTransfer` |
| Royalty is capped at 5,000 bps and lock snapshots a zero receiver. | Holds. | `SurfaceV2Test.test_royaltyInfo`, `SurfaceV2SealTest.test_lockRoyalty_zeroReceiver_snapshotsOwner_survivesTransfer` |
| Fixed-price settlement requires exact payment and conserves pull-payment balances. | Holds. | `FixedPriceMinterV2Test.test_fixedPrice_overpayment_reverts`, `FixedPriceMinterV2Invariants.invariant_pendingSumMatchesPaidInMinusWithdrawn` |

The default profile passed 792 tests. The invariant profile passed both v2
state-machine suites at 512 runs and depth 100. The audit reproducer above is
intentionally failing and is excluded from those passing results.

## Residual risks and assumptions

`seedSource` is immutable. A source that permanently reverts makes
`tokenSeed` and renderers that depend on it unavailable for tokens without a
stored seed. This is an accepted design constraint.

An owner-authorized custom minter can supply duplicate nonzero seeds. The core
does not enforce seed uniqueness. This is an accepted responsibility of that
minter.

Locking a renderer locks only its address. A mutable renderer at that address
can still change rendered output. Factory constructor addresses, the Catalog,
and artist-authorized custom minters are trusted deployment inputs.

This review covered the requested v2 Solidity contracts, interfaces, and
deployment path. It did not audit v1 implementations, renderer internals,
Catalog internals, the studio application, deployment infrastructure, private
key custody, compiler or RPC provider behavior, or production configuration.

## Verdict

No Critical or High finding requires a contract fix before mainnet deployment.
The Low deployment-secret handling defect should be fixed before a real
production broadcast, because the stated deployment requirement forbids
placing a secret in argv.
