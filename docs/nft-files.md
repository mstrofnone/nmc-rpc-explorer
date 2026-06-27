# HOWTO — Reconstruct an nft/* file from the Namecoin blockchain

This is a step-by-step guide to pull a file (e.g. `nft/bitcoin-0.1.0.rar`)
out of Namecoin's name-history and verify it byte-for-byte against the
MD5 the publisher put on-chain.

Worked example used throughout: **`nft/bitcoin-0.1.0.rar`** — the
Bitcoin v0.1.0 source + Win32 binary (`bitcoin.exe`, `libeay32.dll`,
`src/*.cpp,*.h`).

Final result you should see:

    MD5  : 91e2dfa2af043eabbb38964cbf368500
    Size : 2,132,686 bytes
    Type : RAR archive data, v4, os: Win32

---

## 0. TL;DR

If you already have:

  * a fully-synced `namecoind` with `namehistory=1` and an unlocked RPC,
  * Python 3.9+ with `requests`,

then:

    # save the script below as nft_reconstruct.py, then:
    python3 nft_reconstruct.py 'nft/bitcoin-0.1.0.rar' \
        --conf "$HOME/Library/Application Support/Namecoin/namecoin.conf" \
        --out  ./bitcoin-0.1.0.rar

It prints chain stats, walks the on-chain tx-chain, concatenates the
chunks in true order, and verifies MD5/size against the on-chain
manifest.

For the why and how, keep reading.

---

## 1. Background: how files are stored

Namecoin lets you register a name and update its value any number of
times. The value is up to ~520 bytes. To put a 2 MB file on-chain, the
publisher splits it into chunks and updates the same name once per
chunk. Every `name_update` transaction spends the previous one's name
output, so the updates form a **linked list of transactions**, not a
flat set.

A typical `nft/*` chain looks like:

  1. A few JSON-meta updates at the start that describe the file
     (publisher, MD5, comment, URL, …).
  2. N raw-binary updates carrying the file body (almost all the same
     size, e.g. 520 bytes; the last one is shorter).
  3. Optionally, a richer JSON-meta footer once the file is complete,
     pointing at the chain's `Entry TxID` and `Final TxID` and stating
     the expected size and MD5.

For `nft/bitcoin-0.1.0.rar`:

    history rows : 4108
    meta rows    :    6   (3 small heads + 3 rich footers)
    chunk rows   : 4102   (4101 × 520 B + 1 × 166 B tail = 2,132,686)
    spans heights: 653037 → 807419
    Entry TxID   : f67e22396be386c7f9a3ff8815a0dd0db075b98c67f85d330e3b392b24593d26
    Final TxID   : ce870aebe6eb682e046e7d7962aa9aff3407115909100249f9787964169042c0

## 2. The one thing that's easy to get wrong

`name_history` rows come out of the node ordered by block height, and
that is **not** enough. Within a single block, many chunks can land,
and the only correct order is the tx-chain order. Sorting by
`(height, txid)` gives the wrong answer (txid is a hash; it's
meaningless) and produces a file with a correct length but a wrong MD5.

To get the right order:

  * For each row, look up the raw transaction.
  * Its `vin[i].txid` for the input that came from another row in the
    same name = its parent in the chain.
  * The row with no parent inside the set = the chain root (= Entry).
  * Follow the linked list forward; concatenate the non-JSON values.

That's what the script below does.

---

## 3. Prerequisites

### 3.1 A synced Namecoin node with full name history

You need `namecoind` (≥ 25.x) with these in `namecoin.conf`:

    server=1
    rpcuser=namecoinrpc
    rpcpassword=<something long>
    rpcport=8336
    namehistory=1            # << REQUIRED, else name_history returns only current
    rpcworkqueue=128         # helpful for the bulk RPC walk
    rpcthreads=16

If you didn't have `namehistory=1` from genesis, run a one-time
reindex of the chainstate (≈2 min on a modern box):

    /Users/m/nmc/namecoind -reindex-chainstate

You do **not** need `txindex=1`. The script passes the block hash with
every `getrawtransaction` call, which is enough.

Wait for the node to be ready:

    AUTH="namecoinrpc:$(grep ^rpcpassword= "$HOME/Library/Application Support/Namecoin/namecoin.conf" | cut -d= -f2)"
    URL="http://127.0.0.1:8336/"
    curl -s --user "$AUTH" -H 'content-type: text/plain;' \
      --data-binary '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' \
      "$URL" | python3 -m json.tool | grep -E 'initialblock|verificationprogress|blocks'

You want `initialblockdownload: false` and `verificationprogress > 0.9999`.

### 3.2 Python

Python 3.9+ and `requests`:

    python3 -m pip install --user requests

---

## 4. Reconstruct in three commands

Save the script in §6 as `nft_reconstruct.py`, then:

    # 1. discover (read only): get chain stats + claimed MD5/size from the chain
    python3 nft_reconstruct.py 'nft/bitcoin-0.1.0.rar' --info

    # 2. reconstruct: walk the tx chain and write the file
    python3 nft_reconstruct.py 'nft/bitcoin-0.1.0.rar' --out ./bitcoin-0.1.0.rar

    # 3. spot-check
    md5 ./bitcoin-0.1.0.rar   # macOS;  md5sum on Linux
    # -> 91e2dfa2af043eabbb38964cbf368500
    file ./bitcoin-0.1.0.rar
    # -> RAR archive data, v4, os: Win32, flags: Solid

The script also verifies the MD5 itself before exiting non-zero on a
mismatch, so you can wire it into a pipeline.

To list the files contained in the RAR (macOS doesn't ship `unrar`):

    brew install unar
    unar -l ./bitcoin-0.1.0.rar

Expected highlights: `bitcoin.exe`, `libeay32.dll`, `mingwm10.dll`,
`src/main.cpp`, `src/sha.cpp`, `src/db.cpp`, `src/ui.cpp`, the full
`src/*.h`, the icon `src/rc/bitcoin.ico`, etc.

---

## 5. How the script works, step by step

1.  **Fetch the history.** One JSON-RPC call:
    `name_history("nft/bitcoin-0.1.0.rar")` with `encoding="hex"` so we
    get raw bytes back, not lossy UTF-8. Each entry is one update.

2.  **Classify each value.** A value that parses as a JSON object →
    metadata. Anything else → a binary chunk.

3.  **Look up parent txid for each row.** For each row at height H
    with txid T:

        bh = getblockhash(H)
        tx = getrawtransaction(T, verbose=1, blockhash=bh)
        parent[T] = first vin[*].txid that is also in our row set

    Block hashes are cached so we only make `getblockhash` calls once
    per distinct height (≈220 calls for this file, vs 4108 row calls
    — small win, but tidy).

4.  **Find the chain root.** Exactly one txid has no parent inside the
    set; that's the Entry. If the on-chain manifest declares an
    `Entry TxID`, we cross-check.

5.  **Walk forward.** Follow parent→child until we hit a node with no
    children; that's the Final.

6.  **Concatenate the non-JSON values** in that order. That is the
    file.

7.  **Verify.** Compute MD5/SHA1/SHA256. If any of those, or the size,
    are declared in any JSON-meta row, compare. Exit non-zero on a
    mismatch.

This generalises: it works on any `nft/*` chain (and most other
chunked single-name file formats), not just this one. The manifest
Entry/Final is a nice-to-have but not required; the parent-walk finds
the root from the rows themselves.

---

## 6. The script

Save as `nft_reconstruct.py`. Standalone — only needs `requests`.

```python
# ----8<---- nft_reconstruct.py ----8<----
#!/usr/bin/env python3
"""
nft_reconstruct.py — reconstruct a file stored under a single Namecoin
name (e.g. nft/bitcoin-0.1.0.rar) by walking its on-chain tx-chain and
concatenating the binary chunks in true order.

Verifies the result against any MD5/SHA1/SHA256/size that the publisher
embedded in a JSON-meta row.

Usage:
    nft_reconstruct.py NAME [--out PATH] [--conf NAMECOIN_CONF]
                            [--info] [--no-verify-exit]

The script makes only read-only RPC calls (name_history, getblockhash,
getrawtransaction). It does not touch the wallet.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests
from requests.auth import HTTPBasicAuth


# ---------- RPC ---------------------------------------------------------

DEFAULT_CONF = os.environ.get(
    "NAMECOIN_CONF",
    os.path.expanduser("~/Library/Application Support/Namecoin/namecoin.conf"),
)


def load_conf(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


class RPC:
    def __init__(self, conf_path: str, timeout: int = 60):
        c = load_conf(conf_path)
        host = c.get("rpcbind", "127.0.0.1").split(":")[0] or "127.0.0.1"
        port = c.get("rpcport", "8336")
        self.url = f"http://{host}:{port}/"
        self.auth = HTTPBasicAuth(c["rpcuser"], c["rpcpassword"])
        self.session = requests.Session()
        self.timeout = timeout

    def call(self, method: str, params: list[Any] | None = None, retries: int = 6) -> Any:
        payload = {"jsonrpc": "1.0", "id": "p", "method": method, "params": params or []}
        last_err: Exception | None = None
        for attempt in range(retries):
            try:
                r = self.session.post(
                    self.url,
                    auth=self.auth,
                    data=json.dumps(payload),
                    headers={"content-type": "text/plain;"},
                    timeout=self.timeout,
                )
                if r.status_code == 503:        # work queue full → back off
                    time.sleep(0.5 * (attempt + 1))
                    continue
                r.raise_for_status()
                resp = r.json()
                if resp.get("error"):
                    raise RuntimeError(f"RPC error: {resp['error']}")
                return resp["result"]
            except Exception as e:              # noqa: BLE001
                last_err = e
                time.sleep(0.3 * (attempt + 1))
        raise RuntimeError(f"RPC {method} failed after {retries} retries: {last_err}")


# ---------- Chain logic ------------------------------------------------

def classify(value_bytes: bytes) -> tuple[str, dict | None]:
    """('meta', obj) for JSON-dict payloads, else ('chunk', None)."""
    if not value_bytes:
        return "chunk", None
    if value_bytes[:1] == b"{":
        try:
            obj = json.loads(value_bytes.decode("utf-8"))
            if isinstance(obj, dict):
                return "meta", obj
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
    return "chunk", None


def fetch_history(rpc: RPC, name: str) -> list[dict]:
    # encoding="hex" so binary names/values round-trip losslessly.
    rows = rpc.call(
        "name_history",
        [name, {"nameEncoding": "ascii", "valueEncoding": "hex"}],
    )
    # Some node versions accept name_history with one arg only.
    if not isinstance(rows, list):
        rows = rpc.call("name_history", [name])
    return rows


def order_chain(rpc: RPC, rows: list[dict], progress: bool = True) -> list[dict]:
    """Order rows by walking the on-chain parent→child tx-chain."""
    by_txid: dict[str, dict] = {r["txid"]: r for r in rows}

    # Cache block hashes per distinct height.
    block_hash: dict[int, str] = {}
    heights = sorted({r["height"] for r in rows})
    for i, h in enumerate(heights, 1):
        block_hash[h] = rpc.call("getblockhash", [h])
        if progress and (i % 50 == 0 or i == len(heights)):
            print(f"  blockhashes: {i}/{len(heights)}", end="\r", file=sys.stderr)
    if progress and heights:
        print(file=sys.stderr)

    parent: dict[str, str | None] = {}
    for i, r in enumerate(rows, 1):
        tx = rpc.call("getrawtransaction", [r["txid"], 1, block_hash[r["height"]]])
        prev: str | None = None
        for vin in tx["vin"]:
            ptxid = vin.get("txid")
            if ptxid and ptxid in by_txid:
                prev = ptxid
                break
        parent[r["txid"]] = prev
        if progress and (i % 200 == 0 or i == len(rows)):
            print(f"  parent walk: {i}/{len(rows)}", end="\r", file=sys.stderr)
    if progress and rows:
        print(file=sys.stderr)

    roots = [t for t, p in parent.items() if p is None]
    children: dict[str, list[str]] = {}
    for t, p in parent.items():
        if p is not None:
            children.setdefault(p, []).append(t)

    if len(roots) != 1:
        print(f"  WARNING: {len(roots)} chain roots: {roots}", file=sys.stderr)
        roots.sort(key=lambda t: by_txid[t]["height"])
    for p, kids in children.items():
        if len(kids) > 1:
            print(f"  WARNING: fork at {p}: children={kids}", file=sys.stderr)
            kids.sort(key=lambda t: by_txid[t]["height"])

    ordered: list[dict] = []
    seen: set[str] = set()
    for root in roots:
        cur: str | None = root
        while cur is not None and cur not in seen:
            ordered.append(by_txid[cur])
            seen.add(cur)
            kids = children.get(cur, [])
            cur = kids[0] if kids else None

    if len(ordered) != len(rows):
        missing = [by_txid[t] for t in by_txid if t not in seen]
        print(
            f"  WARNING: only {len(ordered)}/{len(rows)} rows reachable; "
            f"appending {len(missing)} leftovers by height",
            file=sys.stderr,
        )
        ordered.extend(sorted(missing, key=lambda r: (r["height"], r["txid"])))
    return ordered


def split_meta_and_chunks(rows: list[dict]) -> tuple[list[dict], list[bytes]]:
    metas: list[dict] = []
    chunks: list[bytes] = []
    for r in rows:
        raw = bytes.fromhex(r["value"])
        kind, obj = classify(raw)
        if kind == "meta":
            metas.append(obj)  # type: ignore[arg-type]
        else:
            chunks.append(raw)
    return metas, chunks


def collect_claims(metas: list[dict]) -> tuple[dict[str, str], int | None]:
    digests: dict[str, str] = {}
    size: int | None = None
    for m in metas:
        for k, v in m.items():
            kl = k.lower()
            if kl in ("md5", "sha1", "sha256") and isinstance(v, str):
                digests.setdefault(kl, v.strip().lower())
            if kl == "hex-data" and isinstance(v, dict):
                props = v.get("Properties") or v.get("properties")
                if isinstance(props, str):
                    m1 = re.search(r"\(([\d,]+)\s*bytes\)", props)
                    if m1:
                        size = int(m1.group(1).replace(",", ""))
    return digests, size


# ---------- CLI --------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(
        description="Reconstruct a file stored as chunks in a single Namecoin name."
    )
    p.add_argument("name", help="Namecoin name, e.g. 'nft/bitcoin-0.1.0.rar'")
    p.add_argument("--out", type=Path, help="Output file path (default: ./<basename>)")
    p.add_argument("--conf", default=DEFAULT_CONF, help="Path to namecoin.conf")
    p.add_argument("--info", action="store_true",
                   help="Print chain stats and any on-chain claims, then exit (no RPC walk, no file write).")
    p.add_argument("--no-verify-exit", action="store_true",
                   help="Don't exit non-zero on hash/size mismatch.")
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args()

    rpc = RPC(args.conf)
    rows = fetch_history(rpc, args.name)
    if not rows:
        print(f"no history for {args.name!r}", file=sys.stderr)
        return 2

    heights = [r["height"] for r in rows]
    if not args.quiet:
        print(f"[{args.name}] {len(rows)} history rows; heights {min(heights)}…{max(heights)}")

    if args.info:
        # No tx-walk; just classify and report claims.
        metas, chunks = split_meta_and_chunks(rows)
        digests, size = collect_claims(metas)
        sizes: dict[int, int] = {}
        for c in chunks:
            sizes[len(c)] = sizes.get(len(c), 0) + 1
        sizes_top = ", ".join(
            f"{sz}B×{n}" for sz, n in sorted(sizes.items(), key=lambda kv: -kv[1])[:5]
        )
        print(f"[{args.name}] meta rows: {len(metas)}   chunk rows: {len(chunks)}")
        print(f"[{args.name}] chunk size histogram (top 5): {sizes_top}")
        if metas:
            keys = sorted({k for m in metas for k in m.keys()})
            print(f"[{args.name}] meta keys: {keys}")
        if digests:
            for algo, want in digests.items():
                print(f"[{args.name}] claim {algo}: {want}")
        if size is not None:
            print(f"[{args.name}] claim size: {size:,} bytes")
        return 0

    if not args.quiet:
        print(f"[{args.name}] ordering chain via RPC tx-walk …", file=sys.stderr)
    rows = order_chain(rpc, rows, progress=not args.quiet)

    metas, chunks = split_meta_and_chunks(rows)
    payload = b"".join(chunks)
    digests, claimed_size = collect_claims(metas)
    computed = {
        "md5": hashlib.md5(payload).hexdigest(),
        "sha1": hashlib.sha1(payload).hexdigest(),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }

    if not args.quiet:
        print(f"[{args.name}] meta rows: {len(metas)}   chunk rows: {len(chunks)}")
        print(f"[{args.name}] payload bytes: {len(payload):,}")
        for algo, val in computed.items():
            print(f"[{args.name}] {algo}: {val}")

    mismatch = False
    if claimed_size is not None:
        ok = claimed_size == len(payload)
        mismatch |= not ok
        print(f"[{args.name}] claim size: {claimed_size:,}  -> {'OK ' if ok else 'MISMATCH'}")
    for algo, want in digests.items():
        ok = computed[algo] == want
        mismatch |= not ok
        print(f"[{args.name}] claim {algo}: {want}  -> {'OK ' if ok else 'MISMATCH'}")

    out_path = args.out or Path(args.name.split("/")[-1].replace("\\", "_"))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(payload)
    print(f"[{args.name}] wrote {out_path}  ({len(payload):,} bytes)")

    if mismatch and not args.no_verify_exit:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
# ----8<---- end nft_reconstruct.py ----8<----
```

---

## 7. Worked example output

    $ python3 nft_reconstruct.py 'nft/bitcoin-0.1.0.rar' --out ./bitcoin-0.1.0.rar
    [nft/bitcoin-0.1.0.rar] 4108 history rows; heights 653037…807419
    [nft/bitcoin-0.1.0.rar] ordering chain via RPC tx-walk …
      blockhashes: 223/223
      parent walk: 4108/4108
    [nft/bitcoin-0.1.0.rar] meta rows: 6   chunk rows: 4102
    [nft/bitcoin-0.1.0.rar] payload bytes: 2,132,686
    [nft/bitcoin-0.1.0.rar] md5:    91e2dfa2af043eabbb38964cbf368500
    [nft/bitcoin-0.1.0.rar] sha1:   ec9ed4ccbc990eceb922ff0c4d71d1ad466990dd
    [nft/bitcoin-0.1.0.rar] sha256: 8b17eb9a5707f2519defda4cdf8d14fa1b8dee630e11e6ef85ff9f5547555b56
    [nft/bitcoin-0.1.0.rar] claim size: 2,132,686  -> OK
    [nft/bitcoin-0.1.0.rar] claim md5:  91e2dfa2af043eabbb38964cbf368500  -> OK
    [nft/bitcoin-0.1.0.rar] wrote ./bitcoin-0.1.0.rar  (2,132,686 bytes)

    $ file ./bitcoin-0.1.0.rar
    ./bitcoin-0.1.0.rar: RAR archive data, v4, os: Win32, flags: Solid

End-to-end runtime on an M-class Mac: about 2 minutes, almost all in
the per-row `getrawtransaction` calls.

---

## 8. Troubleshooting

* **`name_history returns only the current update`** — your node was
  built/run without `namehistory=1`, or you never ran the one-time
  chainstate reindex. Add the flag and reindex:
    `namecoind -reindex-chainstate`

* **`RPC getrawtransaction failed … 500 Internal Server Error`** —
  you're calling it without a block hash and `txindex` is off. This
  script always passes the block hash, so it works without txindex.
  If you adapted the code, keep the third arg.

* **`401 Unauthorized`** — bad `rpcuser` / `rpcpassword` in
  `--conf`, or the file's path is wrong. macOS default is
  `~/Library/Application Support/Namecoin/namecoin.conf`.

* **`503 Service Unavailable` mid-run** — the RPC work queue is full.
  The script retries with backoff. If it still fails, set
  `rpcworkqueue=128` and `rpcthreads=16` in `namecoin.conf`, then
  restart `namecoind`.

* **Hash mismatch but size matches** — almost always means ordering
  is wrong. Re-run without `--no-rpc`/equivalent so the tx-chain walk
  runs. (Plain height/txid sorting will *not* work for files with
  multiple updates per block.)

* **`X chain roots: [...]` warning** — the chain isn't fully linear
  in your row set. Most commonly this means an early `name_new` /
  `name_firstupdate` got missed by `name_history`, or someone
  re-registered the name. Walk continues; inspect the warning before
  trusting the output.

* **Multiple files under the same name** — some publishers reuse a
  name to push a *second* file after the first one was complete. The
  parent-walk still gives you one linear chain; you may want to slice
  it at the JSON-meta footer of the first file. Inspect the JSON-meta
  rows in order to see where boundaries are.

* **Wrong file type at the start** — some chains begin with a single
  JSON-meta row whose binary payload is empty. That's fine; the
  classifier drops it.

---

## 9. Pointers to the rest of the toolkit (this workspace)

* `setup1.txt` — state-of-play after the dump pipeline build.
* `namecoinsqlite.txt` — the SQLite DB schema + FTS5 cheatsheet.
* `todo.txt` — what's deferred: incremental tailer, tagger, gallery,
  semantic search.
* `nmcdump/scripts/nft_extract.py` — same logic as this howto, but
  pulls history from the local SQLite mirror instead of calling
  `name_history` again. Faster on repeated runs.

Both scripts produce the same bytes for `nft/bitcoin-0.1.0.rar`. Pick
whichever fits where you're standing.
