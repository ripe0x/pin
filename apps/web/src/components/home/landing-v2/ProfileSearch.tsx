"use client"

import { useArtistSearch } from "@/components/useArtistSearch"

export function LandingProfileSearch() {
  const { query, setQuery, submit } = useArtistSearch()

  return (
    <form onSubmit={submit} className="space-y-3">
      <label
        htmlFor="landing-profile-search"
        className="block text-[11px] font-mono font-medium uppercase tracking-wider text-gray-600"
      >
        Find a profile
      </label>
      <div className="flex rounded-md border border-gray-300 bg-surface p-1 transition-colors focus-within:border-gray-600">
        <input
          id="landing-profile-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ENS name or 0x address"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-gray-400"
        />
        <button
          type="submit"
          className="shrink-0 rounded-sm bg-fg px-4 py-2 text-[11px] font-mono font-medium uppercase tracking-wider text-bg transition-opacity hover:opacity-80"
        >
          Find profile
        </button>
      </div>
      <p className="text-xs leading-relaxed text-gray-500">
        Artists collect. Collectors create. One address can carry both histories.
      </p>
    </form>
  )
}
