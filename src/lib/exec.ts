import { spawn } from 'node:child_process';

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  // Suppress stdout/stderr forwarding. Stderr is still captured and surfaced
  // on non-zero exit so the user sees why a "quiet" command failed.
  quiet?: boolean;
}

// Spawn a command with stdio inherited (so TTY-aware tools like `docker compose
// logs -f` work) and resolve when it exits cleanly. Rejects on non-zero exit.
// We never go through a shell, so paths with spaces/backslashes (Windows!) are
// passed verbatim and don't need quoting.
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderrBuf = '';
    const child = spawn(cmd, args, {
      stdio: opts.quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    });
    if (opts.quiet && child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
    }
    child.on('error', (err) => {
      // ENOENT here usually means the binary isn't on PATH (docker, git, etc).
      // Surface a friendlier message so the user knows what to install.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`'${cmd}' not found on PATH — is it installed?`));
      } else {
        reject(err);
      }
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const detail = signal ? `signal ${signal}` : `exit code ${code}`;
        const tail = stderrBuf.trim() ? `\n${stderrBuf.trim()}` : '';
        reject(new Error(`${cmd} ${args.join(' ')} failed (${detail})${tail}`));
      }
    });
  });
}
