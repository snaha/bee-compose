/**
 * Pieces shared by the three bake stages: the mainnet addresses the snapshot
 * borrows, the Bee node identities it funds, and the JSON-RPC/anvil cheats
 * both the warm and the deploy stage drive.
 *
 * See blockchain/README.md for why the chain is split this way.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { createTestClient, http, parseAbi, type Chain } from 'viem';
import { gnosis as gnosisMainnet } from 'viem/chains';

/** Gnosis mainnet, the chain the snapshot answers as. */
export const CHAIN_ID = gnosisMainnet.id;

/**
 * Gnosis' own definition with its RPC list blanked: every stage is handed the
 * endpoint it should talk to, and nothing in a bake should be able to fall back
 * to the real network.
 */
export const gnosis: Chain = { ...gnosisMainnet, rpcUrls: { default: { http: [] } } };

/**
 * Anvil's cheats, typed. Every stage drives the chain through one of these
 * rather than hand-rolling `anvil_*` payloads — `setBalance`, `setNonce`,
 * `impersonateAccount`, `setStorageAt` are all viem actions.
 */
export function testClient(url: string) {
  return createTestClient({ mode: 'anvil', chain: gnosis, transport: http(url) });
}

/**
 * What the snapshot takes from mainnet: a BZZ market cannot be deployed, only
 * borrowed. Everything here is warmed by real trades during stage 1 so it
 * replays offline.
 */
export const MAINNET = {
  bzz: '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da',
  wxdai: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
  /**
   * Gnosis USDC — the bridged one (symbol `USDC`). NOT `USDC.e` at `0x2a22…`,
   * which is a different token with no BZZ pool at all.
   */
  usdc: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
  sushiRouter: '0x4F54dd2F4f30347d841b7783aD08c050d8410a9d',
  sushiQuoter: '0xb1E835Dc2785b52265711e17fCCb0fd018226a6e',
  bzzWxdaiPool: '0x7583b9c573fa4fb5ea21c83454939c4cf6aacbc3',
  bzzUsdcPool: '0x6f30b7cf40cb423c1d23478a9855701ecf43931e',
  wxdaiUsdcPool: '0xf5e270c0d97f88efb023a161b9fcc5d0c7ad0b70',
} as const;

/** The BZZ/WXDAI pool's fee tier, in hundredths of a bip. */
export const BZZ_POOL_FEE = 3000;
/** The BZZ/USDC pool's — the deeper of BZZ's two pools, by an order of magnitude. */
export const BZZ_USDC_POOL_FEE = 3000;
/** The WXDAI/USDC pool's. Two dollars against each other, so the 0.01% tier. */
export const WXDAI_USDC_POOL_FEE = 100;

export interface ContractSpec {
  name: string;
  /** Path under blockchain/deploy/out/, as `forge build` lays it out. */
  artifact: string;
  address: `0x${string}`;
  /** The deployer's nonce in the original mainnet deployment. */
  nonce: number;
}

/**
 * Every Swarm contract on Gnosis was deployed by this one EOA, so stage 2
 * deploys them in nonce order too.
 */
export const SWARM_DEPLOYER: `0x${string}` = '0x647942035bb69C8e4d7EB17C8313EBC50b0bABFA';

/**
 * The contracts deployed from source, and the mainnet addresses they must land
 * on. Deployer and nonce come from each one's creation transaction; a CREATE
 * address is keccak(rlp([deployer, nonce])), so those two values are all it
 * takes to reproduce the address.
 */
export const SWARM_CONTRACTS = {
  postageStamp: {
    name: 'PostageStamp',
    artifact: 'PostageStamp.sol/PostageStamp.json',
    address: '0x45a1502382541Cd610CC9068e88727426b696293',
    nonce: 6891,
  },
  priceOracle: {
    name: 'PriceOracle',
    artifact: 'PriceOracle.sol/PriceOracle.json',
    address: '0x47EeF336e7fE5bED98499A4696bce8f28c1B0a8b',
    nonce: 7039,
  },
  stakeRegistry: {
    name: 'StakeRegistry',
    artifact: 'Staking.sol/StakeRegistry.json',
    address: '0xda2a16EE889E7F04980A8d597b48c8D51B9518F4',
    nonce: 7059,
  },
  redistribution: {
    name: 'Redistribution',
    artifact: 'Redistribution.sol/Redistribution.json',
    address: '0x5069cdfB3D9E56d23B1cAeE83CE6109A7E4fd62d',
    nonce: 7070,
  },
} as const satisfies Record<string, ContractSpec>;

/**
 * Contracts the flows only ever CALL. Anvil drops them from a state dump —
 * nothing wrote to them — so an offline replay finds no code there and every
 * quote returns empty. Spliced back in by finalise.ts.
 *
 * The Swarm contracts used to be on this list. They are deployed from source
 * now, which is the whole point of the hybrid chain.
 */
export const READ_ONLY_CONTRACTS: readonly `0x${string}`[] = [MAINNET.sushiQuoter];

export const XDAI = 10n ** 18n;
/** BZZ carries 16 decimals, so one BZZ is 1e16 PLUR. */
export const BZZ = 10n ** 16n;

/**
 * A dev faucet the bake leaves holding xDAI and a float of BZZ, so local
 * tooling can hand an identity account what it needs with a plain transfer
 * instead of trading on the pool — every dev swap moves a real, thin market,
 * and the chain is long-lived.
 *
 * The key is `keccak256("bee-compose dev faucet")`: publicly known by
 * construction, worthless anywhere but here, and re-derivable rather than
 * memorised. Deliberately NOT a Bee node's key (those pay gas and should not
 * hold value) and not one of anvil's defaults, which carry mainnet code and
 * nonces on a Gnosis fork.
 */
export const DEV_FAUCET_PRIVATE_KEY: `0x${string}` =
  '0xc50a4bc364bb2f90007c01e3dc68c5bbc5451d4f7465510e8cffde8c137e6cf9';
export const DEV_FAUCET_ADDRESS: `0x${string}` = '0xF406AebbF610A9c54589e7EbE25b8e6621258410';

export const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * What every borrowed token must still answer offline, and with what. A
 * getter that reads a storage slot nothing wrote to comes back zero, which is
 * silent and wrong rather than broken — see `warmReads` below.
 */
export const BORROWED_TOKENS = [
  { name: 'BZZ', address: MAINNET.bzz, decimals: 16 },
  { name: 'WXDAI', address: MAINNET.wxdai, decimals: 18 },
  { name: 'USDC', address: MAINNET.usdc, decimals: 6 },
] as const;

/**
 * The metadata every ERC20 consumer reads before it formats an amount. Kept as
 * signatures rather than a parsed ABI because stage 1 iterates the entries to
 * build one `warmReads` call per getter.
 */
export const TOKEN_METADATA_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
] as const;

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  ...TOKEN_METADATA_ABI,
]);

/**
 * SushiSwap V3's quoter and router, as the bake and `verify:chain` both use
 * them — the single-hop entries for the direct BZZ/WXDAI pool, the packed-path
 * ones for the WXDAI→USDC→BZZ route. The quoter is `eth_call`-only and
 * non-view by signature, so callers reach it through `simulateContract`.
 */
export const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
  'function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

export const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
]);

const DEADLINE_SECONDS = 600n;
const MILLIS_PER_SECOND = 1000n;

/**
 * A router deadline ten minutes out. Slippage tolerance deliberately stays with
 * each caller: the bake's 0.5% and `verify:chain`'s 10% differ on purpose.
 */
export function deadline(): bigint {
  return BigInt(Date.now()) / MILLIS_PER_SECOND + DEADLINE_SECONDS;
}

/**
 * The EOAs Bee derives from the baked keystores in bee/data/. They pay gas for
 * everything the nodes do on chain, so the snapshot has to fund them — there
 * is no faucet on an offline chain.
 */
export function beeNodeAddresses(): `0x${string}`[] {
  const dataDir = path.join(repoRoot, 'bee', 'data');
  const addresses = readdirSync(dataDir)
    .sort()
    .map((role) => path.join(dataDir, role, 'keys', 'swarm.key'))
    .filter((keystore) => existsSync(keystore))
    .map((keystore) => {
      const { address } = JSON.parse(readFileSync(keystore, 'utf8')) as {
        address: string;
      };
      return `0x${address}` as `0x${string}`;
    });
  if (addresses.length === 0) {
    throw new Error(`No Bee keystores under ${dataDir}`);
  }
  return addresses;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

/**
 * The JSON-RPC calls viem has no action for: `debug_traceCall` with
 * `prestateTracer` (below), stage 3 reading code off a plain upstream endpoint
 * with no client behind it, and the raw probe reads that pair with the trace
 * in `setTokenBalance`. Everything anvil-shaped goes through `testClient`
 * instead.
 *
 * Kept rather than folded into `TestClient.request` because the bake's failure
 * text is load-bearing — `${method}: ${message}` is the whole error a broken
 * bake reports, and it stays readable.
 */
export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as JsonRpcResponse<T>;
  if (body.error) {
    throw new Error(`${method}: ${body.error.message ?? 'unknown error'}`);
  }
  if (body.result === undefined) {
    throw new Error(`${method}: empty result`);
  }
  return body.result;
}

interface ReceiptWaiter {
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
  }): Promise<{ status: 'success' | 'reverted' }>;
}

/**
 * Wait for a transaction and fail where it failed.
 *
 * A reverted transaction still produces a receipt, so an unchecked wait defers
 * the error to whichever later step first misses its effect — a swap that lost
 * to slippage surfaces as `createBatch` reverting, which is precisely the
 * signal these scripts exist to watch for. Every send goes through here.
 */
export async function confirm(
  client: ReceiptWaiter,
  hash: `0x${string}`,
  label: string,
): Promise<void> {
  const { status } = await client.waitForTransactionReceipt({ hash });
  if (status !== 'success') {
    throw new Error(`${label} reverted (${hash})`);
  }
}

interface PrestateAccount {
  storage?: Record<string, `0x${string}`>;
}

/**
 * Make the storage a read-only call depends on survive the dump.
 *
 * A forked anvil fetches state lazily and dumps only what something *wrote*
 * to, so a slot that is merely read reloads as zero: `BZZ.decimals()` came
 * back 0 and `symbol()` empty, which is worse than a missing contract because
 * nothing errors — a consumer just formats every amount 1e16 out.
 *
 * `prestateTracer` reports every slot a call touches, including through a
 * proxy's delegatecall. Writing each one back with the value it already holds
 * changes nothing on chain and marks it dirty, so it lands in the dump.
 *
 * @returns how many slots were pinned.
 */
export async function warmReads(
  url: string,
  calls: readonly { to: `0x${string}`; data: `0x${string}` }[],
): Promise<number> {
  const test = testClient(url);
  let pinned = 0;
  for (const call of calls) {
    const prestate = await rpc<Record<string, PrestateAccount>>(url, 'debug_traceCall', [
      call,
      'latest',
      { tracer: 'prestateTracer' },
    ]);
    for (const [address, account] of Object.entries(prestate)) {
      for (const [slot, value] of Object.entries(account.storage ?? {})) {
        await test.setStorageAt({
          address: address as `0x${string}`,
          index: slot as `0x${string}`,
          value,
        });
        pinned += 1;
      }
    }
  }
  return pinned;
}

/**
 * Give `holder` a balance of an ERC20 the bake cannot buy in any quantity.
 *
 * The faucet hands test accounts what they need instead of making them trade,
 * and for BZZ that works by keeping some of the ladder back. USDC has no such
 * source: the WXDAI/USDC pool holds barely a thousand of them, so buying a
 * float big enough to be useful would move a price the product then measures
 * itself against. This writes the balance instead — the same fabrication
 * `setBalance` already performs for native xDAI, one token along.
 *
 * `totalSupply` is deliberately left alone and so no longer equals the sum of
 * balances. Nothing on this chain reads it, and a dev faucet that pretends to
 * be a mint would be the bigger lie.
 *
 * The slot is FOUND, not assumed: `prestateTracer` reports what `balanceOf`
 * touches — through a proxy's delegatecall too — and each candidate is then
 * proven by writing it and reading the balance back, restoring any that were
 * not it. A hardcoded mapping index would be a silent wrong answer the first
 * time a token upgraded its layout.
 */
export async function setTokenBalance(
  url: string,
  token: `0x${string}`,
  holder: `0x${string}`,
  amount: bigint,
): Promise<`0x${string}`> {
  const test = testClient(url);
  // balanceOf(address) — encoded by hand: the probe rides the same raw
  // JSON-RPC the trace below does.
  const call = {
    to: token,
    data: `0x70a08231${holder.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`,
  };
  /**
   * Undefined rather than a throw when the call comes back unreadable. A
   * candidate slot is a guess, and one of the guesses on a proxied token is the
   * EIP-1967 implementation pointer — overwrite that and every call returns
   * `0x`, which has to read as "wrong slot, put it back" rather than as a bake
   * failure.
   */
  const read = async (): Promise<bigint | undefined> => {
    const raw = await rpc<string>(url, 'eth_call', [call, 'latest']).catch(() => '0x');
    return raw === '0x' ? undefined : BigInt(raw);
  };
  const target = `0x${amount.toString(16).padStart(64, '0')}` as `0x${string}`;

  const prestate = await rpc<Record<string, PrestateAccount>>(url, 'debug_traceCall', [
    call,
    'latest',
    { tracer: 'prestateTracer' },
  ]);
  const candidates = Object.keys(prestate[token.toLowerCase()]?.storage ?? {});
  for (const slot of candidates) {
    const before = await rpc<`0x${string}`>(url, 'eth_getStorageAt', [token, slot, 'latest']);
    await test.setStorageAt({ address: token, index: slot as `0x${string}`, value: target });
    if ((await read()) === amount) {
      return slot as `0x${string}`;
    }
    // Always put a wrong guess back before trying the next one, or the token is
    // left holding whichever slots were probed on the way past.
    await test.setStorageAt({ address: token, index: slot as `0x${string}`, value: before });
  }
  throw new Error(
    `could not find the balance slot for ${token} (traced ${candidates.length} candidates)`,
  );
}

export async function assertChainId(url: string): Promise<void> {
  const chainId = await rpc<string>(url, 'eth_chainId');
  if (Number.parseInt(chainId, 16) !== CHAIN_ID) {
    throw new Error(`Expected chain ${CHAIN_ID} at ${url}, got ${Number.parseInt(chainId, 16)}`);
  }
}
