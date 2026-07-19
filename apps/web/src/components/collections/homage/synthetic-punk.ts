"use client"

// Generate a NOVEL punk (not one of the 10k) for the pre-deploy sample wall: pick a head
// and compatible accessories in the collection's real ratios, sum the colors each trait
// contributes (precomputed offline into homage-traits.json — see scripts/build-homage-traits.mjs)
// into a pixel histogram, and render the homage through the shared distill/rings/svg pipeline.
// So the colors are coherent with the generated traits, the full trait list is real, and no
// SDK / punk pixels are loaded at runtime — only the ~10KB trait table.

import {useEffect, useState} from "react"
import {distill, groundForStatus, rings, svg} from "@/components/mint/homage-gallery/render"
import {anySvgToSrc} from "@/components/mint/homage-gallery/svg"

// [rgb, avgPixelCount] per color the trait contributes.
type Profile = {name: string; supply: number; colors: [number, number][]}
type TraitTable = {
  heads: Profile[]
  accessories: Profile[]
  incompatible: number[][] // per-accessory: indices that never co-occur (mutually exclusive)
  attrCounts: [number, number][] // [accessoryCount, supply]
}

let tablePromise: Promise<TraitTable> | null = null
function loadTable(): Promise<TraitTable> {
  tablePromise ??= fetch("/data/homage-traits.json").then((r) => {
    if (!r.ok) {
      tablePromise = null // let a transient failure retry
      throw new Error(`trait table ${r.status}`)
    }
    return r.json() as Promise<TraitTable>
  })
  return tablePromise
}

// Deterministic PRNG: one seed per tile, stable across re-renders; Regenerate hands out
// fresh seeds.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function weightedIndex(weights: number[], rng: () => number): number {
  let total = 0
  for (const w of weights) total += w
  let r = rng() * total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]
    if (r < 0) return i
  }
  return weights.length - 1
}

// A histogram of {rgb -> pixel count} laid into a 576-pixel image (rest transparent), so the
// existing distill (merge near shades, cap rings, rec ordering) processes it identically to a
// real punk's pixels. Spatial position is irrelevant — distill only counts colors.
function histToImage(hist: Map<number, number>): Uint8Array {
  const img = new Uint8Array(2304)
  const entries = [...hist.entries()]
  let sum = 0
  for (const [, c] of entries) sum += c
  if (sum <= 0) return img
  const budget = Math.min(576, Math.max(1, Math.round(sum)))
  let p = 0
  for (const [rgb, cnt] of entries) {
    let px = Math.round((cnt / sum) * budget)
    while (px-- > 0 && p < 576) {
      const o = p * 4
      img[o] = (rgb >> 16) & 255
      img[o + 1] = (rgb >> 8) & 255
      img[o + 2] = rgb & 255
      img[o + 3] = 255
      p++
    }
  }
  return img
}

export type GeneratedPunk = {svg: string; colorCount: number; traits: string[]}

function assemble(
  table: TraitTable,
  seed: number,
  opts: {status?: number; sizePx?: number},
): GeneratedPunk {
  const rng = mulberry32(seed)
  const head = table.heads[weightedIndex(table.heads.map((h) => h.supply), rng)]
  const k = table.attrCounts[weightedIndex(table.attrCounts.map((a) => a[1]), rng)][0]

  // Pick k accessories by supply, skipping any incompatible with an already-chosen one.
  const accWeights = table.accessories.map((a) => a.supply)
  const chosen: number[] = []
  const forbidden = new Set<number>()
  for (let attempts = 0; chosen.length < k && attempts < k * 12 + 8; attempts++) {
    const idx = weightedIndex(accWeights, rng)
    if (chosen.includes(idx) || forbidden.has(idx)) continue
    chosen.push(idx)
    for (const f of table.incompatible[idx]) forbidden.add(f)
  }

  const hist = new Map<number, number>()
  const add = (p: Profile) => {
    for (const [rgb, cnt] of p.colors) hist.set(rgb, (hist.get(rgb) ?? 0) + cnt)
  }
  add(head)
  const accNames: string[] = []
  for (const idx of chosen) {
    add(table.accessories[idx])
    accNames.push(table.accessories[idx].name)
  }

  const {cols, cnts} = distill(histToImage(hist))
  const order = rings(cols, cnts)
  let s = svg(groundForStatus(opts.status ?? 0), order, false)
  if (opts.sizePx) s = s.replace("<svg ", `<svg width="${opts.sizePx}" height="${opts.sizePx}" `)
  return {svg: s, colorCount: cols.length, traits: [head.name, ...accNames]}
}

/** Wall tile — a generated homage src. */
export function useGeneratedArt(seed: number, status = 0, sizePx?: number) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    let cancelled = false
    loadTable()
      .then((t) => {
        if (!cancelled) setSrc(anySvgToSrc(assemble(t, seed, {status, sizePx}).svg))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [seed, status, sizePx])
  return {src}
}

/** Detail overlay — generated homage src + its full trait list and color count. */
export function useGeneratedSample(seed: number, status = 0, sizePx?: number) {
  const [state, setState] = useState<{
    src?: string
    traits?: string[]
    colorCount?: number
    isLoading: boolean
  }>({isLoading: true})
  useEffect(() => {
    let cancelled = false
    setState((s) => ({...s, isLoading: true}))
    loadTable()
      .then((t) => {
        if (cancelled) return
        const g = assemble(t, seed, {status, sizePx})
        setState({src: anySvgToSrc(g.svg), traits: g.traits, colorCount: g.colorCount, isLoading: false})
      })
      .catch(() => {
        if (!cancelled) setState({isLoading: false})
      })
    return () => {
      cancelled = true
    }
  }, [seed, status, sizePx])
  return state
}
