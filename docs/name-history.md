# Name history on `/name/<n>`

The `/name/<n>` page shows the full operational chain of a Namecoin name
from `name_firstupdate` through every `name_update` up to the current
state. There are **two ways** the explorer can build this history; the
page surfaces which one was used via the **Method** badge above the
History table.

| Method | Cost | Requires (on namecoind) | When it's used |
|--------|------|-------------------------|----------------|
| `name_history` RPC (preferred) | 1 RPC, O(1) | `-namehistory=1` | First choice if available |
| Chain-walk reconstruction | O(updates) RPCs | `-txindex=1` | Fallback when `name_history` fails |

Both methods produce the same shape of data
(`{op, value, value_encoding, height, txid, vout, blockhash, blocktime}`,
ordered firstupdate-first) and feed the same renderer, so the visible
History table is identical in either case. The difference is only how
the data was obtained and what the upstream node had to be configured
with.

The route handler (`routes/baseRouter.js`, `/name/:name`) tries
`name_history` first; if it throws (typical) or returns empty, it falls
through to `nameApi.reconstructNameHistory`. The implementation lives
in [`app/api/nameApi.js`](../app/api/nameApi.js).

---

## Method 1 — `name_history` RPC (cheap path)

Namecoin Core ships an optional in-process index that records every
historical state of every name. When enabled, the daemon answers a
single `name_history "<name>"` call with an array of every
`{op, value, height, txid, vout, ...}` entry the name has ever had,
oldest first.

### Enabling on the node

Add to `namecoin.conf`:

```ini
namehistory=1
```

(equivalently, pass `-namehistory=1` on the daemon command line).

A node that already has chainstate built **must reindex** to populate
the name-history index. Namecoin Core enforces this at startup —
flipping the flag without a `-reindex` produces the error:

> You need to rebuild the database using -reindex to change the
> name-history flag.

So the operator workflow is:

1. Edit `namecoin.conf`, set `namehistory=1`.
2. Stop the daemon (`systemctl stop namecoind`).
3. Restart the daemon once with `-reindex` to rebuild every index from
   the on-disk block files. On a current mainnet chain (~7-10 GB of
   blocks, ~800k blocks) this typically takes 30-90 minutes on
   commodity hardware.
4. Once `getindexinfo` reports the indexes synced and `name_history`
   stops returning `-1 "-namehistory is not enabled"`, restart the
   explorer service so its blockcache stops returning the old "no
   history" responses.

### Sanity checks

```bash
# Should NOT print "-namehistory is not enabled":
namecoin-cli name_history "d/testls" | head

# Should report txindex AND (after reindex) be in steady state:
namecoin-cli getindexinfo
```

### Why this is the preferred path

* O(1) RPC per page render, regardless of how many updates the name
  has had.
* No assumption about `-txindex`; works even on pruned-with-namehistory
  setups (uncommon but possible).
* Avoids the per-update tx-fetch fan-out that the reconstruction path
  pays.

### Why it's off by default

`-namehistory` carries a small but non-trivial cost on every block: an
extra LevelDB write per name op, an extra LevelDB key per historical
entry, and the chainstate database grows roughly proportionally with
the total number of name ops ever confirmed. For nodes that only need
to know the *current* state of names (wallet operations, NIP-05 lookup,
DNS resolution), the index is wasted work. So Namecoin Core leaves it
off until the operator opts in. Block explorers — which exist
specifically to surface the *historical* state — are the canonical
opt-in case.

---

## Method 2 — Chain-walk reconstruction (fallback path)

When the upstream node has `-namehistory` disabled (the default), the
explorer rebuilds the same data by following the chain of name UTXOs
backwards from `name_show`.

### How it works

Every Namecoin name lives as a **chain of UTXOs**:

```
name_firstupdate ──spent by──▶ name_update ──spent by──▶ name_update ──▶ … ──▶ current
```

Each `name_update` transaction spends *exactly one* prior name UTXO
(the previous state of that name) and creates *exactly one* new name
UTXO (the new state). So the full history can be reconstructed
without any extra index, just by walking the UTXO chain backwards:

1. `name_show <name>` returns `{txid, vout, height}` — the current tip
   of the chain.
2. `getrawtransaction <txid> 1` returns the tip's full transaction
   including `vin[]` and `vout[]`. The matching `vout[i]` carries the
   name op (op type, name, value).
3. For each `vin`, fetch the prevout's transaction. If that prevout
   has a `scriptPubKey.nameOp` with the same `name`, that's the
   previous state. Recurse.
4. Stop when the recorded op is `name_firstupdate` (its input is a
   `name_new`, which carries only a salted commitment hash — no
   human-readable name to walk to).

The `entries` array is then reversed so the result matches
`name_history`'s firstupdate-first ordering.

### Requires `-txindex` on the node

`getrawtransaction` for an arbitrary historical txid only works when
the node has the transaction index built:

```ini
txindex=1
```

Without `-txindex`, the walk dies after one step (we can resolve the
current tip via `name_show` because that index is always there, but
the prevouts have nowhere to be looked up). The explorer surfaces this
as a warning on the History section:

> could not locate prior name UTXO from tx X (txindex disabled or pruned?)

### Cost

* O(N) RPCs where N = number of updates the name has had. Most names
  have a small handful; long-lived names (e.g. `d/testls`) might have
  dozens to low hundreds.
* All RPCs hit the explorer's existing 15-min `txCache`, so a re-render
  pays close to nothing the second time.
* The walk is bounded by `maxSteps` (default 5000) for safety against
  pathological loops; in practice no real name comes anywhere near
  that.

### Caveats vs `name_history`

* If a name's `name_firstupdate` was pruned out of `txindex` for some
  reason (very rare), the walk halts mid-history with a warning. The
  partial result is still rendered.
* The walk can't peek inside an unconfirmed `name_update` in the
  mempool — it starts from the last *confirmed* state. The page
  separately renders pending mempool ops via the "Pending in mempool"
  section.

---

## Choosing between the two

For a public explorer like `explore.testls.bit`, the pragmatic answer
is **enable both**:

* `txindex=1` — already needed for the rest of the explorer (`/tx/<id>`
  page, address-history pages, etc.). This makes the chain-walk
  fallback work, which is essential during the reindex window when
  enabling `-namehistory`.
* `namehistory=1` — gives O(1) history page renders forever after, and
  is the documented "right way".

The explorer code prefers `name_history` when it works, so once both
are enabled the chain-walk path is just a safety net that runs when
the cheap path is unavailable.
