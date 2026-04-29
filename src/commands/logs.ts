import { compose } from '../lib/compose';

export interface LogsOptions {
  follow: boolean;
  tail: string;
}

const VALID_SERVICES = new Set([
  'queen',
  'blockchain',
  'worker-1', 'worker-2', 'worker-3', 'worker-4',
  'worker-5', 'worker-6', 'worker-7', 'worker-8',
]);

export async function logsCmd(service: string, opts: LogsOptions): Promise<void> {
  if (!VALID_SERVICES.has(service)) {
    throw new Error(
      `unknown service '${service}'. Valid: ${[...VALID_SERVICES].join(', ')}`,
    );
  }
  const args = ['logs', '--tail', opts.tail];
  if (opts.follow) args.push('-f');
  args.push(service);
  await compose(args);
}
