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
 * What lands on main is the SQUASH message, not the branch commits, and how it
 * is composed is a repository setting. So this reconstructs the message as this
 * repo is configured to compose it, and checks every branch commit besides — as
 * a hard failure when those bodies land, as a warning when they cannot.
 *
 *   node scripts/check-commit-messages.mjs --range <base>..<head>
 *
 * SQUASH_SUBJECT  the subject GitHub would use — checking a PR rather than a push
 * SQUASH_BODY     `blank` or `commits`, mirroring squash_merge_commit_message
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

/**
 * Where GitHub takes the squash body from — mirrors the repository's
 * `squash_merge_commit_message` setting, which this repo has on BLANK. On BLANK
 * the branch commits never reach main, so a line only they carry cannot break
 * the release: it is still reported, but it does not fail the build. Set
 * `SQUASH_BODY=commits` if that setting ever goes back to COMMIT_MESSAGES.
 */
const squashBodyFromCommits = (process.env.SQUASH_BODY ?? 'commits').toLowerCase() !== 'blank';
const subject = process.env.SQUASH_SUBJECT?.trim();
// Without a PR there is nothing to squash: the range IS what landed on main.
const commitsLand = !subject || squashBodyFromCommits;

console.log(
  `Checking ${commits.length} commit message(s) in ${range}` +
    `${commitsLand ? '' : ' (advisory — the squash body is BLANK, so these do not land)'}:`,
);
let commitsOk = true;
for (const { sha, message } of commits) {
  commitsOk = check(`${sha.slice(0, 8)}  ${message.split('\n')[0]}`, message) && commitsOk;
}

// The squash message is what release-please actually reads, so reconstruct it
// the way this repository is configured to compose it rather than trusting the
// individual commits to stand in for it.
let squashOk = true;
if (subject) {
  const squash = squashBodyFromCommits
    ? [subject, '', commits.map(({ message }) => message).join('\n\n')].join('\n')
    : subject;
  console.log(
    `\nChecking the squash message this would compose` +
      `${squashBodyFromCommits ? ' (title + commit bodies)' : ' (title only)'}:`,
  );
  squashOk = check(subject, squash);
}

const ok = squashOk && (!commitsLand || commitsOk);
if (ok && !commitsOk) {
  console.log(
    '\nNote: a branch commit above does not parse. It cannot break the release\n' +
      'while the squash body is BLANK, but it will the moment that changes.',
  );
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
