/**
 * Bake stage 2 — deploy the Swarm contracts from source onto the DEX-only
 * snapshot, landing each one on its Gnosis mainnet address.
 *
 * Runs against a plain (NOT forking) anvil loaded with stage 1's dump, where
 * those four addresses hold no code and no storage. That is what makes this
 * possible at all: CREATE refuses to overwrite an occupied address, and
 * clearing code on a fork would leave mainnet's storage readable underneath —
 * which is how the batch-tree hazard this chain exists to remove would sneak
 * back in.
 *
 * A CREATE address is keccak(rlp([deployer, nonce])), so impersonating each
 * contract's original deployer at its original nonce reproduces the address
 * exactly. It depends on nothing else — notably not the constructor arguments,
 * so StakeRegistry gets this cluster's network id rather than mainnet's.
 *
 * `forge script` cannot do this: it broadcasts from one sender at its natural
 * nonce.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getAddress,
  http,
  type Abi,
} from 'viem';
import {
  MAINNET,
  SWARM_CONTRACTS,
  SWARM_DEPLOYER,
  XDAI,
  anvilSetBalance,
  assertChainId,
  gnosis,
  rpc,
  toHex,
  type ContractSpec,
} from './chain';

const RPC_URL = process.env.DEPLOY_RPC_URL ?? 'http://127.0.0.1:18545';
const OUT_DIR = path.resolve(__dirname, '..', 'deploy', 'out');

const DEPLOYER_XDAI = 1000n * XDAI;

const MINIMUM_BUCKET_DEPTH = 16;
/**
 * The p2p network id of this cluster (compose.yml's BEE_NETWORK_ID), not
 * mainnet's 1 — staking has to agree with the nodes, and the address does not
 * depend on constructor arguments.
 */
const NETWORK_ID = 4020n;
/**
 * PriceOracle.setPrice silently clamps to its minimumPriceUpscaled floor
 * (24000 << 10), so this is the lowest price that is also the effective one.
 * Stamp amounts are checked against price * 17280, so a mismatch here would
 * quietly change what Bee accepts.
 */
const INITIAL_PRICE = 24000;

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: `0x${string}` };
}

function artifactOf(spec: ContractSpec): ForgeArtifact {
  const file = path.join(OUT_DIR, spec.artifact);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ForgeArtifact;
  } catch {
    throw new Error(`Missing ${file} — run \`forge build\` in blockchain/deploy first`);
  }
}

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: gnosis, transport });
const wallet = createWalletClient({ account: SWARM_DEPLOYER, chain: gnosis, transport });

/**
 * Deploy `spec` so it lands on its mainnet address, or fail loudly.
 * @returns the block the deployment landed in.
 */
async function deployAt(spec: ContractSpec, args: readonly unknown[]): Promise<bigint> {
  const occupant = await publicClient.getCode({ address: spec.address });
  if (occupant && occupant !== '0x') {
    throw new Error(
      `${spec.name}: ${spec.address} already holds code — stage 1 must never touch the Swarm contracts`,
    );
  }

  await anvilSetBalance(RPC_URL, SWARM_DEPLOYER, DEPLOYER_XDAI);
  await rpc(RPC_URL, 'anvil_setNonce', [SWARM_DEPLOYER, toHex(BigInt(spec.nonce))]);

  const artifact = artifactOf(spec);
  const hash = await wallet.sendTransaction({
    data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${spec.name}: deploy transaction reverted (${hash})`);
  }
  if (!receipt.contractAddress || getAddress(receipt.contractAddress) !== getAddress(spec.address)) {
    throw new Error(
      `${spec.name}: landed at ${receipt.contractAddress} instead of ${spec.address} — ` +
        `nonce ${spec.nonce} is wrong, or something else spent the deployer's nonce`,
    );
  }
  console.log(`${spec.name.padEnd(14)} ${spec.address}  (block ${receipt.blockNumber})`);
  return receipt.blockNumber;
}

/** Read an AccessControl role id off a contract rather than recomputing it. */
async function roleId(spec: ContractSpec, role: string): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: spec.address,
    abi: artifactOf(spec).abi,
    functionName: role,
  }) as Promise<`0x${string}`>;
}

async function send(spec: ContractSpec, functionName: string, args: readonly unknown[]): Promise<void> {
  const hash = await wallet.writeContract({
    address: spec.address,
    abi: artifactOf(spec).abi,
    functionName,
    args,
    chain: gnosis,
    account: SWARM_DEPLOYER,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${spec.name}.${functionName} reverted (${hash})`);
  }
}

async function main(): Promise<void> {
  await assertChainId(RPC_URL);
  await rpc(RPC_URL, 'anvil_impersonateAccount', [SWARM_DEPLOYER]);

  const { postageStamp, priceOracle, stakeRegistry, redistribution } = SWARM_CONTRACTS;
  const postageBlock = await deployAt(postageStamp, [MAINNET.bzz, MINIMUM_BUCKET_DEPTH]);
  await deployAt(priceOracle, [postageStamp.address]);
  await deployAt(stakeRegistry, [MAINNET.bzz, NETWORK_ID, priceOracle.address]);
  await deployAt(redistribution, [
    stakeRegistry.address,
    postageStamp.address,
    priceOracle.address,
  ]);

  // Role wiring: the oracle drives setPrice on postage, redistribution drives
  // the other two.
  await send(postageStamp, 'grantRole', [
    await roleId(postageStamp, 'PRICE_ORACLE_ROLE'),
    priceOracle.address,
  ]);
  await send(postageStamp, 'grantRole', [
    await roleId(postageStamp, 'REDISTRIBUTOR_ROLE'),
    redistribution.address,
  ]);
  await send(priceOracle, 'grantRole', [
    await roleId(priceOracle, 'PRICE_UPDATER_ROLE'),
    redistribution.address,
  ]);
  await send(stakeRegistry, 'grantRole', [
    await roleId(stakeRegistry, 'REDISTRIBUTOR_ROLE'),
    redistribution.address,
  ]);

  await send(priceOracle, 'setPrice', [INITIAL_PRICE]);
  // setPrice swallows a failing postage call and returns false, so confirm the
  // price actually landed — everything downstream sizes stamps against it.
  const lastPrice = (await publicClient.readContract({
    address: postageStamp.address,
    abi: artifactOf(postageStamp).abi,
    functionName: 'lastPrice',
  })) as bigint;
  if (lastPrice !== BigInt(INITIAL_PRICE)) {
    throw new Error(`PostageStamp.lastPrice is ${lastPrice}, expected ${INITIAL_PRICE}`);
  }
  console.log(`roles wired · price ${lastPrice} · batch tree empty`);

  await rpc(RPC_URL, 'anvil_stopImpersonatingAccount', [SWARM_DEPLOYER]);

  const reportPath = process.argv[2];
  if (reportPath) {
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          postageStampStartBlock: Number(postageBlock),
          lastPrice: Number(lastPrice),
          addresses: Object.fromEntries(
            Object.entries(SWARM_CONTRACTS).map(([key, spec]) => [key, spec.address]),
          ),
        },
        undefined,
        2,
      ),
    );
  }
}

main().catch((error: Error) => {
  console.error(`deploy-swarm: ${error.message}`);
  process.exit(1);
});
