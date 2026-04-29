import * as path from 'node:path';

// dist/lib/paths.js → ../../  is the package root (where compose.yml lives).
// Works the same whether the package is installed under node_modules/ or run
// from a git checkout.
export function packageRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export function composeFile(): string {
  return path.join(packageRoot(), 'compose.yml');
}
