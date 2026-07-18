export type StatusKey = "none" | "wrapped" | "sale" | "bid";

export interface StatusDef {
  key: StatusKey;
  code: 0 | 1 | 2 | 3;
  label: string; // segmented-control label (lowercase, prototype style)
  trait: string; // matches the on-chain Status attribute
  color: string; // ground color
}

export const STATUSES: StatusDef[] = [
  { key: "none", code: 0, label: "not for sale", trait: "Not For Sale", color: "#6a8494" },
  { key: "wrapped", code: 1, label: "wrapped", trait: "Wrapped", color: "#75a475" },
  { key: "sale", code: 2, label: "for sale", trait: "For Sale", color: "#8c5851" },
  { key: "bid", code: 3, label: "has bid", trait: "Has Bid", color: "#8970b1" },
];

export const statusByCode = (code: number): StatusDef =>
  STATUSES.find((s) => s.code === code) ?? STATUSES[0];
