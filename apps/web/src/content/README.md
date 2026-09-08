# Release editorial content

`releases.json` is PND's small, checked-in editorial overlay for the venue.
It never replaces the permissionless Surface record or supplies contract state.

- `collection` is the lowercase mainnet collection address and joins editorial
  content to the live Postgres release record.
- `featured` and `featureOrder` are PND editorial decisions.
- `editorialSummary` is PND-authored context. Do not place an artist statement
  here unless its source and artist declaration model have been implemented.
- Names, artists, images, mint totals, schedules, prices, and availability stay
  data-driven. Never copy them into this file to mask a missing indexer field.

The loader fails fast on malformed addresses, duplicate collections, duplicate
feature order, or unsupported schema versions. A release absent from this file
still appears in the complete Surface directory.
