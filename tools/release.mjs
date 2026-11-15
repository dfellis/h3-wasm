// Local release script. h3.wasm is host-independent (wasm32-freestanding,
// -mcpu baseline), so cutting a release involves no CI and no tokens —
// everything happens in this checkout:
//
//   node tools/release.mjs <version> [--no-build]
//
// The script:
//   1. verifies the built artifacts (h3.wasm, build/metadata.js) are
//      current, rebuilding with `make` if not (with --no-build, stale
//      artifacts abort the release instead of being rebuilt)
//   2. runs the unit test suite
//   3. bumps `version` in package.json, commits, and tags that commit
//      v<version> (annotated)
//   4. prints the remaining manual steps: `npm publish` (2FA, so it has
//      to be done by hand) and pushing the commit + tag
//
// `prepublishOnly` (tools/check-artifacts.mjs) re-verifies the artifacts
// when `npm publish` runs, so a publish that skips this script still
// cannot ship a missing or stale wasm.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkArtifacts } from './check-artifacts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const fail = (msg) => {
    console.error(`release: ${msg}`);
    process.exit(1);
};

const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const gitOrDie = (args, what) => {
    const r = git(...args);
    if (r.error) fail(`${what} failed: ${r.error.message}`);
    if (r.status !== 0) fail(`${what} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
};

// --- arguments ----------------------------------------------------------
const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const version = argv.find((a) => !a.startsWith('--'));
if (!version) fail('usage: node tools/release.mjs <version> [--no-build]');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`'${version}' is not a valid semver version (e.g. 0.1.0 or 0.1.0-alpha.1)`);
}
const tag = `v${version}`;

// --- preconditions --------------------------------------------------------
if (git('version').error || git('version').status !== 0) fail('git is not available');
if (git('rev-parse', '--is-inside-work-tree').status !== 0) fail('not a git working tree');
if (git('rev-parse', '-q', '--verify', `refs/tags/${tag}`).status === 0) {
    fail(`tag ${tag} already exists`);
}
const dirty = git('status', '--porcelain').stdout.trim();
if (dirty) fail(`working tree is not clean (commit or stash first):\n${dirty}`);
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
if (branch === 'HEAD') fail('detached HEAD; check out a branch first');

// --- 1. artifacts ---------------------------------------------------------
const describe = ({ missing, stale }) =>
    [...missing.map((p) => `missing ${p}`), ...stale].join('\n  ');

let artifactState;
{
    const before = checkArtifacts();
    if (before.missing.length === 0 && before.stale.length === 0) {
        artifactState = 'current';
    } else {
        if (noBuild) fail(`artifacts are not up to date; rerun without --no-build:\n  ${describe(before)}`);
        if (!existsSync(join(ROOT, 'h3/src/h3lib/lib'))) {
            fail('artifacts are not up to date and the H3 v4.5.0 checkout (./h3/) is missing.\n' +
                 'Fetch it the same way .github/workflows/test.yml does, then rerun.');
        }
        console.log(`rebuilding artifacts (${describe(before)}):`);
        const make = spawnSync('make', { cwd: ROOT, stdio: 'inherit' });
        if (make.status !== 0) fail(`make exited with ${make.status}`);
        const after = checkArtifacts();
        if (after.missing.length > 0 || after.stale.length > 0) {
            fail(`artifacts are still not up to date after make:\n  ${describe(after)}`);
        }
        artifactState = 'rebuilt';
    }
}

// --- 2. tests --------------------------------------------------------------
console.log('running tests:');
const testFiles = readdirSync(join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => join('test', f));
const tests = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: ROOT, stdio: 'inherit' });
if (tests.status !== 0) fail(`tests failed (exit ${tests.status}); not releasing`);

// --- 3. version bump + commit + tag ----------------------------------------
const pkgPath = join(ROOT, 'package.json');
const raw = readFileSync(pkgPath, 'utf8');
const oldVersion = raw.match(/"version"\s*:\s*"([^"]+)"/);
if (!oldVersion) fail('could not find "version" in package.json');
if (oldVersion[1] === version) {
    fail(`package.json is already at ${version} (and tag ${tag} does not exist yet).\n` +
         `If a previous run stopped after the commit, tag it manually:\n` +
         `  git tag -a ${tag} -m "h3-wasm ${tag}"`);
}
writeFileSync(pkgPath, raw.replace(/("version"\s*:\s*")([^"]+)(")/, `$1${version}$3`));
gitOrDie(['add', 'package.json'], 'git add');
gitOrDie(['commit', '-m', `release: ${tag}`], 'git commit');
const sha = gitOrDie(['rev-parse', '--short', 'HEAD'], 'git rev-parse').trim();
gitOrDie(['tag', '-a', tag, '-m', `h3-wasm ${tag}`], 'git tag');

// --- 4. done ----------------------------------------------------------------
console.log(`
${tag} is ready locally:
  artifacts:  ${artifactState}
  tests:      passed
  version:    ${oldVersion[1]} -> ${version}
  commit:     ${sha} (${branch})
  tag:        ${tag}

Publish by hand (npm requires 2FA):
  npm publish

Then push:
  git push origin ${branch}
  git push origin ${tag}
`);
