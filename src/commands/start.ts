import { compose } from '../lib/compose';
import { resolveQueenBootnode } from '../lib/bootnode';

export interface StartOptions {
  workers: number;
  beeVersion?: string;
  foundryVersion?: string;
  detach: boolean;
  fresh: boolean;
  pull: boolean;
  withoutBees: boolean;
}

const MAX_WORKERS = 4;

export async function startCmd(opts: StartOptions): Promise<void> {
  if (!Number.isInteger(opts.workers) || opts.workers < 0 || opts.workers > MAX_WORKERS) {
    throw new Error(`--workers must be an integer between 0 and ${MAX_WORKERS}`);
  }

  // Build the env we pass to every compose invocation. compose.yml interpolates
  // BEE_VERSION / FOUNDRY_VERSION at build time and QUEEN_BOOTNODE at worker
  // start time. Anything we don't override stays inherited from process.env.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.beeVersion) env.BEE_VERSION = opts.beeVersion;
  if (opts.foundryVersion) env.FOUNDRY_VERSION = opts.foundryVersion;

  if (opts.fresh) {
    console.log('== fresh: tearing down existing volumes ==');
    // --profile workers ensures any running workers are also taken down.
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

  if (opts.workers > 0) {
    console.log(`== resolving queen bootnode for ${opts.workers} worker(s) ==`);
    env.QUEEN_BOOTNODE = await resolveQueenBootnode();
    console.log(`Using QUEEN_BOOTNODE=${env.QUEEN_BOOTNODE}`);

    const services = Array.from({ length: opts.workers }, (_, i) => `worker-${i + 1}`);
    console.log(`== starting ${services.join(', ')} ==`);
    await compose(['--profile', 'workers', 'up', '-d', ...services], { env });
  }

  if (!opts.detach) {
    // Note: with stdio inherited, Ctrl-C in `compose logs -f` only stops the
    // log stream — the cluster keeps running. Use `bee-compose stop` to halt it.
    console.log('== tailing logs (Ctrl-C to detach; cluster keeps running) ==');
    await compose(['logs', '-f', '--tail', '100'], { env });
  }
}
