import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { run } from '../lib/exec';
import { packageRoot, composeFile } from '../lib/paths';

const gunzip = promisify(zlib.gunzip);

export interface RedeployOptions {
  foundryImage?: string;
}

// Anvil's first default account — well-known dev key, not secret.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEFAULT_FOUNDRY_IMAGE = 'ghcr.io/foundry-rs/foundry:stable';
const ANVIL_HOST_PORT = '18545';
const ANVIL_BOOT_TIMEOUT_MS = 30_000;
const ANVIL_BOOT_POLL_MS = 1_000;

// Submodule paths under blockchain/deploy/lib/. These are listed explicitly
// rather than recursively because OZ pulls in halmos-cheatcodes / forge-std
// nested clones whose presence trips Foundry's auto-detected remappings.
const SUBMODULES = [
  'blockchain/deploy/lib/forge-std',
  'blockchain/deploy/lib/openzeppelin-contracts',
  'blockchain/deploy/lib/openzeppelin-contracts-v3-solc-0.7',
  'blockchain/deploy/lib/storage-incentives',
  'blockchain/deploy/lib/swap-swear-and-swindle',
];

interface JsonRpcResponse<T = unknown> {
  result?: T;
  error?: { message?: string };
}

export async function redeployCmd(opts: RedeployOptions): Promise<void> {
  const root = packageRoot();
  const deployDir = path.join(root, 'blockchain', 'deploy');
  const stateOut = path.join(root, 'blockchain', 'state.anvil.json');
  const foundryImage = opts.foundryImage ?? process.env.FOUNDRY_IMAGE ?? DEFAULT_FOUNDRY_IMAGE;

  await assertGitCheckout(root, deployDir);

  // Per-process names so parallel runs (or stale containers from a previous
  // crashed run) don't collide.
  const suffix = String(process.pid);
  const anvilName = `bee-compose-redeploy-anvil-${suffix}`;
  const networkName = `bee-compose-redeploy-net-${suffix}`;

  const cleanup = async () => {
    await run('docker', ['rm', '-f', anvilName], { quiet: true }).catch(() => {});
    await run('docker', ['network', 'rm', networkName], { quiet: true }).catch(() => {});
  };

  // Always clean up — even if interrupted by Ctrl-C.
  const onSignal = () => {
    cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    console.log('== ensuring submodules are initialized ==');
    await run('git', ['submodule', 'update', '--init', ...SUBMODULES], { cwd: root });

    console.log(`== pulling ${foundryImage} ==`);
    await run('docker', ['pull', foundryImage]);

    console.log('== creating scratch network ==');
    await run('docker', ['network', 'create', networkName], { quiet: true });

    console.log('== booting scratch anvil ==');
    await run('docker', [
      'run', '-d',
      '--name', anvilName,
      '--network', networkName,
      // Map a host port too so we can talk to anvil from Node for the state
      // dump. The forge container reaches anvil via the container name on the
      // user-defined network, which works on Linux/macOS/Windows alike (no
      // --network host shenanigans).
      '-p', `127.0.0.1:${ANVIL_HOST_PORT}:8545`,
      '--entrypoint', 'anvil',
      foundryImage,
      '--chain-id', '4020',
      '--host', '0.0.0.0',
      '--port', '8545',
    ], { quiet: true });

    await waitForAnvil();

    console.log('== running forge script (deploys + role wiring + funding) ==');
    await run('docker', [
      'run', '--rm',
      '--network', networkName,
      '-v', `${deployDir}:/work`,
      '-w', '/work',
      '-e', `PRIVATE_KEY=${DEPLOYER_KEY}`,
      '--entrypoint', 'forge',
      foundryImage,
      'script', 'script/Deploy.s.sol',
      '--rpc-url', `http://${anvilName}:8545`,
      '--broadcast',
      '--slow',
      '-vvv',
    ]);

    console.log('== dumping anvil state ==');
    // anvil_dumpState returns hex of gzipped JSON; the runtime image's
    // --state flag expects plain JSON, so we gunzip before writing.
    const dumpHex = await dumpAnvilState();
    const stripped = dumpHex.startsWith('0x') ? dumpHex.slice(2) : dumpHex;
    const compressed = Buffer.from(stripped, 'hex');
    const plain = await gunzip(compressed);

    fs.writeFileSync(stateOut, plain);
    console.log(`wrote ${stateOut} (${plain.length.toLocaleString()} bytes)`);

    // Rebuild the blockchain image so the new state.anvil.json is baked in.
    // Without this, the next `bee-compose start` reuses the old image and
    // none of the just-funded EOAs exist on chain.
    console.log('== rebuilding blockchain image with new state ==');
    await run('docker', ['compose', '-f', composeFile(), 'build', 'blockchain']);

    console.log();
    console.log("If contract addresses changed, update compose.yml's x-bee-env block");
    console.log('with the values printed by the forge script above, then run');
    console.log('`bee-compose stop --rm && bee-compose start ...` to pick up the new chain.');
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await cleanup();
  }
}

async function assertGitCheckout(root: string, deployDir: string): Promise<void> {
  // forge-std/src/Script.sol is the canonical "submodules are checked out"
  // signal — it's referenced by Deploy.s.sol's first import and only exists
  // when `git submodule update --init` has run. Plain npm installs from the
  // tarball don't include lib/ at all (excluded via `files`).
  const probe = path.join(deployDir, 'lib', 'forge-std', 'src', 'Script.sol');
  if (fs.existsSync(probe)) return;

  const gitDir = path.join(root, '.git');
  const fromTarball = !fs.existsSync(gitDir);

  const lines = [
    'redeploy requires a git checkout with submodules.',
    fromTarball
      ? 'This appears to be an npm-installed copy (no .git directory).'
      : 'Submodules under blockchain/deploy/lib/ are missing.',
    '',
    'To regenerate state.anvil.json, clone the repo and run from there:',
    '  git clone --recurse-submodules https://github.com/snaha/bee-compose.git',
    '  cd bee-compose',
    '  pnpm install && pnpm build',
    '  ./bin/bee-compose.js redeploy',
  ];
  throw new Error(lines.join('\n'));
}

async function waitForAnvil(): Promise<void> {
  const url = `http://127.0.0.1:${ANVIL_HOST_PORT}`;
  const deadline = Date.now() + ANVIL_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) {
        const data = (await res.json()) as JsonRpcResponse<string>;
        if (data.result) return;
      }
    } catch {
      // Connection refused while anvil starts up; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, ANVIL_BOOT_POLL_MS));
  }
  throw new Error("anvil didn't come up within 30s");
}

async function dumpAnvilState(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${ANVIL_HOST_PORT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_dumpState', params: [] }),
  });
  if (!res.ok) {
    throw new Error(`anvil_dumpState returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as JsonRpcResponse<string>;
  if (!data.result) {
    throw new Error(`anvil_dumpState returned no result: ${data.error?.message ?? 'unknown'}`);
  }
  return data.result;
}
