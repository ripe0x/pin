"use client";

// Two-layer crossfade for homage art: the previous piece stays put while the next fades in
// over it, so the gallery's ambient swaps read as the wall breathing, never tiles popping.
// Parent must be `position: relative` with a fixed aspect; both layers fill it.

import { useEffect, useRef, useState } from "react";

export function CrossfadeArt({ src, alt = "", fadeMs = 900 }: { src?: string; alt?: string; fadeMs?: number }) {
  const [base, setBase] = useState<string>(); // settled art, fully opaque
  const [over, setOver] = useState<string>(); // incoming art, fading in
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!src || src === base) return;
    if (!base) {
      setBase(src); // first load: no fade partner yet, just appear
      return;
    }
    setOver(src);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setBase(src);
      setOver(undefined);
    }, fadeMs);
    return () => clearTimeout(timer.current);
  }, [src, base, fadeMs]);

  if (!base) return <div className="g-skeleton" />;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={base} alt={alt} className="absolute inset-0 w-full h-full" style={{ imageRendering: "pixelated" }} />
      {over && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={over}
          alt=""
          className="absolute inset-0 w-full h-full g-fade-in"
          style={{ imageRendering: "pixelated", animationDuration: `${fadeMs}ms` }}
        />
      )}
    </>
  );
}
