/**
 * Buy postage the way the product buys it — swap xDAI for BZZ, approve,
 * createBatch — over and over against a RUNNING cluster chain.
 *
 * This is the regression the hybrid chain exists to prevent. On a plain
 * mainnet snapshot, PostageStamp.createBatch walks a red-black tree of every
 * batch on the chain, and a state dump only keeps storage something wrote to;
 * after a handful of purchases the traversal reached a node that was not there
 * and reverted BatchDoesNotExist() (0x4ee9bc0f) permanently. Contracts
 * deployed fresh start with an empty tree, so the traversal never leaves the
 * storage this chain actually has.
 *
 * It also probes the routed WXDAI→USDC→BZZ quote the product sizes drives
 * with: an under-warmed route is the other silent regression a bake can
 * reintroduce, and finalise.ts only asserts the pools carry code, not that
 * they answer.
 *
 * Ten purchases without a volume reset is the bar. Run it against a cluster
 * that has been up for a while, not a fresh one:
 *
 *   pnpm verify:chain
 */
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  formatEther,
  http,
  parseAbi,
  type Address,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  BZZ,
  BZZ_POOL_FEE,
  BZZ_USDC_POOL_FEE,
  MAINNET,
  SWARM_CONTRACTS,
  WXDAI_USDC_POOL_FEE,
  XDAI,
  anvilSetBalance,
  assertChainId,
  confirm,
  gnosis,
} from './chain';

const RPC_URL = process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:9545';

const PURCHASES = Number(process.env.PURCHASES ?? 12);
const DEPTH = 20;
/**
 * Per-chunk funding, as a multiple of the contract's own floor (17280 blocks
 * * price, i.e. ~24h of storage). The nodes accept batches funded this way
 * because they start from a chain state of `totalAmount: 0` — the freshly
 * deployed contracts emit the price update the node learns from, so there is
 * no synthetic outpayment baseline to clear. Override to reproduce a
 * differently funded purchase.
 */
const FLOOR_MULTIPLE = BigInt(process.env.FLOOR_MULTIPLE ?? 3);
const BUCKET_DEPTH = 16;
/**
 * Far more than a batch costs, so the DEX leg is genuinely exercised — but
 * bounded, because every run moves the real pool and offline nothing ever
 * moves it back. The direct pool these purchases go through prices honestly
 * for ~230 xDAI of cumulative buying — ~460 runs of this — before quotes
 * start drifting pessimistic; `down -v` re-seeds the snapshot and hands the
 * range back. See blockchain/README.md, "Limits".
 */
const SWAP_XDAI = XDAI / 2n;
const PAYER_XDAI = 2n * XDAI;
/**
 * Deliberately looser than the product's 0.5%: the quote is taken a block
 * before the swap lands, and anything else trading in between — another run of
 * this, a test suite, the dev UI — moves the price enough to trip a tight
 * guard. This tool exists to prove `createBatch` keeps working, so a slippage
 * revert here is noise, not a finding.
 */
const SLIPPAGE_NUMERATOR = 900n;
const SLIPPAGE_DENOMINATOR = 1000n;
const DEADLINE_SECONDS = 600n;
const MILLIS_PER_SECOND = 1000n;
const NONCE_BYTES = 32;

/**
 * A drive-sized exact-output probe through the WXDAI→USDC→BZZ route — quoted,
 * not traded, so it moves nothing. The product prices a purchase by asking
 * what N BZZ costs on both routes and taking the cheaper, and at drive sizes
 * only this route has the depth to answer; a bake that under-warms it makes
 * the offline chain refuse or misprice what mainnet accepts, and nothing
 * fails at bake time. This turns that regression into a red build instead.
 * 800 BZZ is roughly a depth-24 batch with a year of lifespan.
 */
const ROUTED_PROBE_BZZ = 800n * BZZ;
/** The exact-output path runs backwards: from the BZZ wanted to the WXDAI paid. */
const ROUTED_EXACT_OUTPUT_PATH = encodePacked(
  ['address', 'uint24', 'address', 'uint24', 'address'],
  [MAINNET.bzz, BZZ_USDC_POOL_FEE, MAINNET.usdc, WXDAI_USDC_POOL_FEE, MAINNET.wxdai],
);

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);
const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);
const ERC20_ABI = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);
const POSTAGE_ABI = parseAbi([
  'function createBatch(address _owner, uint256 _initialBalancePerChunk, uint8 _depth, uint8 _bucketDepth, bytes32 _nonce, bool _immutable) returns (bytes32)',
  'function batches(bytes32) view returns (address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag, uint256 normalisedBalance, uint256 lastUpdatedBlockNumber)',
  'function minimumInitialBalancePerChunk() view returns (uint256)',
  'function lastPrice() view returns (uint64)',
  'event BatchCreated(bytes32 indexed batchId, uint256 totalAmount, uint256 normalisedBalance, address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag)',
]);

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: gnosis, transport });
const postageStamp = SWARM_CONTRACTS.postageStamp.address;

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** `BatchDoesNotExist()` — the revert this whole chain design exists to avoid. */
const BATCH_DOES_NOT_EXIST = '0x4ee9bc0f';

/**
 * One line, and name the revert this tool exists to detect.
 *
 * This runs in CI now, so a red build should say whether the batch tree is
 * back rather than leave the next person to decode a selector out of viem's
 * several paragraphs. A deterministic revert is thrown by gas estimation
 * before a transaction is ever sent, so this has to cover thrown errors as
 * well as mined ones.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(BATCH_DOES_NOT_EXIST)) {
    return 'BatchDoesNotExist() — the batch-tree hazard is back, see blockchain/README.md';
  }
  const { shortMessage, details } = error as { shortMessage?: string; details?: string };
  return [shortMessage ?? message.split('\n')[0], details]
    .filter(Boolean)
    .join(' — ')
    .replace(/\s+/g, ' ');
}

/** See `ROUTED_PROBE_BZZ` — the routed half of what this tool watches for. */
async function assertRoutedQuote(): Promise<void> {
  let costXdai: bigint;
  try {
    const { result } = await publicClient.simulateContract({
      address: MAINNET.sushiQuoter,
      abi: QUOTER_ABI,
      functionName: 'quoteExactOutput',
      args: [ROUTED_EXACT_OUTPUT_PATH, ROUTED_PROBE_BZZ],
    });
    costXdai = result[0];
  } catch (error) {
    throw new Error(
      `the WXDAI→USDC→BZZ route cannot price ${ROUTED_PROBE_BZZ} PLUR — ` +
        `an under-warmed snapshot, see blockchain/README.md on pool sizes: ${describe(error)}`,
    );
  }
  console.log(
    `routed quote: ${ROUTED_PROBE_BZZ} PLUR via USDC costs ${formatEther(costXdai)} xDAI`,
  );
}

/**
 * Re-run a call that mined and reverted, so the revert names itself — a
 * receipt carries no reason. Best-effort: the chain has moved on by a block or
 * two, so a state-dependent failure may not reproduce, which is worth saying.
 */
async function replayForReason(request: Parameters<typeof publicClient.simulateContract>[0]) {
  try {
    await publicClient.simulateContract(request);
    return 'replayed cleanly, so the revert was state-dependent';
  } catch (error) {
    return describe(error);
  }
}

/** One purchase, start to finish, from a throwaway payer as the widget does. */
async function purchase(owner: Address, amountPerChunk: bigint): Promise<`0x${string}`> {
  const payerKey = generatePrivateKey();
  const account = privateKeyToAccount(payerKey);
  const wallet = createWalletClient({ account, chain: gnosis, transport });
  await anvilSetBalance(RPC_URL, account.address, PAYER_XDAI);

  const { result: quote } = await publicClient.simulateContract({
    address: MAINNET.sushiQuoter,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: MAINNET.wxdai,
        tokenOut: MAINNET.bzz,
        amountIn: SWAP_XDAI,
        fee: BZZ_POOL_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const swapHash = await wallet.writeContract({
    address: MAINNET.sushiRouter,
    abi: ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: MAINNET.wxdai,
        tokenOut: MAINNET.bzz,
        fee: BZZ_POOL_FEE,
        recipient: account.address,
        deadline: BigInt(Date.now()) / MILLIS_PER_SECOND + DEADLINE_SECONDS,
        amountIn: SWAP_XDAI,
        amountOutMinimum: (quote[0] * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR,
        sqrtPriceLimitX96: 0n,
      },
    ],
    value: SWAP_XDAI,
  });
  // Checked, because a swap that loses to slippage leaves the payer with no
  // BZZ and the failure then lands on createBatch — reading as the very
  // regression this tool is watching for.
  await confirm(publicClient, swapHash, 'swap');

  const total = amountPerChunk << BigInt(DEPTH);
  const approveHash = await wallet.writeContract({
    address: MAINNET.bzz,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [postageStamp, total],
  });
  await confirm(publicClient, approveHash, 'approve');

  const createBatch = {
    address: postageStamp,
    abi: POSTAGE_ABI,
    functionName: 'createBatch',
    args: [owner, amountPerChunk, DEPTH, BUCKET_DEPTH, randomNonce(), false],
  } as const;
  const createHash = await wallet.writeContract(createBatch);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (receipt.status !== 'success') {
    // The old failure mode surfaced exactly here, and only after several
    // successful purchases — hence the loop. A receipt carries no reason, so
    // replay the call to make it name itself: this runs in CI now, and a red
    // build should say whether the batch tree is back rather than leave the
    // next person to re-derive it.
    throw new Error(
      `createBatch reverted (${createHash}): ${await replayForReason({ ...createBatch, account })}`,
    );
  }
  const batchId = receipt.logs.find((log) => log.address.toLowerCase() === postageStamp.toLowerCase())
    ?.topics[1];
  if (!batchId) {
    throw new Error(`no BatchCreated event in ${createHash}`);
  }
  return batchId;
}

async function main(): Promise<void> {
  await assertChainId(RPC_URL);
  const [floor, price] = await Promise.all([
    publicClient.readContract({
      address: postageStamp,
      abi: POSTAGE_ABI,
      functionName: 'minimumInitialBalancePerChunk',
    }),
    publicClient.readContract({ address: postageStamp, abi: POSTAGE_ABI, functionName: 'lastPrice' }),
  ]);
  const amountPerChunk = floor * FLOOR_MULTIPLE;
  console.log(
    `chain at block ${await publicClient.getBlockNumber()} · price ${price} · ` +
      `floor ${floor} PLUR/chunk · funding ${amountPerChunk} at depth ${DEPTH}`,
  );

  await assertRoutedQuote();

  const owner = privateKeyToAccount(generatePrivateKey()).address;
  for (let index = 1; index <= PURCHASES; index += 1) {
    const batchId = await purchase(owner, amountPerChunk);
    const [batchOwner, depth] = await publicClient.readContract({
      address: postageStamp,
      abi: POSTAGE_ABI,
      functionName: 'batches',
      args: [batchId],
    });
    if (batchOwner.toLowerCase() !== owner.toLowerCase() || depth !== DEPTH) {
      throw new Error(`batch ${batchId} read back as owner ${batchOwner} depth ${depth}`);
    }
    console.log(`${String(index).padStart(2)}/${PURCHASES}  ${batchId}`);
  }

  console.log(
    `\n${PURCHASES} purchases, no BatchDoesNotExist() — ` +
      `${formatEther(SWAP_XDAI * BigInt(PURCHASES))} xDAI traded through the pool.`,
  );
}

main().catch((error: unknown) => {
  console.error(`verify-purchases: ${describe(error)}`);
  process.exit(1);
});
