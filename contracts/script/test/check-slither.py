#!/usr/bin/env python3
"""Fail CI on new medium-or-higher v2 Slither findings.

The three accepted findings are pinned by Slither's finding IDs, so a
changed call path must be reviewed instead of being hidden by a detector-wide
exclusion. Run Slither 0.11.5 with --fail-none --json before this check.
"""

import json
import sys
from pathlib import Path


ACCEPTED = {
    # _mint is guarded by nonReentrant; the token's mintTo makes no calls out.
    "1d2f225125862127e9653bcaf09ef8d3e269f812cf59dbff59488f8fd72ef414",
    # The initializer returns no data; functionCall is used for revert bubbling.
    "995cfaec7a2ac12cc6c64259a0d4df4dc8441df35a40f82161315d3acef3cc40",
    # Only config().mintedEver is needed for the receiver's next-token-id check.
    "cf126fa9cefd85add7a9e18e43acf1f91a4aacd670124b23d93249889dbab89a",
}


def main() -> int:
    report = json.loads(Path(sys.argv[1]).read_text())
    if not report.get("success"):
        print("Slither did not complete successfully", file=sys.stderr)
        return 1

    new = [
        finding
        for finding in report["results"]["detectors"]
        if finding["impact"] in {"Medium", "High", "Critical"}
        and finding["id"] not in ACCEPTED
    ]
    for finding in new:
        print(
            f'NEW {finding["impact"]} {finding["check"]}: '
            f'{finding["description"].splitlines()[0]}',
            file=sys.stderr,
        )
    print(f"Slither: {len(new)} new medium-or-higher findings")
    return bool(new)


if __name__ == "__main__":
    raise SystemExit(main())
