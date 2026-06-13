import { Command } from 'commander';
import { startCmd } from './commands/start';
import { stopCmd } from './commands/stop';
import { logsCmd } from './commands/logs';
import { stampCmd } from './commands/stamp';
import { statusCmd } from './commands/status';
import { redeployCmd } from './commands/redeploy';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string };

function parseInt10(label: string): (value: string) => number {
  return (value: string) => {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) throw new Error(`${label} must be a number, got '${value}'`);
    return n;
  };
}

const program = new Command();

program
  .name('bee-compose')
  .description('Local Swarm Bee cluster (1 queen + up to 8 workers, any mix of full / light) on a pre-loaded Anvil dev chain.')
  .version(pkg.version);

program
  .command('start')
  .description(
    'Start the cluster. The queen is always running as a full node and counts toward --full. ' +
      'So --full 1 = queen only, --full 3 = queen + 2 full workers, etc.',
  )
  .option('-l, --light <n>', 'number of light worker nodes to start', parseInt10('--light'), 0)
  .option('-F, --full <n>', 'total full nodes including the queen (≥ 1)', parseInt10('--full'), 1)
  .option('--bee-version <ver>', 'override Bee image tag (default 2.8.0, see compose.yml)')
  .option('--foundry-version <ver>', 'override Foundry image tag (default stable)')
  .option('-d, --detach', 'return after starting (default)', true)
  .option('--no-detach', 'tail logs in foreground after starting')
  .option('-f, --fresh', 'tear down volumes before starting (destroys node state)', false)
  .option('--pull', 'pull/rebuild base images before starting', false)
  .option('--without-bees', 'start only the blockchain', false)
  .action(async (opts) => {
    await startCmd(opts);
  });

program
  .command('stop')
  .description('Stop the cluster')
  .option('--rm', 'remove containers and volumes (down -v) instead of stopping', false)
  .action(async (opts) => {
    await stopCmd(opts);
  });

program
  .command('logs <service>')
  .description('Tail logs for a service (queen | blockchain | worker-1..8)')
  .option('-f, --follow', 'follow log output', false)
  .option('-t, --tail <n>', 'show last N lines', '100')
  .action(async (service: string, opts) => {
    await logsCmd(service, opts);
  });

program
  .command('stamp')
  .description('Buy a postage stamp on a Bee node')
  .option('--amount <n>', 'stamp amount (must exceed price * 17280)', '500000000')
  .option('--depth <n>', 'stamp depth', '20')
  .option('--node <url>', 'Bee API endpoint', process.env.BEE_API ?? 'http://127.0.0.1:1633')
  .action(async (opts) => {
    await stampCmd(opts);
  });

program
  .command('status')
  .description('Show cluster status (docker compose ps)')
  .action(async () => {
    await statusCmd();
  });

program
  .command('redeploy')
  .description('Regenerate blockchain/state.anvil.json by deploying the Swarm contracts from source. Requires a git checkout with submodules.')
  .option('--foundry-image <image>', 'Foundry image to use', process.env.FOUNDRY_IMAGE)
  .action(async (opts) => {
    await redeployCmd(opts);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`bee-compose: ${err.message}`);
  process.exit(1);
});
