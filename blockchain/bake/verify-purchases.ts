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
 * Ten purchases without a volume reset is the bar. Run it against a cluster
 * that has been up for a while, not a fresh one:
 *
 *   pnpm verify:chain
 */
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseAbi,
  type Address,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BZZ_POOL_FEE, MAINNET, SWARM_CONTRACTS, XDAI, anvilSetBalance, assertChainId, gnosis } from './chain';

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
 * bounded, because every run moves the real pool and the bake only warms so
 * much of the curve.
 */
const SWAP_XDAI = XDAI / 2n;
const PAYER_XDAI = 2n * XDAI;
const SLIPPAGE_NUMERATOR = 995n;
const SLIPPAGE_DENOMINATOR = 1000n;
const DEADLINE_SECONDS = 600n;
const MILLIS_PER_SECOND = 1000n;
const NONCE_BYTES = 32;

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
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
  await publicClient.waitForTransactionReceipt({ hash: swapHash });

  const total = amountPerChunk << BigInt(DEPTH);
  const approveHash = await wallet.writeContract({
    address: MAINNET.bzz,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [postageStamp, total],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const createHash = await wallet.writeContract({
    address: postageStamp,
    abi: POSTAGE_ABI,
    functionName: 'createBatch',
    args: [owner, amountPerChunk, DEPTH, BUCKET_DEPTH, randomNonce(), false],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (receipt.status !== 'success') {
    // The old failure mode surfaced exactly here, and only after several
    // successful purchases — hence the loop.
    throw new Error(`createBatch reverted (${createHash})`);
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

main().catch((error: Error) => {
  console.error(`verify-purchases: ${error.message}`);
  process.exit(1);
});
