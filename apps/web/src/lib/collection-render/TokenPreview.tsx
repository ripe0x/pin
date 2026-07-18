"use client";

/**
 * Sandboxed live preview of a generative token: builds the parity
 * document and renders it in an iframe with the same sandbox posture as
 * TokenMedia (scripts allowed, no same-origin, no referrer). Used by the
 * studio test-seed preview and anywhere a not-yet-minted document needs
 * rendering; minted tokens should render their real tokenURI through
 * TokenMedia instead.
 */

import { useEffect, useState } from "react";

import { buildTokenHTML } from "./build";
import type { BuildOptions, ContentResolver, TokenData, WorkInput } from "./types";

type Props = {
  work: WorkInput;
  tokenData: TokenData;
  resolver: ContentResolver;
  gunzip: BuildOptions["gunzip"];
  className?: string;
  title?: string;
};

export function TokenPreview({ work, tokenData, resolver, gunzip, className, title }: Props) {
  const [doc, setDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    buildTokenHTML(work, tokenData, resolver, { gunzip })
      .then((html) => {
        if (!cancelled) setDoc(html);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [work, tokenData, resolver, gunzip]);

  if (error) {
    return (
      <div className={className}>
        <div className="flex h-full w-full items-center justify-center bg-neutral-100 p-4 text-center text-xs text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          preview failed: {error}
        </div>
      </div>
    );
  }

  if (doc === null) {
    return (
      <div className={className}>
        <div className="h-full w-full animate-pulse bg-neutral-100 dark:bg-neutral-900" />
      </div>
    );
  }

  return (
    <iframe
      className={className}
      title={title ?? `preview ${tokenData.tokenId}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      srcDoc={doc}
    />
  );
}
