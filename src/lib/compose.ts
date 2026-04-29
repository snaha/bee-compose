import { composeFile } from './paths';
import { run, RunOptions } from './exec';

// All compose subcommands route through here so the absolute path to compose.yml
// (resolved from the package install dir) is always passed via -f. This is what
// lets `bee-compose start` work from any cwd, even when installed via pnpm.
export function compose(args: string[], opts: RunOptions = {}): Promise<void> {
  return run('docker', ['compose', '-f', composeFile(), ...args], opts);
}
