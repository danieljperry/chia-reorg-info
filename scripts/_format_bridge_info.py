#!/usr/bin/env python3
"""
Format the JSON output of scripts/_decode_bridge_spends.py into the
"Bridge Info" section emitted by scripts/reorg-finder.sh under -b/--bridge.

Two verbosity levels controlled by argv[1] ('quiet' or 'detailed'):

  detailed (no -q): full per-match block with header_hash, timestamp,
    matched coin (parent / puzzle_hash / amount), match reason, asset
    type. One stanza per matching spend.

  quiet (-q): one line per matching spend with height, timestamp, amount,
    asset type.

The "no bridge transfers" message uses the exact wording specified by the
feature request.

Usage:
  _format_bridge_info.py {quiet|detailed} < json_from_decode_bridge_spends.py
"""

import datetime
import json
import sys


def _ts_str(ts):
    if ts is None:
        return "(non-tx block)"
    try:
        dt = datetime.datetime.fromtimestamp(int(ts)).astimezone()
        return dt.strftime("%Y-%m-%d %H:%M:%S %Z")
    except Exception:
        return f"unix={ts}"


def _short(s, n=12):
    if s is None:
        return "?"
    s = str(s)
    if len(s) <= 2 * n + 1:
        return s
    return f"{s[:n]}…{s[-n:]}"


def _emit_quiet(matches):
    """One line per matching spend. Falls back to per-block line when
    generator parsing didn't yield spend details."""
    for m in matches:
        height = m.get("height")
        ts = m.get("timestamp")
        ts_disp = _ts_str(ts) if ts is not None else "(non-tx)"
        spends = m.get("spends") or []
        if spends:
            for s in spends:
                coin = s.get("coin") or {}
                amount = coin.get("amount")
                amount_str = f"{amount} mojos" if amount is not None else "amount=unknown"
                asset = s.get("asset_type") or "unknown"
                print(f"  height={height}  ts={ts_disp}  {amount_str}  asset={asset}")
        else:
            # Byte-search hit only; generator unparsed (chia missing or
            # ref blocks unavailable). Report what we know.
            matched = ",".join(m.get("byte_matched_hashes") or [])
            err = m.get("generator_error") or "no spend detail"
            print(
                f"  height={height}  ts={ts_disp}  amount=unknown  "
                f"asset=unknown  matched_hash={_short(matched, 10)}  "
                f"(no spend detail: {err})"
            )


def _emit_detailed(matches):
    total_blocks = len(matches)
    total_spend_matches = sum(len(m.get("spends") or []) for m in matches)
    print(
        f"  Found {total_blocks} reorged block(s) with bridge references"
        f" ({total_spend_matches} matching coin spend(s))."
    )
    for i, m in enumerate(matches, 1):
        print()
        print(f"  Match {i}:")
        print(f"    Block height:    {m.get('height')}")
        print(f"    Block hash:      {m.get('header_hash')}")
        ts = m.get("timestamp")
        if ts is not None:
            print(f"    Block timestamp: {_ts_str(ts)} (unix {ts})")
        else:
            print("    Block timestamp: (non-tx block)")
        bm = m.get("byte_matched_hashes") or []
        print(f"    Byte-matched:    {', '.join(bm)}")

        spends = m.get("spends") or []
        if not m.get("generator_parsed"):
            err = m.get("generator_error") or "unknown"
            print(f"    Spend details:   unavailable ({err})")
            print("                     [byte search confirmed the hash is referenced]")
            continue
        if not spends:
            print("    Spend details:   generator parsed, but no matching spend found")
            print("                     (puzzle hash may appear in non-spend context)")
            continue
        print(f"    Matching spends ({len(spends)}):")
        for j, s in enumerate(spends, 1):
            coin = s.get("coin") or {}
            print(f"      [{j}] parent_coin: {coin.get('parent_coin_info')}")
            print(f"          puzzle_hash: {coin.get('puzzle_hash')}")
            print(f"          amount:      {coin.get('amount')}")
            asset_type = s.get("asset_type") or "unknown"
            asset_id = s.get("asset_id")
            if asset_id:
                print(f"          asset:       {asset_type} (asset_id: {asset_id})")
            else:
                print(f"          asset:       {asset_type}")
            reasons = s.get("match_reasons") or []
            matched_h = s.get("matched_hashes") or []
            print(f"          matched on:  {', '.join(reasons) or '(unknown)'}")
            print(f"          matched hash:{', '.join(matched_h)}")


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ("quiet", "detailed"):
        print(
            "usage: _format_bridge_info.py {quiet|detailed} < json_input",
            file=sys.stderr,
        )
        return 2
    quiet = sys.argv[1] == "quiet"

    raw = sys.stdin.read()
    if not raw.strip():
        print("  No bridge transfers were found in any reorged blocks from this query.")
        return 0
    try:
        data = json.loads(raw)
    except Exception as e:
        print(f"  Bridge Info: could not parse helper output ({e}).", file=sys.stderr)
        # On a parse error, surface to caller via a clear message but
        # don't claim "no matches" — that would be a false negative.
        print("  Bridge Info unavailable: helper output was not valid JSON.")
        return 0

    matches = data.get("matches") or []
    if not matches:
        print("  No bridge transfers were found in any reorged blocks from this query.")
        return 0

    if quiet:
        _emit_quiet(matches)
    else:
        _emit_detailed(matches)
    return 0


if __name__ == "__main__":
    sys.exit(main())
