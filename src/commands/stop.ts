import { compose } from '../lib/compose';

export interface StopOptions {
  rm: boolean;
}

export async function stopCmd(opts: StopOptions): Promise<void> {
  // --profile workers must be passed for `down`/`stop` to actually touch worker
  // services — without it, profile-gated services are out of scope.
  if (opts.rm) {
    console.log('== removing containers and volumes ==');
    await compose(['--profile', 'workers', 'down', '-v', '--remove-orphans']);
  } else {
    console.log('== stopping containers (volumes preserved) ==');
    await compose(['--profile', 'workers', 'stop']);
  }
}
