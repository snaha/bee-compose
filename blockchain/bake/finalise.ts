/**
 * Bake stage 3 — splice back what a dump drops, then check the snapshot is
 * actually usable before it replaces the committed one.
 *
 * Anvil only dumps accounts something wrote to, so a contract the flows merely
 * CALL is absent on reload: every SushiSwap quote would return no data. Those
 * are fetched from upstream and merged in here.
 *
 * The assertions exist because every way this bake can go wrong is silent —
 * a missing quoter, an unfunded node, a Swarm contract that quietly landed
 * somewhere else — and each one only surfaces much later as a Bee node that
 * will not boot or a purchase that cannot be quoted.
 *
 *   pnpm exec tsx finalise.ts <dump> [--report <deploy report>]
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { MAINNET, READ_ONLY_CONTRACTS, SWARM_CONTRACTS, beeNodeAddresses, rpc } from './chain';

const UPSTREAM_RPC_URL = process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';

interface StateAccount {
  nonce: number;
  balance: string;
  code?: string;
  storage?: Record<string, string>;
}

interface DumpedState {
  accounts: Record<string, StateAccount>;
  best_block_number?: number;
}

interface DeployReport {
  postageStampStartBlock: number;
  lastPrice: number;
}

function accountOf(state: DumpedState, address: string): StateAccount | undefined {
  return state.accounts[address.toLowerCase()];
}

function assertHasCode(state: DumpedState, address: string, label: string): void {
  const account = accountOf(state, address);
  if (!account?.code || account.code === '0x') {
    throw new Error(`${label} (${address}) has no code in the snapshot`);
  }
}

async function main(): Promise<void> {
  const statePath = process.argv[2];
  if (!statePath) {
    throw new Error('usage: finalise.ts <dump> [--report <deploy report>]');
  }
  const reportIndex = process.argv.indexOf('--report');
  const report =
    reportIndex === -1
      ? undefined
      : (JSON.parse(readFileSync(process.argv[reportIndex + 1], 'utf8')) as DeployReport);

  const state = JSON.parse(readFileSync(statePath, 'utf8')) as DumpedState;

  for (const address of READ_ONLY_CONTRACTS) {
    const code = await rpc<string>(UPSTREAM_RPC_URL, 'eth_getCode', [address, 'latest']);
    if (code === '0x') {
      throw new Error(`No code at ${address} on ${UPSTREAM_RPC_URL}`);
    }
    state.accounts[address.toLowerCase()] = { nonce: 1, balance: '0x0', code, storage: {} };
    console.log(`spliced read-only code for ${address}`);
  }
  writeFileSync(statePath, JSON.stringify(state));

  assertHasCode(state, MAINNET.bzz, 'BZZ token');
  assertHasCode(state, MAINNET.wxdai, 'WXDAI');
  assertHasCode(state, MAINNET.sushiRouter, 'SushiSwap router');
  assertHasCode(state, MAINNET.sushiQuoter, 'SushiSwap quoter');
  assertHasCode(state, MAINNET.bzzWxdaiPool, 'BZZ/WXDAI pool');
  for (const spec of Object.values(SWARM_CONTRACTS)) {
    assertHasCode(state, spec.address, spec.name);
  }

  const unfunded = beeNodeAddresses().filter(
    (node) => BigInt(accountOf(state, node)?.balance ?? '0x0') === 0n,
  );
  if (unfunded.length > 0) {
    throw new Error(`Bee node EOAs have no xDAI for gas: ${unfunded.join(', ')}`);
  }

  const bytes = statSync(statePath).size;
  console.log(
    `\n${statePath}: ${bytes.toLocaleString()} bytes · ` +
      `${Object.keys(state.accounts).length} accounts · head ${state.best_block_number}`,
  );
  if (report) {
    console.log(
      `\ncompose.yml must carry:\n` +
        `  BEE_POSTAGE_STAMP_START_BLOCK: "${report.postageStampStartBlock}"\n` +
        `(the block PostageStamp was deployed in — a later value hides every\n` +
        ` BatchCreated event from the nodes.)`,
    );
  }
}

main().catch((error: Error) => {
  console.error(`finalise: ${error.message}`);
  process.exit(1);
});
