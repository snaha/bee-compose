// Resolve the queen's libp2p multiaddr from its /addresses endpoint and build
// the multiaddr workers use as BEE_BOOTNODE. Mirrors scripts/workers-up.sh.
//
// We use the DNS name `queen` (not 127.0.0.1) so the multiaddr is stable across
// container recreates: the IP can change, the peer id can't (it's derived from
// the baked libp2p key).
const DEFAULT_QUEEN_API = 'http://127.0.0.1:1633';
const POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 24;

interface AddressesResponse {
  underlay?: string[];
}

export async function resolveQueenBootnode(api: string = DEFAULT_QUEEN_API): Promise<string> {
  const peerId = await resolveQueenPeerId(api);
  return `/dns4/queen/tcp/1634/p2p/${peerId}`;
}

async function resolveQueenPeerId(api: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const peerId = await tryFetchPeerId(api);
    if (peerId) return peerId;

    if (attempt < MAX_ATTEMPTS) {
      console.log(`  waiting for queen API... (${attempt}/${MAX_ATTEMPTS})`);
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Could not resolve queen peer id from ${api}/addresses — is the queen container healthy?`,
  );
}

async function tryFetchPeerId(api: string): Promise<string | null> {
  try {
    const res = await fetch(`${api}/addresses`);
    if (!res.ok) return null;
    const data = (await res.json()) as AddressesResponse;
    for (const addr of data.underlay ?? []) {
      const m = addr.match(/\/p2p\/([A-Za-z0-9]+)$/);
      if (m) return m[1];
    }
  } catch {
    // Fetch errors during boot are expected (connection refused while bee starts).
    // Fall through to the retry loop.
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
