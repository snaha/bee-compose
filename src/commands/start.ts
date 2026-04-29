import { compose } from '../lib/compose';
import { resolveQueenBootnode } from '../lib/bootnode';

export interface StartOptions {
  light: number;
  full: number;
  beeVersion?: string;
  foundryVersion?: string;
  detach: boolean;
  fresh: boolean;
  pull: boolean;
  withoutBees: boolean;
}

// `--full` counts ALL full nodes including the queen, which is always full and
// always running. So `--full 1` means "queen only, no full workers" and the
// number of full *workers* is `--full - 1`. The total node count caps at 9
// (queen + 8 workers).
const MAX_WORKERS = 8;
const MAX_FULL = MAX_WORKERS + 1; // queen + 8 workers

export async function startCmd(opts: StartOptions): Promise<void> {
  const { light, full } = opts;

  if (!Number.isInteger(full) || full < 1) {
    throw new Error('--full must be ≥ 1 (the queen is always a full node)');
  }
  if (!Number.isInteger(light) || light < 0) {
    throw new Error('--light must be a non-negative integer');
  }
  if (full > MAX_FULL) {
    throw new Error(`--full must be ≤ ${MAX_FULL} (queen + ${MAX_WORKERS} workers)`);
  }

  const fullWorkerCount = full - 1; // queen accounts for one full node
  const lightWorkerCount = light;

  if (fullWorkerCount + lightWorkerCount > MAX_WORKERS) {
    throw new Error(
      `(--full - 1) + --light must be ≤ ${MAX_WORKERS} workers, got ${fullWorkerCount} + ${lightWorkerCount} = ${fullWorkerCount + lightWorkerCount}`,
    );
  }

  // Allocation: workers 1..fullWorkerCount are full, the next lightWorkerCount
  // are light. Stable across re-runs unless --full changes.
  const fullWorkers = Array.from({ length: fullWorkerCount }, (_, i) => i + 1);
  const lightWorkers = Array.from({ length: lightWorkerCount }, (_, i) => fullWorkerCount + i + 1);
  const allWorkers = [...fullWorkers, ...lightWorkers];

  // Build the env we pass to every compose invocation. compose.yml interpolates
  // BEE_VERSION / FOUNDRY_VERSION at build time, BEE_WORKER_N_FULL per worker,
  // and QUEEN_BOOTNODE at worker start time.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.beeVersion) env.BEE_VERSION = opts.beeVersion;
  if (opts.foundryVersion) env.FOUNDRY_VERSION = opts.foundryVersion;
  for (const n of fullWorkers) env[`BEE_WORKER_${n}_FULL`] = 'true';
  for (const n of lightWorkers) env[`BEE_WORKER_${n}_FULL`] = 'false';

  if (opts.fresh) {
    console.log('== fresh: tearing down existing volumes ==');
    await compose(['--profile', 'workers', 'down', '-v', '--remove-orphans'], { env }).catch(
      () => {
        // down can legitimately fail if nothing's up yet — keep going.
      },
    );
  }

  if (opts.pull) {
    console.log('== pulling base images ==');
    await compose(['--profile', 'workers', 'pull'], { env });
  }

  if (opts.withoutBees) {
    console.log('== starting blockchain only ==');
    await compose(['up', '-d', 'blockchain'], { env });
    return;
  }

  console.log('== starting queen + blockchain ==');
  await compose(['up', '-d', 'queen', 'blockchain'], { env });

  if (allWorkers.length > 0) {
    const summary = [
      `queen (full)`,
      fullWorkerCount > 0
        ? `${fullWorkerCount} full worker(s) [worker-${fullWorkers.join(', worker-')}]`
        : null,
      lightWorkerCount > 0
        ? `${lightWorkerCount} light worker(s) [worker-${lightWorkers.join(', worker-')}]`
        : null,
    ].filter(Boolean).join(' + ');
    console.log(`== ${summary}; resolving queen bootnode ==`);
    env.QUEEN_BOOTNODE = await resolveQueenBootnode();
    console.log(`Using QUEEN_BOOTNODE=${env.QUEEN_BOOTNODE}`);

    const services = allWorkers.map((n) => `worker-${n}`);
    console.log(`== starting ${services.join(', ')} ==`);
    await compose(['--profile', 'workers', 'up', '-d', ...services], { env });
  }

  if (!opts.detach) {
    console.log('== tailing logs (Ctrl-C to detach; cluster keeps running) ==');
    await compose(['logs', '-f', '--tail', '100'], { env });
  }
}
