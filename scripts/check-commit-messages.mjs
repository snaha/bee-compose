#!/usr/bin/env node
/**
 * Fail if a commit message release-please will read cannot be parsed.
 *
 * release-please drops an unparseable commit and carries on, so the release
 * job goes green while the release itself silently does not happen. That is
 * how #19's `feat:` was lost: a body line beginning
 * `keccak(rlp([deployer, nonce])): ` reads as a conventional-commits footer
 * token with a scope, the nested `(` fails the grammar, and the whole commit
 * was skipped — 0.1.5 stayed latest with nothing anywhere reporting a fault.
 *
 * What lands on main is the SQUASH message, not the branch commits, so this
 * checks both: each commit in the range, to point at the one at fault, and the
 * message GitHub would compose from them (subject from the PR title, body from
 * the commits concatenated), which is what release-please actually reads.
 *
 *   node scripts/check-commit-messages.mjs --range <base>..<head>
 *
 * With SQUASH_SUBJECT set, the reconstructed squash message is checked too.
 */
import { execFileSync } from 'node:child_process';
import { parser } from '@conventional-commits/parser';

const RANGE_FLAG = '--range';
/** ASCII record separator — git emits it via %x1e, and a message cannot hold one. */
const RECORD_SEPARATOR = '\x1e';
const MAX_LOG_BYTES = 64 * 1024 * 1024;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_LOG_BYTES });
}

/** Every commit in the range, oldest first, as `{ sha, message }`. */
function commitsIn(range) {
  return git(['log', '--reverse', '--format=%H%n%B%x1e', range])
    .split(RECORD_SEPARATOR)
    .filter((entry) => entry.trim() !== '')
    .map((entry) => {
      const record = entry.replace(/^\n+/, '');
      const newline = record.indexOf('\n');
      return { sha: record.slice(0, newline), message: record.slice(newline + 1).trim() };
    });
}

/**
 * Report a parse failure where it is, not just that it happened: the grammar's
 * `line:column` is the only thing that makes these findable in a long body.
 */
function check(label, message) {
  try {
    parser(message);
    console.log(`  ok    ${label}`);
    return true;
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).split('\n')[0];
    console.log(`  FAIL  ${label}`);
    console.log(`        ${detail}`);
    const at = /at (\d+):(\d+)/.exec(detail);
    if (at) {
      const prefix = `line ${at[1]}: `;
      console.log(`        ${prefix}${message.split('\n')[Number(at[1]) - 1]}`);
      console.log(`        ${' '.repeat(prefix.length + Number(at[2]) - 1)}^`);
    }
    return false;
  }
}

const rangeIndex = process.argv.indexOf(RANGE_FLAG);
if (rangeIndex === -1 || !process.argv[rangeIndex + 1]) {
  console.error(`usage: check-commit-messages.mjs ${RANGE_FLAG} <base>..<head>`);
  process.exit(2);
}
const range = process.argv[rangeIndex + 1];

const commits = commitsIn(range);
if (commits.length === 0) {
  console.log(`No commits in ${range}; nothing to check.`);
  process.exit(0);
}

console.log(`Checking ${commits.length} commit message(s) in ${range}:`);
let ok = true;
for (const { sha, message } of commits) {
  ok = check(`${sha.slice(0, 8)}  ${message.split('\n')[0]}`, message) && ok;
}

// The squash message is what release-please actually reads. GitHub composes it
// from the PR title and the branch's commit messages, so reconstruct that
// rather than trusting the individual commits to stand in for it.
const subject = process.env.SQUASH_SUBJECT?.trim();
if (subject) {
  const squash = [subject, '', commits.map(({ message }) => message).join('\n\n')].join('\n');
  console.log('\nChecking the squash message this would compose:');
  ok = check(subject, squash) && ok;
}

if (!ok) {
  console.log(
    [
      '',
      'A commit message release-please cannot parse is skipped SILENTLY — the',
      'release job stays green and no release PR appears. Rewrite the offending',
      'line before merging.',
      '',
      'The usual cause is a body line that starts like a conventional-commits',
      'footer, `word: ` or `word(scope): `. A line such as',
      '',
      '    keccak(rlp([deployer, nonce])): anvil impersonates the deployer',
      '',
      'is read as the footer token `keccak` with a scope, and the nested `(`',
      'fails the grammar. Indent the line, reword it, or move the colon.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log('\nAll messages parse; release-please will see them.');
