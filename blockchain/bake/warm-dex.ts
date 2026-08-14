/**
 * Bake stage 1 — warm the DEX on a live Gnosis fork, and nothing else.
 *
 * A forked anvil fetches state lazily: only accounts and storage slots
 * something actually *wrote* to end up in a state dump. So this trades through
 * the real BZZ/WXDAI pool across a ladder of sizes — a swap only warms the
 * ticks it crosses, and a later trade of a different size would reach for
 * slots that were never fetched — and then sells the whole position back, so
 * the same ticks are warm in both directions and the pool is handed over near
 * the price it started at.
 *
 * Trading alone is not enough: a slot that is only ever read is dropped too,
 * which is how an early snapshot ended up answering `BZZ.decimals() = 0`. So
 * this also pins the storage behind the borrowed tokens' metadata, via
 * `warmReads`.
 *
 * It deliberately never touches PostageStamp, PriceOracle, StakeRegistry or
 * Redistribution. Untouched, they stay out of the dump and their addresses
 * load empty, which is what lets stage 2 deploy fresh contracts there.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BORROWED_TOKENS,
  BZZ,
  BZZ_POOL_FEE,
  DEV_FAUCET_ADDRESS,
  MAINNET,
  TOKEN_METADATA_ABI,
  XDAI,
  anvilSetBalance,
  assertChainId,
  beeNodeAddresses,
  gnosis,
  warmReads,
} from './chain';

const RPC_URL = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';

/**
 * The account that round-trips the ladder. Derived rather than random so two
 * bakes of the same fork block differ only where the chain does — a snapshot
 * you cannot diff is a snapshot you cannot review. It keeps nothing but gas
 * dust and the WXDAI it unwound into.
 */
const TRADER_PRIVATE_KEY = keccak256(toBytes('bee-compose bake trader'));

/**
 * Buy sizes to warm, in xDAI, ascending so each swap extends the warmed tick
 * range instead of re-crossing the same ones. The ladder's SUM is what matters
 * — it is how far up the curve the offline chain can still trade honestly.
 *
 * Sizing it means knowing how small the pool is: about 180 WXDAI against
 * 19 300 BZZ, roughly $1.2k of liquidity, so this ~49 xDAI ladder is around a
 * quarter of the quote side and moves the price hard on its way up. That is
 * the point — the range has to be warm before it is needed — but it also
 * bounds what the chain can serve: ~0.5 xDAI of buying shifts the price ~0.6%,
 * so a few hundred purchases, not an unlimited number. Re-bake past that.
 */
const BUY_LADDER_XDAI = [
  XDAI / 100n,
  XDAI / 20n,
  XDAI / 10n,
  XDAI / 4n,
  XDAI / 2n,
  XDAI,
  2n * XDAI,
  5n * XDAI,
  10n * XDAI,
  15n * XDAI,
  15n * XDAI,
];

/** Gas dust for the trader, on top of what it spends on BZZ. */
const TRADER_GAS_XDAI = XDAI;
/** Every Bee node pays its own gas out of the snapshot; nothing refills it. */
const BEE_NODE_XDAI = 100n * XDAI;
/**
 * And buys its own postage with this, for the node-side path (`POST /stamps`,
 * `bee-compose stamp`, `buy-stamp.sh`). A depth-20 stamp at the default amount
 * costs ~0.05 BZZ, so this is a few hundred of them per node.
 */
const BEE_NODE_BZZ = 10n * BZZ;
/**
 * Kept back from the ladder rather than sold, so the dev faucet can fund
 * identity accounts by transfer. ~2000 dev batches' worth. Together with the
 * nodes' float that is 340 BZZ — about 1.8% of the pool's BZZ side — left
 * permanently bought, which is the price of never having to trade for test
 * funding again.
 */
const FAUCET_BZZ_FLOAT = 250n * BZZ;
const FAUCET_XDAI = 100n * XDAI;

const SLIPPAGE_NUMERATOR = 995n;
const SLIPPAGE_DENOMINATOR = 1000n;
const DEADLINE_SECONDS = 600n;
const MILLIS_PER_SECOND = 1000n;

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: gnosis, transport });

function deadline(): bigint {
  return BigInt(Date.now()) / MILLIS_PER_SECOND + DEADLINE_SECONDS;
}

async function quoteOut(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: MAINNET.sushiQuoter,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee: BZZ_POOL_FEE, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

async function quoteIn(tokenIn: Address, tokenOut: Address, amount: bigint): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: MAINNET.sushiQuoter,
    abi: QUOTER_ABI,
    functionName: 'quoteExactOutputSingle',
    args: [{ tokenIn, tokenOut, amount, fee: BZZ_POOL_FEE, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

/**
 * One exact-input swap through the router. `value` carries native xDAI, which
 * the router wraps itself; a token-in swap needs an approval instead.
 */
async function swap(options: {
  privateKey: `0x${string}`;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  native: boolean;
}): Promise<bigint> {
  const account = privateKeyToAccount(options.privateKey);
  const wallet = createWalletClient({ account, chain: gnosis, transport });
  const expectedOut = await quoteOut(options.tokenIn, options.tokenOut, options.amountIn);

  if (!options.native) {
    const approval = await wallet.writeContract({
      address: options.tokenIn,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [MAINNET.sushiRouter, options.amountIn],
    });
    await publicClient.waitForTransactionReceipt({ hash: approval });
  }

  const hash = await wallet.writeContract({
    address: MAINNET.sushiRouter,
    abi: ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: options.tokenIn,
        tokenOut: options.tokenOut,
        fee: BZZ_POOL_FEE,
        recipient: account.address,
        deadline: deadline(),
        amountIn: options.amountIn,
        amountOutMinimum: (expectedOut * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR,
        sqrtPriceLimitX96: 0n,
      },
    ],
    value: options.native ? options.amountIn : 0n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`swap reverted: ${hash}`);
  }
  return expectedOut;
}

async function main(): Promise<void> {
  await assertChainId(RPC_URL);
  console.log(`fork at block ${await publicClient.getBlockNumber()}`);

  // Before anything trades: a token's metadata is only ever read, so without
  // this the offline chain answers `decimals() = 0` and formats every BZZ
  // amount 1e16 out, with nothing anywhere reporting a fault.
  const metadataCalls = BORROWED_TOKENS.flatMap((token) =>
    parseAbi(TOKEN_METADATA_ABI).map((entry) => ({
      to: token.address,
      data: encodeFunctionData({ abi: [entry], functionName: entry.name }),
    })),
  );
  const pinned = await warmReads(RPC_URL, metadataCalls);
  console.log(`pinned ${pinned} storage slots behind the borrowed tokens' metadata`);

  const trader = privateKeyToAccount(TRADER_PRIVATE_KEY).address;
  const budget = BUY_LADDER_XDAI.reduce((sum, amount) => sum + amount, 0n);
  await anvilSetBalance(RPC_URL, trader, budget + TRADER_GAS_XDAI);

  for (const amountXdai of BUY_LADDER_XDAI) {
    const out = await swap({
      privateKey: TRADER_PRIVATE_KEY,
      tokenIn: MAINNET.wxdai,
      tokenOut: MAINNET.bzz,
      amountIn: amountXdai,
      native: true,
    });
    // Warms the exact-output path the product quotes with, too.
    await quoteIn(MAINNET.wxdai, MAINNET.bzz, out);
    console.log(`bought ${out} PLUR BZZ for ${formatEther(amountXdai)} xDAI`);
  }

  const held = await publicClient.readContract({
    address: MAINNET.bzz,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [trader],
  });
  const kept = FAUCET_BZZ_FLOAT + BEE_NODE_BZZ * BigInt(beeNodeAddresses().length);
  if (held <= kept) {
    throw new Error(`ladder bought ${held} PLUR, not enough to keep back ${kept}`);
  }

  // Stock the faucet before unwinding, so dev tooling never has to trade.
  const traderWallet = createWalletClient({
    account: privateKeyToAccount(TRADER_PRIVATE_KEY),
    chain: gnosis,
    transport,
  });
  const floatHash = await traderWallet.writeContract({
    address: MAINNET.bzz,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [DEV_FAUCET_ADDRESS, FAUCET_BZZ_FLOAT],
  });
  await publicClient.waitForTransactionReceipt({ hash: floatHash });
  await anvilSetBalance(RPC_URL, DEV_FAUCET_ADDRESS, FAUCET_XDAI);
  console.log(
    `faucet ${DEV_FAUCET_ADDRESS}: ${FAUCET_BZZ_FLOAT} PLUR BZZ + ${formatEther(FAUCET_XDAI)} xDAI`,
  );

  // Every node pays its own gas and buys its own postage, and nothing refills
  // either — `bee-compose stamp` and POST /stamps spend the node's own BZZ.
  const nodes = beeNodeAddresses();
  for (const node of nodes) {
    await anvilSetBalance(RPC_URL, node, BEE_NODE_XDAI);
    const hash = await traderWallet.writeContract({
      address: MAINNET.bzz,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [node, BEE_NODE_BZZ],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  console.log(
    `funded ${nodes.length} Bee node EOAs with ${formatEther(BEE_NODE_XDAI)} xDAI + ${BEE_NODE_BZZ} PLUR BZZ each`,
  );

  // Hand the rest of the pool back where it started: the same ticks are now
  // warm in both directions, and a long-lived chain starts from an honest price.
  const unwound = held - FAUCET_BZZ_FLOAT - BEE_NODE_BZZ * BigInt(nodes.length);
  const returned = await swap({
    privateKey: TRADER_PRIVATE_KEY,
    tokenIn: MAINNET.bzz,
    tokenOut: MAINNET.wxdai,
    amountIn: unwound,
    native: false,
  });
  console.log(`sold ${unwound} PLUR BZZ back for ${formatEther(returned)} xDAI`);
}

main().catch((error: Error) => {
  console.error(`warm-dex: ${error.message}`);
  process.exit(1);
});
