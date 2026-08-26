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
 * BZZ has TWO pools, and the product trades through whichever fills better, so
 * both are warmed: the direct BZZ/WXDAI one, and the WXDAI→USDC→BZZ path. That
 * is not an optimisation. BZZ/WXDAI holds ~167 WXDAI against BZZ/USDC's ~3 055
 * USDC, so a drive-sized purchase — a depth-24 batch with a year of lifespan is
 * ~823 BZZ — is a market move through the first and an ordinary trade through
 * the second. Warm only the direct pool and the offline chain silently prices
 * every purchase the expensive way while production routes around it: the local
 * chain then refuses buys that mainnet accepts, which is the worst kind of
 * difference to debug.
 *
 * It deliberately never touches PostageStamp, PriceOracle, StakeRegistry or
 * Redistribution. Untouched, they stay out of the dump and their addresses
 * load empty, which is what lets stage 2 deploy fresh contracts there.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
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
  BZZ_USDC_POOL_FEE,
  DEV_FAUCET_ADDRESS,
  MAINNET,
  TOKEN_METADATA_ABI,
  WXDAI_USDC_POOL_FEE,
  XDAI,
  anvilSetBalance,
  assertChainId,
  beeNodeAddresses,
  confirm,
  gnosis,
  setTokenBalance,
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
 * Sizing it means knowing how small the pool is: about 167 WXDAI against
 * 19 600 BZZ, roughly $1.2k of liquidity. This ladder stops at ~9 xDAI in
 * total, which is where the pool still fills honestly — by then the price has
 * already climbed ~9%, and a ladder reaching 49 xDAI (as this one did) pushed
 * it 20% and then reverted outright when the next rung found no liquidity left
 * in range. That failure was luck-of-the-fork-block, which is the worst way for
 * a bake to be wrong.
 *
 * It can stop there because it no longer has to carry the large trades: those
 * go through `ROUTED_LADDER_XDAI` and the pool that actually has the depth for
 * them. What is left for the direct pool is the small end, where the two routes
 * price the same — and `verify-purchases.ts`, whose twelve depth-20 stamps cost
 * ~0.03 xDAI between them.
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
];

/**
 * The same idea for the routed path, but sized to what a drive actually costs
 * rather than to what the thin pool can bear. At the current price a depth-22
 * batch with a year of lifespan is ~9 xDAI, depth-24 ~36, depth-26 ~150 — so a
 * ladder that stops below that leaves the offline chain unable to price the
 * purchases the product exists to make.
 *
 * It can be this much larger because the route is: BZZ/USDC holds ~3 055 USDC
 * and WXDAI/USDC ~1 172 USDC, against BZZ/WXDAI's ~167 WXDAI. The whole ladder
 * is bought and then sold straight back, so what it leaves behind is warm ticks
 * rather than a moved price.
 */
const ROUTED_LADDER_XDAI = [
  XDAI / 100n,
  XDAI / 10n,
  XDAI / 2n,
  XDAI,
  5n * XDAI,
  15n * XDAI,
  40n * XDAI,
  75n * XDAI,
  150n * XDAI,
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
/**
 * And a float of each token a payment can be made in, so the faucet can hand
 * one over instead of sending a developer to trade for it. Written directly
 * rather than bought: the WXDAI/USDC pool holds barely a thousand USDC, so
 * buying a useful float would move the very price the product measures its own
 * slippage against. See `setTokenBalance`.
 *
 * Sized for hundreds of test purchases, not to look like a market — a test
 * drive costs cents, and the largest real one is ~$150.
 */
const FAUCET_USDC_FLOAT = 5_000n * 10n ** 6n;
const FAUCET_WXDAI_FLOAT = 5_000n * XDAI;

const SLIPPAGE_NUMERATOR = 995n;
const SLIPPAGE_DENOMINATOR = 1000n;
const DEADLINE_SECONDS = 600n;
const MILLIS_PER_SECOND = 1000n;

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
  'function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
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
    await confirm(publicClient, approval, `approve ${options.tokenIn}`);
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
  await confirm(publicClient, hash, 'swap');
  return expectedOut;
}

/**
 * The packed multi-hop path. Exact-INPUT paths run from what is spent to what
 * is wanted; exact-OUTPUT paths run backwards. Both are warmed, because the
 * product quotes with one and swaps with the other.
 */
function routedPath(direction: 'input' | 'output'): `0x${string}` {
  const types = ['address', 'uint24', 'address', 'uint24', 'address'] as const;
  return direction === 'input'
    ? encodePacked(types, [
        MAINNET.wxdai,
        WXDAI_USDC_POOL_FEE,
        MAINNET.usdc,
        BZZ_USDC_POOL_FEE,
        MAINNET.bzz,
      ])
    : encodePacked(types, [
        MAINNET.bzz,
        BZZ_USDC_POOL_FEE,
        MAINNET.usdc,
        WXDAI_USDC_POOL_FEE,
        MAINNET.wxdai,
      ]);
}

/** One exact-input swap along a multi-hop path, in either direction. */
async function swapRouted(options: {
  privateKey: `0x${string}`;
  amountIn: bigint;
  /** WXDAI→BZZ carries native value; BZZ→WXDAI needs an approval first. */
  buying: boolean;
}): Promise<bigint> {
  const account = privateKeyToAccount(options.privateKey);
  const wallet = createWalletClient({ account, chain: gnosis, transport });
  const path = routedPath(options.buying ? 'input' : 'output');
  const { result } = await publicClient.simulateContract({
    address: MAINNET.sushiQuoter,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInput',
    args: [path, options.amountIn],
  });
  const expectedOut = result[0];

  if (!options.buying) {
    const approval = await wallet.writeContract({
      address: MAINNET.bzz,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [MAINNET.sushiRouter, options.amountIn],
    });
    await confirm(publicClient, approval, 'approve BZZ for the routed sell');
  }

  const hash = await wallet.writeContract({
    address: MAINNET.sushiRouter,
    abi: ROUTER_ABI,
    functionName: 'exactInput',
    args: [
      {
        path,
        recipient: account.address,
        deadline: deadline(),
        amountIn: options.amountIn,
        amountOutMinimum: (expectedOut * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR,
      },
    ],
    value: options.buying ? options.amountIn : 0n,
  });
  await confirm(publicClient, hash, 'routed swap');
  return expectedOut;
}

/**
 * Warm the exact-OUTPUT path too. The product sizes a purchase by asking what
 * N BZZ costs, and that quote reads slots an exact-input swap never touches.
 */
async function warmRoutedExactOutput(bzzOut: bigint): Promise<void> {
  await publicClient.simulateContract({
    address: MAINNET.sushiQuoter,
    abi: QUOTER_ABI,
    functionName: 'quoteExactOutput',
    args: [routedPath('output'), bzzOut],
  });
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
  const sum = (ladder: readonly bigint[]) => ladder.reduce((total, one) => total + one, 0n);
  const budget = sum(BUY_LADDER_XDAI) + sum(ROUTED_LADDER_XDAI);
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

  // The routed path, warmed the same way. Each route is unwound into the pool
  // it came from, so both are left warm in both directions and neither is
  // handed over at a price the other moved.
  let routedBzz = 0n;
  for (const amountXdai of ROUTED_LADDER_XDAI) {
    const out = await swapRouted({
      privateKey: TRADER_PRIVATE_KEY,
      amountIn: amountXdai,
      buying: true,
    });
    routedBzz += out;
    await warmRoutedExactOutput(out);
    console.log(`routed ${out} PLUR BZZ for ${formatEther(amountXdai)} xDAI via USDC`);
  }

  /**
   * The BZZ that stays bought — the faucet's float and the nodes' postage — is
   * kept back HERE, out of the routed ladder, and never out of the direct one.
   * BZZ/WXDAI holds ~167 WXDAI, so buying 340 BZZ through it means shoving a
   * fifth of the pool's quote side up the curve and leaving it there; through
   * BZZ/USDC the same float is a rounding error. The direct ladder is unwound
   * whole for exactly that reason.
   */
  const kept = FAUCET_BZZ_FLOAT + BEE_NODE_BZZ * BigInt(beeNodeAddresses().length);
  if (routedBzz <= kept) {
    throw new Error(`routed ladder bought ${routedBzz} PLUR, not enough to keep back ${kept}`);
  }
  const routedBack = await swapRouted({
    privateKey: TRADER_PRIVATE_KEY,
    amountIn: routedBzz - kept,
    buying: false,
  });
  console.log(
    `sold ${routedBzz - kept} PLUR BZZ back through USDC for ${formatEther(routedBack)} WXDAI, ` +
      `keeping ${kept} PLUR`,
  );

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
  await confirm(publicClient, floatHash, 'faucet BZZ transfer');
  await anvilSetBalance(RPC_URL, DEV_FAUCET_ADDRESS, FAUCET_XDAI);
  console.log(
    `faucet ${DEV_FAUCET_ADDRESS}: ${FAUCET_BZZ_FLOAT} PLUR BZZ + ${formatEther(FAUCET_XDAI)} xDAI`,
  );

  // The payment tokens, written straight onto the faucet. Done here rather than
  // after the unwind because it touches no pool at all: nothing about the
  // ladder's accounting changes.
  const usdcSlot = await setTokenBalance(
    RPC_URL,
    MAINNET.usdc,
    DEV_FAUCET_ADDRESS,
    FAUCET_USDC_FLOAT,
  );
  const wxdaiSlot = await setTokenBalance(
    RPC_URL,
    MAINNET.wxdai,
    DEV_FAUCET_ADDRESS,
    FAUCET_WXDAI_FLOAT,
  );
  console.log(
    `faucet stocked with ${FAUCET_USDC_FLOAT} USDC (slot ${usdcSlot}) and ` +
      `${formatEther(FAUCET_WXDAI_FLOAT)} WXDAI (slot ${wxdaiSlot})`,
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
    await confirm(publicClient, hash, `BZZ transfer to ${node}`);
  }
  console.log(
    `funded ${nodes.length} Bee node EOAs with ${formatEther(BEE_NODE_XDAI)} xDAI + ${BEE_NODE_BZZ} PLUR BZZ each`,
  );

  // Hand the direct pool back everything the direct ladder took: the same ticks
  // are now warm in both directions, and a long-lived chain starts from an
  // honest price. Whatever is left at this point IS the direct ladder's
  // purchase — the routed one was already unwound, and the float paid out.
  const unwound = await publicClient.readContract({
    address: MAINNET.bzz,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [trader],
  });
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
