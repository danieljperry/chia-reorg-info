# chia-reorg-info

This repo was vibe coded with Claude Opus 4.7. It provides two tools for analyzing Chia blockchain reorgs.

1. **Reorg Finder** — a bash script that queries a local Chia v2 SQLite database for reorgs (indicated by heights that have multiple block records, includes orphaned siblings). Good for retrospective audits.
2. **Reorg Monitor** — a long-running Node CLI (also installable as a Linux service) that polls the chain in real time and detects reorgs as they happen. It also optionally sends email alerts, which can be configured by reorg depth (e.g. email an on-call employee whenever a 1-block reorg is detected, and also email the lead engineer whenever a 4-block reorg is detected).

Both of these tools currently require Linux (tested on Ubuntu only). They should work on Ubuntu server without a GUI, but I haven't tested this. I could add more OS options if there is interest.

The reorg finder is a tool to run for specific queries. It doesn't poll Coinset because Coinset currently doesn't detect reorgs, although this option may be added in the future. You therefore need to have access to a Chia blockchain database in order to run it. The database queries are read-only, so the script is safe to run alongside a synced full node. In fact, this setup is preferable, as it will provide the most up-to-date results. The script is quite fast -- it can query a week's worth of data in a few seconds, and it only takes around one minute to scan the whole blockchain from genesis until today.

The reorg monitor is meant to be run continuously in the background, either in an open terminal window, or as a service. It has three modes:
1. local only -- check the local database for reorgs at specified time intervals (default 10 seconds)
2. Coinset only -- call the Coinset API to get the latest block info, and monitor it for changes in order to detect reorgs
3. Both (local + Coinset) -- detect reorgs against the local node and Coinset, compare the two, and email the results from both in a single email (assuming the data matches)

A few caveats:
* Coinset's polling is imperfect, and depends on timing. Longer reorgs will often result in confidence intervals being reported, e.g. "A reorg with a depth of 1-4 blocks was detected." Single-block reorgs are typically reported with more confidence.
* Blockchain databases are not all identical. You may have a clean copy, without any orphaned blocks, in which case you won't find any historical reorgs. Even when looking for reorgs in real time, it is common for different nodes to report different results. This is merely a facet of Chia's decentralized architecture. If your local results don't match those of Coinset, it doesn't necessarily indicate an issue.
* When using the reorg finder, the times listed are approximate, out of necessity. This is because non-tx blocks (about 2/3 of all blocks) don't come with a canonical timestamp. The script will therefore list the timestamp from the previous tx block as the starting point, and the timestamp from the next tx block as the ending point of the reorg.
* If you are interested in sending an email when reorgs are detected, you will need to set up your own SMTP service locally.
* Reorgs of a single block can occur dozens of times daily. If you are emailing your results, they will be noisy unless you increase the threshold to be something higher than 1.

## Install

```bash
git clone https://github.com/danieljperry/chia-reorg-info.git
cd chia-reorg-info
npm install
npm run build
```

Requires Node ≥ 20. The bash script also requires the `sqlite3` CLI (`sudo apt install sqlite3` on Debian/Ubuntu) and Python 3 (for timestamp parsing).

---

## Reorg Finder

- **Requires read access to a local Chia v2 blockchain database file.** Default location: `~/.chia/mainnet/db/blockchain_v2_mainnet.sqlite`.
- **Re-orged blocks are not part of the canonical chain**, so your local database may not include every historical re-org — only those your node personally observed.
- **The coinset.org API does not currently expose historical re-orgs**, so the script has no online fallback. That capability may be added later.
- **The script only reads from the database**, so it is safe (and recommended) to run while a Chia full node is also running against the same DB.

### Examples

#### Show help

```bash
$ scripts/reorg-finder.sh -h
reorg-finder.sh — scan the local Chia full-node DB for heights that
have multiple blocks (i.e. re-orged heights with orphaned siblings).

Requires read access to a Chia v2 full-node database file. By default this
is the mainnet DB at ~/.chia/mainnet/db/blockchain_v2_mainnet.sqlite; pass
-d to point at a different path (e.g. testnet11 or a copy on another disk).

Step 1: find heights in the range that have >1 block.
Step 2: for each such height, walk backward one block at a time (up to LIMIT
        blocks) so a re-org that extends below the queried range is captured
        in full. Group consecutive re-orged heights into clusters; each
        cluster is one re-org event whose size is the cluster length.
Step 3: list every block at the resulting heights with their hashes and
        whether they're on the canonical chain.

Usage:
  ./reorg-finder.sh [-n COUNT] [-e END_HEIGHT] [-l LIMIT] [-m MIN_DEPTH]
                    [-q [true|false]] [-qq [true|false]] [-d DB_PATH]

  -n COUNT       Number of blocks to examine (default: 10)…
  -e END_HEIGHT  Highest height to examine (default: full node peak via RPC)
  ...
```

#### Scan the last 10 blocks (the default), with the header hashes for every block involved in a re-org

```bash
$ scripts/reorg-finder.sh
Fetched peak height from full node RPC: 8769490
Scanning heights 8769481..8769490 (10 blocks) in /home/you/.chia/mainnet/db/blockchain_v2_mainnet.sqlite

Found a reorg of 1 block(s) (heights 8769486..8769486) (2026-05-24 13:58:42 HKT):

Per-block detail (in_main_chain=1 is canonical, 0 is orphaned):
height   header_hash                                                       prev_hash                                                         in_main_chain
8769486  a4ec9dc5ddf1dd0b5c894c9989780e6be2bb9e69e418ad037504aa5f15833a41  d17e2cf5cc3e32a5c3f52ef031139775d9a5db20bf1b26b14ca3826dac54615f  1
8769486  d17e2cf5cc3e32a5c3f52ef031139775d9a5db20bf1b26b14ca3826dac54615f  4b3d5c…                                                            0
```

#### Search 100 blocks ending at height 8,500,000, using a non-default database path

```bash
$ scripts/reorg-finder.sh -d /mnt/external/db/blockchain_v2_mainnet.sqlite -e 8500000 -n 100
Scanning heights 8499901..8500000 (100 blocks) in /mnt/external/db/blockchain_v2_mainnet.sqlite

Found 2 reorgs:
  Reorg of 1 block(s) at heights 8499947..8499947 (2026-04-22 09:14:03 HKT)
  Reorg of 2 block(s) at heights 8499981..8499982 (2026-04-22 09:30:27 to 09:30:46 HKT)
…
```

#### Find every re-org of 2 blocks or more in the last week, no per-block detail

```bash
$ scripts/reorg-finder.sh -n 32256 -m 2 -q
Fetched peak height from full node RPC: 8769490
Scanning heights 8737235..8769490 (32256 blocks) in /home/you/.chia/mainnet/db/blockchain_v2_mainnet.sqlite

Found 4 reorgs:
  Reorg of 2 block(s) at heights 8742118..8742119 (2026-05-17 22:14:08 to 22:14:27 HKT)
  Reorg of 2 block(s) at heights 8751107..8751108 (2026-05-20 06:07:32 to 06:07:51 HKT)
  Reorg of 3 block(s) at heights 8756024..8756026 (2026-05-21 12:43:33 to 12:44:11 HKT)
  Reorg of 2 block(s) at heights 8765912..8765913 (2026-05-24 03:18:54 to 03:19:13 HKT)
```

#### Count re-orgs of 7+ blocks ever recorded in the local database (one-line summary)

```bash
scripts/reorg-finder.sh -n g -m 7 -qq
Found 22 reorgs of at least 7 blocks in the specified range.
```

(A typical mainnet node sees very few re-orgs deeper than 3 blocks. `-n g` is shorthand for "scan from `END_HEIGHT` down to genesis"; on a full mainnet DB this is a full-table scan and can take minutes to complete.)

#### Machine-readable output

For programmatic use (e.g. the monitor's `--source local` mode below), pass `--json` to emit a single JSON object instead of the human-readable report. Combine with `--peak-from db` to fetch the peak from the SQLite DB instead of the full-node RPC, so the script works with no running node:

```bash
$ scripts/reorg-finder.sh -n 10 --json --peak-from db | jq .
{
  "network": "mainnet",
  "start_height": 8769481,
  "end_height": 8769490,
  "scanned_at_unix": 1748097600,
  "peak_at_scan": 8769490,
  "reorgs": [
    { "low": 8769486, "high": 8769486, "depth": 1, "ts_low_unix": 1748097540, "ts_high_unix": 1748097540 }
  ]
}
```

`--json` is incompatible with `-q` / `-qq`. All existing flags continue to work unchanged in text mode.

#### Detect bridge transfers in re-orged blocks (`-b` / `--bridge`)

Re-orgs that contain cross-chain bridge transfers are operationally interesting: a bridge transaction that the originating chain reverts (but a relayer already attested to) can produce a duplicate mint on the destination chain. `-b` makes `reorg-finder.sh` scan every orphan/reorged block in its result set for spends related to a configured set of puzzle hashes, and emits a "Bridge Info" section.

**Default search set:** the [Warp.green](https://warp.green) `bridging_puzzle.clsp` message-coin puzzle hash (`a09eb1ea…57719037`). To search for additional targets, append entries to `BRIDGE_HASHES` near the top of `main()` in `scripts/reorg-finder.sh`.

**How matches are found.** A block is included in the Bridge Info section if any configured target hash appears verbatim in its bytes. For each such block, the helper runs the block's `transactions_generator` and reports every spend that matches the bridge in one of four ways:

- `puzzle_hash` — the spent coin **is** the bridge target (the bridge message coin being relayed).
- `create_coin_target` — the spent coin **creates** a coin at the bridge target (its source — typically a `locker` or `cat_burner`).
- `create_coin_hint` — the spent coin emits a `CREATE_COIN` whose first memo equals the bridge target.
- `announcement_linked` — the spent coin is in the same `spend_bundle` as a direct match, reached by BFS over chia announcement conditions (opcodes 60/61 coin announcements and 62/63 puzzle announcements, in both directions). This is what surfaces the actual asset transfer and bridge fee — neither of which references the bridge target literally — alongside the controller and message coin.

**Sample output** (Chia → Base bridge of 500,000 DWB, re-orged):

```bash
$ scripts/reorg-finder.sh -e 7357300 -n 100 -b
…
Bridge Info:
  Found 1 reorged block(s) with bridge references (4 matching coin spend(s)).

  Match 1:
    Block height:    7357253
    Block hash:      ee1b143321c63a67213ab54532d925c8133a94d276ba926754bbb91a72e1d413
    Block timestamp: 2025-07-21 20:02:05 HKT (unix 1753099325)
    Byte-matched:    a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037
    Block spends:    38 total
    Linkage walk:    parsed 38 spend(s), found 2 announcement-linked sibling(s)
    Matching spends (4):
      [1] parent_coin: 0x30b15c4e…
          puzzle_hash: 0xa09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037
          amount:      1000000000
          asset:       bridge
          matched on:  puzzle_hash
      [2] parent_coin: 0x35efbc40…
          puzzle_hash: 0xc94ebced…
          amount:      1000000000
          asset:       warp_locker (asset_id: bse:0xc65151ac284f43a51f0a843f6a46930eff0076c5)
          note:        ... matches warp.green locker (destination: bse:0x…; locking asset: 0xb0495abe…; receiver in solution)
          matched on:  create_coin_target
      [3] parent_coin: 0x0f1daba3…
          puzzle_hash: 0xdf7a35c9…
          amount:      1000000000          ← 0.001 XCH bridge fee
          asset:       xch
          matched on:  announcement_linked
      [4] parent_coin: 0x352c0c2c…
          puzzle_hash: 0xcd4721b8…
          amount:      500000000           ← 500,000 DWB (CAT at 3-decimal scale)
          asset:       cat (asset_id: 0xb0495abe…)
          matched on:  announcement_linked
```

**Recognized warp.green puzzles.** Coins whose uncurried mod hash matches one of the warp.green Chia-side puzzles render with a labeled `asset` instead of `unknown_curried`:

| Label | Source |
|---|---|
| `warp_locker` | [`wrapped_cats/locker.clsp`](https://github.com/warpdotgreen/cli/blob/master/puzzles/wrapped_cats/locker.clsp) — Chia→EVM outbound controller. The classifier extracts the destination chain, destination contract hash, and locked asset_id from its curried args. |
| `warp_unlocker` | [`wrapped_cats/unlocker.clsp`](https://github.com/warpdotgreen/cli/blob/master/puzzles/wrapped_cats/unlocker.clsp) |
| `warp_cat_burner`, `warp_cat_minter`, `warp_wrapped_tail`, `warp_burn_inner_puzzle`, `warp_cat_mint_and_payout` | [`wrapped_assets/*.clsp`](https://github.com/warpdotgreen/cli/tree/master/puzzles/wrapped_assets) — used in the EVM→Chia direction (mint/burn of wrapped assets like DWB, WUSDC.B, milliETH). |
| `warp_bridging_puzzle`, `warp_message_coin`, `warp_portal_receiver`, `warp_rekey_portal`, `warp_p2_controller` | [`message_coin/*.clsp`](https://github.com/warpdotgreen/cli/tree/master/puzzles/message_coin) and `wrapped_cats/p2_controller_puzzle_hash.clsp` |

**Verbosity:**

- default (no `-q`, no `-qq`): full per-match detail as shown above.
- `-q`: one line per matching spend (height, timestamp, amount, asset).
- `-qq`: same as default within the Bridge Info section — `-qq`'s usual job (suppress per-re-org detail) doesn't apply here since Bridge Info is the only useful output.

**Requirements.** Full classification (amounts, asset type, locker destination) requires `chia-blockchain` and `chia_rs` to be importable by `$CHIA_PYTHON` so the block's `transactions_generator` can be parsed. When unavailable, the helper falls back to byte-search-only output (which blocks contained the target hash, no amounts or asset info).

---

## Reorg Monitor — as a CLI on Linux

The monitor polls the chain every few seconds, compares each height's current header hash to what it saw last time, and clusters consecutive changed heights into single re-org events. Every detected re-org is logged; if SMTP is configured and recipients are listed, alert emails are sent. See the "Email setup" section below to set up the email env file.

### Detection sources

The monitor supports three detection sources via `--source`:

| `--source` | What it polls | When to use |
|---|---|---|
| `coinset` (default) | The public coinset.org HTTP API | No local node required; depth is sometimes a lower bound (range). |
| `local` | The local Chia v2 SQLite DB via `scripts/reorg-finder.sh` | Requires read access to a full-node DB file; gives exact depths. |
| `both` | Coinset **and** local in parallel, with cross-referenced results | Highest confidence. Each re-org is held until two blocks past its `high` and then emailed as one of: same re-org on both, Coinset-only, or local-only. |

In `both` mode a re-org is treated as the same event when the two sources' height ranges overlap **and** their depth ranges overlap (Coinset reports depth as a `min-max` range; local reports an exact depth).

```bash
$ node dist/index.js reorg_monitor --help
Usage: chia-reorg-info reorg_monitor [options]

Run the re-org monitor as a long-running CLI process. Logs status snapshots,
re-org events, and outgoing email contents to a log file (and mirrors them to
stderr). Send SIGINT (Ctrl-C) to stop.

Options:
  --network <mainnet|testnet11>   Network to monitor (default: mainnet)
  --source <coinset|local|both>   Detection source(s) (default: coinset)
  --poll-interval <seconds>       Coinset poll interval, 5–60 (default: 5)
  --lookback <blocks>             Coinset heights re-checked per poll, 1–32 (default: 5)
  --local-poll-interval <seconds> Local-DB poll interval, 5–3600 (default: 10)
  --local-lookback <blocks>       Local-DB heights re-checked per poll, 1–1000 (default: 5)
  --db-path <path>                Path to blockchain_v2_mainnet.sqlite
                                  (default: $CHIA_DB or ~/.chia/mainnet/db/…)
  --status-every <seconds>        How often to log a status snapshot (default: 60)
  --recipient <email[:min_blocks|:b]>  Email recipient; repeatable, max 10.
                                  min_blocks (positive integer, default 1) alerts
                                  on re-orgs at least that deep. ':b' alerts only
                                  when a re-org involves the bridge (any depth).
                                  One address may use both (e.g. ':2' and ':b');
                                  they merge into one subscription. Duplicates
                                  collapsed.
  --log-file <path>               Log file path (default: ~/logs/reorg_monitor.log)
  --no-log-file                   Disable file logging (stderr only)
  --smtp-env-file <path>          Load SMTP_* env vars from a KEY=VALUE file.
                                  Comments (#) and quoted values allowed.
                                  Shell-exported vars take precedence.
  --help, -h                      Show this help
```

Example (Coinset only — the default): monitor mainnet, log to a custom path, alert three addresses — one at any re-org depth, one only for ≥3-block re-orgs, and one only when a re-org involves the bridge (`:b`) — loading SMTP credentials from a dotenv file:

```bash
node dist/index.js reorg_monitor \
  --network mainnet \
  --poll-interval 5 \
  --recipient oncall@example.com:1 \
  --recipient ops-lead@example.com:3 \
  --recipient bridge-watch@example.com:b \
  --smtp-env-file ~/.config/chia-reorg-info.env \
  --log-file ~/logs/reorg_monitor.log
```

A recipient subscribed with `:b` is emailed **only** when a re-org involves a bridge transfer (at any depth), and never for non-bridge re-orgs. An address can combine both forms — e.g. `--recipient me@example.com:2 --recipient me@example.com:b` — to get depth-≥2 alerts *and* bridge alerts; when a single re-org satisfies both, one combined email is sent carrying a `— bridge transfer` subject suffix. Numeric recipients continue to receive bridge details appended to their normal alerts when relevant.

Example (local DB only — no Coinset traffic, uses your full-node DB):

```bash
node dist/index.js reorg_monitor \
  --source local \
  --db-path ~/.chia/mainnet/db/blockchain_v2_mainnet.sqlite \
  --local-poll-interval 10 \
  --recipient oncall@example.com:1 \
  --smtp-env-file ~/.config/chia-reorg-info.env
```

Example (both sources, with cross-referenced comparison emails):

```bash
node dist/index.js reorg_monitor \
  --source both \
  --poll-interval 5 \
  --local-poll-interval 10 \
  --db-path ~/.chia/mainnet/db/blockchain_v2_mainnet.sqlite \
  --recipient oncall@example.com:1 \
  --smtp-env-file ~/.config/chia-reorg-info.env
```

In `both` mode each email's subject is suffixed with one of `— confirmed by Coinset + local DB`, `— Coinset only`, or `— local DB only`, and the body opens with a one-line statement of the comparison result.

Stop with `Ctrl-C` (SIGINT). The monitor handles graceful shutdown.

### Other CLI subcommands

The same binary also exposes two one-shot tools used internally by the monitor:

```bash
# Is the block at <height> still on the canonical chain?
node dist/index.js check_block_canonical \
  --height 8769490 \
  --expected-hash 0xf6ed0359e3983e90f4cd278000f7360757c5578e0e6ecfeca61802317e92c79a

# Scan a range for structural re-org indicators (chain_break, weight_regression,
# timestamp_regression). Only catches deeper re-orgs that leave structural traces.
node dist/index.js scan_chain_consistency --start-height 8769400 --end-height 8769490

# Print the most recent status line from the monitor's log file
node dist/index.js status
```

---

## Reorg Monitor — as a Linux service

Templates for systemd, launchd, and Windows NSSM are in [`service/`](service/).

### systemd (user-level, no root required)

This setup is for systems that don't need hardening. See the next section if you require full hardening.

```bash
# 1. Edit service/chia-reorg-monitor.service: set <node-bin> (output of `which node`),
#    <install-path> (absolute path to this checkout), and <smtp-env-file>.
#    Customize --recipient.
# 2. Install:
mkdir -p ~/.config/systemd/user
cp service/chia-reorg-monitor.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now chia-reorg-monitor

# 3. Keep running after logout (optional):
sudo loginctl enable-linger $USER

# 4. Check status / tail logs:
systemctl --user status chia-reorg-monitor
journalctl --user -u chia-reorg-monitor -f          # stderr mirror
tail -f ~/logs/reorg_monitor.log                    # the monitor's own log

# 5. Stop / uninstall:
systemctl --user stop chia-reorg-monitor
systemctl --user disable chia-reorg-monitor
rm ~/.config/systemd/user/chia-reorg-monitor.service
systemctl --user daemon-reload
```

The unit's `ExecStart` defaults to running `node <install-path>/dist/index.js reorg_monitor` with `--smtp-env-file`, so SMTP secrets stay in the env file (kept `chmod 600`) and never appear in `systemctl show` or `journalctl` output. See the comments at the top of `service/chia-reorg-monitor.service` for the full step-by-step.

This template ships **without** in-unit hardening directives, because on systemd 249 and older (Ubuntu 22.04 LTS, Debian 11) `systemctl --user` cannot manipulate the capability bounding set, and several hardening directives (`PrivateDevices`, `ProtectKernelTunables`, `NoNewPrivileges`, etc.) fail the unit with `status=218/CAPABILITIES`. The user-mode install therefore inherits your account's full permissions; the security posture relies on the monitor being a small program that only does outbound HTTPS + SMTP + log appends. If you want defence-in-depth (full hardening: no kernel-mod loading, locked-down sysctl, restricted namespaces, etc.), use the system-level template below.

### systemd (system-level, full hardening)

Use this path when you want defence-in-depth, or when the user-level install fails with `status=218/CAPABILITIES` on older systemd versions. The service runs as a dedicated unprivileged `chia-reorg` user, but PID 1 systemd applies the hardening directives because it has the capabilities to do so.

```bash
# 1. Create system user, install project, fix ownership:
sudo useradd --system --shell /usr/sbin/nologin --no-create-home chia-reorg
sudo git clone https://github.com/danieljperry/chia-reorg-info /opt/chia-reorg-info
cd /opt/chia-reorg-info && sudo npm install && sudo npm run build
sudo chown -R chia-reorg:chia-reorg /opt/chia-reorg-info

# 2. Edit service/chia-reorg-monitor.system.service:
#    set <node-bin> and <install-path>, customize --recipient.
#    For a system service, avoid nvm-installed node under user homes —
#    use a system-wide install (apt, nodesource, or a /usr/local/bin/node symlink).

# 3. Install the unit and the SMTP env file:
sudo cp service/chia-reorg-monitor.system.service \
        /etc/systemd/system/chia-reorg-monitor.service
sudo mkdir -p /etc/chia-reorg-info
sudo $EDITOR /etc/chia-reorg-info/smtp.env   # See the "Email setup" section below for the expected contents of this file
sudo chown root:chia-reorg /etc/chia-reorg-info/smtp.env
sudo chmod 0640 /etc/chia-reorg-info/smtp.env

# 4. Enable and start:
sudo systemctl daemon-reload
sudo systemctl enable --now chia-reorg-monitor

# 5. Check status / tail logs:
sudo systemctl status chia-reorg-monitor
sudo journalctl -u chia-reorg-monitor -f                    # stderr mirror
sudo tail -f /var/log/chia-reorg-monitor/reorg_monitor.log  # the monitor's own log

# 6. Stop / uninstall:
sudo systemctl disable --now chia-reorg-monitor
sudo rm /etc/systemd/system/chia-reorg-monitor.service
sudo systemctl daemon-reload
# Optionally also: sudo userdel chia-reorg && sudo rm -rf /etc/chia-reorg-info /var/log/chia-reorg-monitor /opt/chia-reorg-info
```

`/var/log/chia-reorg-monitor/` and `/etc/chia-reorg-info/` are auto-created by systemd with the right ownership thanks to `LogsDirectory=` / `ConfigurationDirectory=` in the unit.

### Using `--source local` or `--source both` under systemd

Two things commonly bite when adding `--db-path` to a service unit:

1. **Use an absolute path.** systemd does **not** expand `~` or `$HOME` inside `ExecStart=`. A literal `~/.chia/...` is passed through as the string `~/.chia/...` and fails the readability check. Write the full path, e.g. `/home/<you>/.chia/mainnet/db/blockchain_v2_mainnet.sqlite`.
2. **Watch the running user.** The system-level unit runs as the unprivileged `chia-reorg` user. Even when the SQLite file itself is `0644`, a parent directory like `/home/<you>/` (typically `0750`) blocks the lookup, and the monitor fails with `--db-path check failed`. Verify by running the same `stat` as the service user:
   ```bash
   sudo -u chia-reorg stat /home/<you>/.chia/mainnet/db/blockchain_v2_mainnet.sqlite
   ```
   If that fails with permission-denied, either use the user-level unit (runs as your own UID — already has access to your home), or relocate the DB to a path the `chia-reorg` user can read (e.g. `/var/lib/chia-reorg/blockchain_v2_mainnet.sqlite`, perhaps as a read-only bind mount or copy refreshed on a timer). Note that the system-unit's `ProtectHome=true` hardening also hides `/home` from the service entirely — that's another reason to keep the DB outside `/home` for system-level installs.

The error message distinguishes "path does not exist" (likely cause #1) from "not readable by this user" (likely cause #2) so you can tell which one you're hitting.

### macOS (launchd) and Windows (NSSM)

See [`service/com.chia-reorg-info.reorg-monitor.plist`](service/com.chia-reorg-info.reorg-monitor.plist) and [`service/install-windows.ps1`](service/install-windows.ps1) — same shape, platform-specific install commands documented inline.

---

## Email setup

The monitor uses [nodemailer](https://nodemailer.com/) for SMTP. Configure via environment variables (or a dotenv-style file passed with `--smtp-env-file`):

| Variable | Required? | Notes |
|---|---|---|
| `SMTP_HOST` | yes (when `--recipient` is set) | e.g. `127.0.0.1` for Proton Mail Bridge, `smtp.gmail.com`, etc. |
| `SMTP_PORT` | optional | Default `587` |
| `SMTP_USER` | optional | Auth username |
| `SMTP_PASS` | optional | Auth password — keep the env file `chmod 600` |
| `SMTP_SECURE` | optional | Set to `true` to use TLS at connect time (port 465-style). Recommended for production. |
| `SMTP_FROM` | optional | From address. Falls back to `SMTP_USER`, then `chia-reorg-info@localhost` |
| `SMTP_CA_CERT_PATH` | optional | Path to a PEM CA cert. Needed when the SMTP server uses a self-signed certificate (e.g. Proton Mail Bridge). |

### Dotenv file format

Pass the file with `--smtp-env-file <path>`. Accepts the standard `KEY=VALUE` format plus an optional `export ` prefix so a shell-sourceable file works as-is. `#` comments and `'...'` / `"..."` quoted values are supported. Example:

```
# ~/.config/chia-reorg-info.env  (chmod 600)
export SMTP_HOST=127.0.0.1
export SMTP_PORT=1025
export SMTP_USER="bridge-user@protonmail.com"
export SMTP_PASS='your-bridge-token'
export SMTP_SECURE=true
export SMTP_FROM=alerts@protonmail.com
export SMTP_CA_CERT_PATH=/home/you/.config/protonmail-bridge-ca.pem
```

Shell-exported variables take precedence over the file, so you can override one-off in your shell without editing the file.

### What the monitor will email

When a re-org is detected, the monitor sends one email per eligible recipient. The subject is `Re-org of depth N detected on Chia mainnet` (or `Re-org of depth N-M ...` when the depth is a lower bound because polls were skipped during chain instability). The body lists each affected block: height, old header hash, new header hash, depth, distance from the current peak, and the original block record JSON, plus a link to spacescan.io for the canonical replacement.

A "Skipping recipient (no trigger met)" line is logged when a re-org matches none of a recipient's triggers — too shallow for their `min_blocks` threshold, and (for `:b` recipients) not involving the bridge. Worst-case dispatch is used — if depth is ambiguous (chain advanced past the last fully-observed peak during the re-org window), the upper-bound depth is what's compared against the threshold so you are never silently filtered out. Bridge-subscribed (`:b`) recipients are dispatched whenever the re-org batch involves a bridge transfer, regardless of depth, and their email carries the complete re-org contents plus a `— bridge transfer` subject suffix.

## Development

```bash
npm test                 # run the full vitest suite
npm run test:coverage    # vitest + v8 coverage report (text + HTML in coverage/)
npm run lint             # eslint
npm run typecheck        # tsc --noEmit
npm run dev              # tsx src/index.ts (run from source)
npm run build            # compile to dist/
```

CI runs lint, typecheck, and the test suite with coverage on every push to `main` and on PRs — see `.github/workflows/ci.yml`. The coverage HTML report is uploaded as a workflow artifact (`coverage-report`).

## License

MIT
