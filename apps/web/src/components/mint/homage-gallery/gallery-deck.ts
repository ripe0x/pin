// Deck logic for the anonymized gallery (/gallery, /gallery/one): a shuffled walk through the
// whole 10k collection with punk ids withheld from the UI. The deck deals without replacement,
// so a session never repeats a work until all ten thousand have been shown. Grounds are dealt
// with weights that roughly mirror the real market (most punks at rest, many wrapped, a few
// listed or under bid), so the wall reads like the collection actually would.
//
// Client-only (Math.random): callers must deal from an effect, never during SSR render.

export type Piece = { id: number; status: number };

/** All 10,000 ids, Fisher-Yates shuffled. */
export function shuffledIds(): number[] {
  const a = Array.from({ length: 10_000 }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A ground status dealt at market-ish weights: 70% at rest, 17% wrapped, 7% listed, 6% bid. */
export function weightedStatus(): number {
  const r = Math.random() * 100;
  return r < 70 ? 0 : r < 87 ? 1 : r < 94 ? 2 : 3;
}

/** Quilt spans for the wall: mostly 1×1, some 2×2, a rare 3×3 feature piece. */
export function randomSpan(): number {
  const r = Math.random();
  return r < 0.05 ? 3 : r < 0.25 ? 2 : 1;
}

/** A stateful dealer over one shuffled deck; re-shuffles when the deck runs dry. */
export function makeDealer() {
  let deck = shuffledIds();
  let ptr = 0;
  return function draw(): Piece {
    if (ptr >= deck.length) {
      deck = shuffledIds();
      ptr = 0;
    }
    return { id: deck[ptr++], status: weightedStatus() };
  };
}
