#!/usr/bin/env python3
"""Replay upstream-geth transactions onto a scratch Anvil, then dump state.

Invoked by scripts/rebake-blockchain.sh. Reads env:
  GETH_URL       JSON-RPC URL of the running upstream geth
  ANVIL_URL      JSON-RPC URL of the running scratch anvil
  GENESIS_PATH   path to the upstream's genesis.json (for alloc balances)
  OUT_PATH       where to write the Anvil state (plain JSON, gunzipped)

Why replay txs instead of copying state?

  * debug_dumpBlock / debug_accountRange return empty on this chain — geth
    boots with `Head state missing, repairing` and the state trie isn't
    iterable even though point lookups work.
  * debug_storageRangeAt gives us storage *values* but keyed by keccak(slot),
    not the original slot (preimages weren't recorded in the baked chaindata).
    anvil_setStorageAt needs the original slot, so we can't replay storage
    directly.
  * The raw signed-tx bytes are fetchable via eth_getRawTransactionByHash
    and re-submittable to Anvil with eth_sendRawTransaction — Anvil executes
    them identically (same chain-id, same EIP-155 signatures), producing the
    exact same contract addresses and storage.
"""
from __future__ import annotations

import gzip
import json
import os
import sys
import urllib.request


def rpc(url: str, method: str, params: list):
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"content-type": "application/json"},
    )
    r = json.loads(urllib.request.urlopen(req).read())
    if "error" in r:
        raise RuntimeError(f"{method}({params[:2]!r}): {r['error']}")
    return r["result"]


def main() -> int:
    geth = os.environ["GETH_URL"]
    anvil = os.environ["ANVIL_URL"]
    genesis_path = os.environ["GENESIS_PATH"]
    out_path = os.environ["OUT_PATH"]

    # --- 1. seed anvil with genesis allocs ---
    with open(genesis_path) as f:
        genesis = json.load(f)
    allocs = genesis.get("alloc", {})
    for addr, v in allocs.items():
        a = addr if addr.startswith("0x") else "0x" + addr
        rpc(anvil, "anvil_setBalance", [a, hex(int(v.get("balance", "0")))])
    print(f"  seeded {len(allocs)} genesis EOAs")

    # --- 2. replay every signed tx in order ---
    latest = int(rpc(geth, "eth_blockNumber", []), 16)
    total_sent = 0
    for n in range(latest + 1):
        b = rpc(geth, "eth_getBlockByNumber", [hex(n), False])
        if not b or not b.get("transactions"):
            continue
        for h in b["transactions"]:
            raw = rpc(geth, "eth_getRawTransactionByHash", [h])
            new_h = rpc(anvil, "eth_sendRawTransaction", [raw])
            r = rpc(anvil, "eth_getTransactionReceipt", [new_h])
            if not r or r.get("status") != "0x1":
                print(f"  FAIL tx {h} -> receipt={r}", file=sys.stderr)
                return 1
            total_sent += 1
    print(f"  replayed {total_sent} tx(s)")

    # --- 3. enumerate every address we care about and correct balance/nonce ---
    addrs: set[str] = set()
    for a in allocs:
        addrs.add(("0x" + a if not a.startswith("0x") else a).lower())
    for n in range(latest + 1):
        b = rpc(geth, "eth_getBlockByNumber", [hex(n), True])
        if not b:
            continue
        miner = b.get("miner", "").lower()
        if miner and int(miner, 16) != 0:
            addrs.add(miner)
        for tx in b.get("transactions", []):
            addrs.add(tx["from"].lower())
            if tx.get("to"):
                addrs.add(tx["to"].lower())
            r = rpc(geth, "eth_getTransactionReceipt", [tx["hash"]])
            if r and r.get("contractAddress"):
                addrs.add(r["contractAddress"].lower())
            try:
                trace = rpc(geth, "debug_traceTransaction", [tx["hash"], {"tracer": "callTracer"}])

                def walk(c):
                    for k in ("from", "to"):
                        if c.get(k):
                            addrs.add(c[k].lower())
                    for cc in c.get("calls", []) or []:
                        walk(cc)

                walk(trace)
            except Exception as e:  # noqa: BLE001
                print(f"  (trace failed for {tx['hash']}: {e})", file=sys.stderr)
    addrs.discard("0x0000000000000000000000000000000000000000")

    fixed = 0
    for a in sorted(addrs):
        g_bal = rpc(geth, "eth_getBalance", [a, "latest"])
        if rpc(anvil, "eth_getBalance", [a, "latest"]) != g_bal:
            rpc(anvil, "anvil_setBalance", [a, g_bal])
            fixed += 1
        g_nonce = rpc(geth, "eth_getTransactionCount", [a, "latest"])
        if rpc(anvil, "eth_getTransactionCount", [a, "latest"]) != g_nonce:
            rpc(anvil, "anvil_setNonce", [a, g_nonce])
            fixed += 1
    print(f"  corrected {fixed} balance/nonce field(s) across {len(addrs)} addrs")

    # --- 4. dump and persist as plain JSON (anvil --load-state wants utf-8) ---
    state_hex = rpc(anvil, "anvil_dumpState", [])
    raw = bytes.fromhex(state_hex[2:] if state_hex.startswith("0x") else state_hex)
    with gzip.GzipFile(fileobj=__import__("io").BytesIO(raw), mode="rb") as f:
        plain = f.read()
    with open(out_path, "wb") as f:
        f.write(plain)
    print(f"  wrote {out_path} ({len(plain):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
