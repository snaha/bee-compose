#!/usr/bin/env node
// Tiny shim so the published `bin` is plain JS with a portable shebang.
// All real logic lives in dist/cli.js (compiled from src/cli.ts).
require('../dist/cli.js');
