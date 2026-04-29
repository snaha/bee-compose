import { compose } from '../lib/compose';

export async function statusCmd(): Promise<void> {
  // --profile workers so worker services show up even when defined-but-not-running.
  await compose(['--profile', 'workers', 'ps']);
}
