"use client"

import { useEffect, useState } from "react"
import { decodeEventLog, isAddress } from "viem"
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import {
  erc721Abi,
  sovereignAuctionHouseAbi,
  sovereignAuctionHouseV2Abi,
} from "@pin/abi"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import { parseListingExpiry } from "@/lib/listing-expiry"
import { useChainNowSec } from "@/components/tx/tx-ui"
import { TxLink } from "./tx"

const DURATION_OPTIONS = [
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "3 days", seconds: 3 * 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const

/**
 * Shared "approve + create" auction form body. Two-step flow:
 *   1. setApprovalForAll(houseAddress, true) on the token contract (skipped
 *      if already approved). ERC721 and ERC1155 share the
 *      setApprovalForAll/isApprovedForAll selectors, so the ERC721 ABI
 *      fragments serve both.
 *   2. createAuction(tokenId, contract, duration, reserve, listingExpiry) on
 *      the artist's house, or create1155Auction(tokenId, contract, quantity,
 *      duration, reserve, listingExpiry) for an ERC1155 lot. 1155 lots need
 *      a V2 house. Listing expiry and funds recipient are V2-only optional
 *      fields; a V1 house always gets listingExpiry 0 and no recipient call.
 *
 * Renders just the form fields + step buttons + tx feedback — no chrome. Used
 * inline on /auction/new and inside the modal wrapper on token detail pages.
 */
export function AuctionTermsForm({
  houseAddress,
  houseVersion = 1,
  nftContract,
  tokenId,
  tokenStandard = "erc721",
  maxQuantity,
  onSuccess,
}: {
  houseAddress: `0x${string}`
  houseVersion?: 1 | 2
  nftContract: `0x${string}`
  tokenId: string
  tokenStandard?: "erc721" | "erc1155"
  /** Owner's ERC1155 balance for this id; caps the lot size input. */
  maxQuantity?: bigint
  onSuccess?: (createTxHash: `0x${string}`) => void
}) {
  const { address } = useAccount()
  const reserve = useEthAmountInput()
  const [durationSec, setDurationSec] = useState<number>(DURATION_OPTIONS[0].seconds)
  const [quantityInput, setQuantityInput] = useState("1")
  const is1155 = tokenStandard === "erc1155"
  const quantity = /^[0-9]+$/.test(quantityInput) ? BigInt(quantityInput) : null
  const quantityValid =
    !is1155 ||
    (quantity !== null &&
      quantity > 0n &&
      (maxQuantity === undefined || quantity <= maxQuantity))

  // V2-only optional listing terms. A blank expiry means none (0n); a blank
  // recipient means the seller stays the funds recipient (the contract
  // default) and no follow-up call is made.
  const nowSec = useChainNowSec()
  const [listingExpiryInput, setListingExpiryInput] = useState("")
  const listingExpiry = parseListingExpiry(listingExpiryInput, nowSec)
  const [fundsRecipientInput, setFundsRecipientInput] = useState("")
  const trimmedRecipient = fundsRecipientInput.trim()
  const fundsRecipientValid = trimmedRecipient === "" || isAddress(trimmedRecipient)

  const { data: isApprovedForAll, refetch: refetchApproval } = useReadContract({
    address: nftContract,
    abi: erc721Abi,
    functionName: "isApprovedForAll",
    args: address ? [address, houseAddress] : undefined,
    query: { enabled: !!address },
  })

  const {
    writeContract: writeApprove,
    data: approveHash,
    isPending: isApprovePending,
    error: approveError,
  } = useWriteContract()
  const {
    isLoading: isApproveMining,
    isSuccess: isApproveSuccess,
    data: approveReceipt,
  } = useWaitForTransactionReceipt({ hash: approveHash })
  const approveReverted = approveReceipt?.status === "reverted"
  useEffect(() => {
    if (isApproveSuccess) refetchApproval()
  }, [isApproveSuccess, refetchApproval])

  const {
    writeContract: writeCreate,
    data: createHash,
    isPending: isCreatePending,
    error: createError,
  } = useWriteContract()
  const {
    isLoading: isCreateMining,
    isSuccess: isCreateSuccess,
    data: createReceipt,
  } = useWaitForTransactionReceipt({ hash: createHash })
  const createReverted = createReceipt?.status === "reverted"
  useEffect(() => {
    if (isCreateSuccess && createHash && onSuccess) onSuccess(createHash)
  }, [isCreateSuccess, createHash, onSuccess])

  // If a non-default funds recipient was entered, fire it as a follow-up
  // setAuctionFundsRecipient call once the create tx confirms, neither
  // createAuction nor create1155Auction takes a recipient argument. The
  // auction id comes from decoding the confirmed receipt's own
  // AuctionCreated/Auction1155Created log rather than an extra chain read.
  const {
    writeContract: writeRecipient,
    data: recipientHash,
    isPending: isRecipientPending,
    error: recipientError,
  } = useWriteContract()
  const { isLoading: isRecipientMining, isSuccess: isRecipientSuccess } =
    useWaitForTransactionReceipt({ hash: recipientHash })
  useEffect(() => {
    if (!isCreateSuccess || !createReceipt || trimmedRecipient === "" || recipientHash) return
    if (!isAddress(trimmedRecipient)) return
    const log = createReceipt.logs
      .map((l) => {
        try {
          return decodeEventLog({
            abi: sovereignAuctionHouseV2Abi,
            data: l.data,
            topics: l.topics,
          })
        } catch {
          return null
        }
      })
      .find((e) => e?.eventName === "AuctionCreated" || e?.eventName === "Auction1155Created")
    const auctionId = (log?.args as { auctionId?: bigint } | undefined)?.auctionId
    if (auctionId === undefined) return
    writeRecipient({
      address: houseAddress,
      abi: sovereignAuctionHouseV2Abi,
      functionName: "setAuctionFundsRecipient",
      args: [auctionId, trimmedRecipient as `0x${string}`],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCreateSuccess, createReceipt, recipientHash])

  const reserveValid = reserve.isValid && reserve.wei !== null
  const isNoReserve = reserve.wei === 0n
  const listingTermsValid =
    houseVersion !== 2 || (listingExpiry.error === null && fundsRecipientValid)

  function handleApprove() {
    writeApprove({
      address: nftContract,
      abi: erc721Abi,
      functionName: "setApprovalForAll",
      args: [houseAddress, true],
    })
  }

  function handleCreate() {
    if (!reserveValid || reserve.wei == null || !quantityValid || !listingTermsValid) return
    const listingExpirySeconds = houseVersion === 2 ? listingExpiry.seconds ?? 0n : 0n
    if (is1155) {
      if (quantity === null) return
      writeCreate({
        address: houseAddress,
        abi: sovereignAuctionHouseV2Abi,
        functionName: "create1155Auction",
        args: [
          BigInt(tokenId),
          nftContract,
          quantity,
          BigInt(durationSec),
          reserve.wei,
          listingExpirySeconds,
        ],
      })
      return
    }
    if (houseVersion === 2) {
      writeCreate({
        address: houseAddress,
        abi: sovereignAuctionHouseV2Abi,
        functionName: "createAuction",
        args: [
          BigInt(tokenId),
          nftContract,
          BigInt(durationSec),
          reserve.wei,
          listingExpirySeconds,
        ],
      })
      return
    }
    writeCreate({
      address: houseAddress,
      abi: sovereignAuctionHouseAbi,
      functionName: "createAuction",
      args: [
        BigInt(tokenId),
        nftContract,
        BigInt(durationSec),
        reserve.wei,
      ],
    })
  }

  const needsApproval = !isApprovedForAll
  const approveBusy = isApprovePending || isApproveMining
  const createBusy = isCreatePending || isCreateMining

  // create1155Auction only exists on V2 houses.
  if (is1155 && houseVersion !== 2) {
    return (
      <p className="text-sm text-gray-600">
        ERC-1155 lots need a V2 auction house. Upgrade your house from the
        studio migrate page, then list this token.
      </p>
    )
  }

  if (isCreateSuccess && createHash) {
    const wantsRecipient = trimmedRecipient !== "" && isAddress(trimmedRecipient)
    return (
      <div className="space-y-4">
        <div className="rounded border border-emerald-200 bg-emerald-50 p-3 space-y-2">
          <p className="text-sm font-medium text-emerald-900">
            Auction created ✓
          </p>
          <TxLink hash={createHash} label="Create tx:" />
        </div>
        {wantsRecipient && (
          <div className="rounded border border-gray-200 bg-surface p-3 space-y-1">
            <p className="text-xs text-gray-600">
              {isRecipientSuccess
                ? "Funds recipient set ✓"
                : isRecipientPending
                  ? "Confirm the funds recipient in your wallet…"
                  : isRecipientMining
                    ? "Setting funds recipient…"
                    : "Setting funds recipient…"}
            </p>
            {recipientHash && <TxLink hash={recipientHash} label="Recipient tx:" />}
            {recipientError && (
              <p className="text-xs text-red-500 break-words">
                {recipientError.message.includes("User rejected")
                  ? "Transaction rejected"
                  : recipientError.message.split("\n")[0]}
              </p>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">
            Reserve price
          </span>
          <div className="mt-1 flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors rounded">
            <input
              {...reserve.inputProps}
              placeholder="0.5"
              disabled={createBusy}
              className="flex-1 px-3 py-2.5 text-base font-medium outline-none disabled:opacity-40 bg-transparent"
            />
            <span className="flex items-center px-3 text-sm text-gray-400 border-l border-gray-200">
              ETH
            </span>
          </div>
        </label>
        {reserve.error ? (
          <p className="text-xs text-red-500">{reserve.error}</p>
        ) : (
          <p className="text-xs text-gray-400">
            {isNoReserve
              ? "No reserve — any bid wins. Timer starts on first bid."
              : "Auction starts on the first bid at or above this price."}
          </p>
        )}
      </div>

      {is1155 && (
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">
              Lot size
            </span>
            <div className="mt-1 flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors rounded">
              <input
                value={quantityInput}
                onChange={(e) => setQuantityInput(e.target.value.trim())}
                inputMode="numeric"
                disabled={createBusy}
                className="flex-1 px-3 py-2.5 text-base font-medium outline-none disabled:opacity-40 bg-transparent"
              />
              <span className="flex items-center px-3 text-sm text-gray-400 border-l border-gray-200">
                editions
              </span>
            </div>
          </label>
          {!quantityValid ? (
            <p className="text-xs text-red-500">
              Enter a whole number
              {maxQuantity !== undefined
                ? ` between 1 and ${maxQuantity.toString()} (your balance)`
                : " of 1 or more"}
              .
            </p>
          ) : (
            <p className="text-xs text-gray-400">
              The whole lot sells to one winner. The winner must bid from a
              regular wallet address, not a smart contract wallet.
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <span className="text-xs uppercase tracking-wider text-gray-500 block">
          Duration
        </span>
        <div className="grid grid-cols-3 gap-2">
          {DURATION_OPTIONS.map((opt) => (
            <button
              key={opt.seconds}
              onClick={() => setDurationSec(opt.seconds)}
              disabled={createBusy}
              className={`py-2 text-sm border rounded transition-colors ${
                durationSec === opt.seconds
                  ? "border-fg bg-fg text-bg"
                  : "border-gray-200 hover:border-gray-400"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {houseVersion === 2 && (
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">
              Listing expiry (optional)
            </span>
            <input
              type="datetime-local"
              value={listingExpiryInput}
              onChange={(e) => setListingExpiryInput(e.target.value)}
              disabled={createBusy}
              className="mt-1 w-full border border-gray-200 focus-within:border-gray-400 transition-colors rounded px-3 py-2 text-sm outline-none disabled:opacity-40 bg-transparent"
            />
          </label>
          {listingExpiry.error ? (
            <p className="text-xs text-red-500">{listingExpiry.error}</p>
          ) : (
            <p className="text-xs text-gray-400">
              No bids by this time and the listing can be expired by anyone.
              Leave blank for no expiry.
            </p>
          )}
        </div>
      )}

      {houseVersion === 2 && (
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">
              Funds recipient (optional)
            </span>
            <input
              type="text"
              value={fundsRecipientInput}
              onChange={(e) => setFundsRecipientInput(e.target.value)}
              placeholder="0x…, defaults to you"
              disabled={createBusy}
              className="mt-1 w-full border border-gray-200 focus-within:border-gray-400 transition-colors rounded px-3 py-2 text-sm font-mono outline-none disabled:opacity-40 bg-transparent"
            />
          </label>
          {!fundsRecipientValid ? (
            <p className="text-xs text-red-500">Enter a valid address.</p>
          ) : (
            <p className="text-xs text-gray-400">
              Where sale proceeds land. Defaults to you. Set as a follow-up
              transaction right after the auction is created.
            </p>
          )}
        </div>
      )}

      {needsApproval ? (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            Step 1 of 2: approve your auction house to escrow this NFT
            during the auction. One-time per collection.
          </p>
          <button
            onClick={handleApprove}
            disabled={approveBusy}
            className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isApprovePending
              ? "Confirm in wallet…"
              : isApproveMining
                ? "Approving…"
                : "Approve auction house"}
          </button>
          {approveHash && isApproveMining && (
            <TxLink hash={approveHash} label="Pending tx:" />
          )}
          {approveReverted && approveHash && (
            <div className="rounded border border-red-200 bg-red-50 p-2.5 space-y-1">
              <p className="text-xs font-medium text-red-700">
                Approve reverted on-chain
              </p>
              <TxLink hash={approveHash} label="Reverted tx:" />
            </div>
          )}
          {approveError && (
            <p className="text-xs text-red-500 break-words">
              {approveError.message.includes("User rejected")
                ? "Transaction rejected"
                : approveError.message.split("\n")[0]}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {isApproveSuccess && approveHash && (
            <div className="rounded border border-emerald-200 bg-emerald-50 p-2.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-emerald-900">
                Approved ✓
              </span>
              <TxLink hash={approveHash} label="Approve tx:" />
            </div>
          )}
          <button
            onClick={handleCreate}
            disabled={createBusy || !reserveValid || !quantityValid || !listingTermsValid}
            className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isCreatePending
              ? "Confirm in wallet…"
              : isCreateMining
                ? "Creating auction…"
                : "Start auction"}
          </button>
          {createHash && isCreateMining && (
            <TxLink hash={createHash} label="Pending tx:" />
          )}
          {createReverted && createHash && (
            <div className="rounded border border-red-200 bg-red-50 p-2.5 space-y-1">
              <p className="text-xs font-medium text-red-700">
                Create reverted on-chain
              </p>
              <p className="text-xs text-red-700/80">
                Likely cause: you don&apos;t own this token, or the house isn&apos;t approved.
              </p>
              <TxLink hash={createHash} label="Reverted tx:" />
            </div>
          )}
          {createError && (
            <p className="text-xs text-red-500 break-words">
              {createError.message.includes("User rejected")
                ? "Transaction rejected"
                : createError.message.split("\n")[0]}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
