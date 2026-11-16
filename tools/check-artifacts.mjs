// Artifact check for releases and publishes.
//
// Run directly (it is the `prepublishOnly` in package.json) or import
// `checkArtifacts()` from tools/release.mjs. The npm tarball ships the
// built wasm and the metadata.js it imports, both of which are build
// outputs (gitignored), so fail fast with a clear message rather than
// publishing a package that throws on import — or silently ships a wasm
// that is older than the sources.
//
// "Current" means the same thing `make` means: no target is older than
// any of its dependencies. The dependency graph below mirrors the
// Makefile, so keep it in sync when the build changes.
//
// Rebuild with `make` (needs the H3 v4.5.0 checkout at ./h3/ and Zig
// 0.16.0); tools/release.mjs does this automatically when stale.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// target -> dependencies, mirroring the Makefile (keep in sync).
// h3.wasm and build/metadata.js are what the npm tarball ships;
// build/support.a is an intermediate that must also be current.
const DEP_GRAPH = {
    'h3.wasm': [
        'build/support.a',
        'h3.zig',
        'mathcompat.c',
        'cvar.c',
        'Makefile',
        ...listDir('cshim'),
        ...listDir('h3/src/h3lib/lib', '.c'),
    ],
    'build/metadata.js': ['h3.wasm', 'tools/gen-metadata.mjs'],
    'build/support.a': ['support.zig', 'Makefile'],
};

// Regular files directly in dir (empty list if the dir doesn't exist,
// e.g. a fresh clone without the gitignored ./h3/ checkout).
function listDir(dir, suffix) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return [];
    return readdirSync(abs)
        .filter((f) => !suffix || f.endsWith(suffix))
        .map((f) => `${dir}/${f}`);
}

// Returns { missing: [path, ...], stale: ['target (older than dep)', ...] }
export function checkArtifacts() {
    const missing = [];
    const stale = [];
    for (const [target, deps] of Object.entries(DEP_GRAPH)) {
        const targetAbs = join(ROOT, target);
        if (!existsSync(targetAbs)) {
            missing.push(target);
            continue;
        }
        const targetTime = statSync(targetAbs).mtimeMs;
        for (const dep of deps) {
            const depAbs = join(ROOT, dep);
            if (!existsSync(depAbs)) continue;
            if (statSync(depAbs).mtimeMs > targetTime) {
                stale.push(`${target} (older than ${dep})`);
                break;
            }
        }
    }
    return { missing, stale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { missing, stale } = checkArtifacts();
    if (missing.length > 0 || stale.length > 0) {
        console.error('Artifacts are not ready for publishing:');
        for (const p of missing) console.error(`  missing: ${p}`);
        for (const s of stale) console.error(`  stale: ${s}`);
        console.error('');
        console.error('Rebuild with `make` (needs ./h3/ and Zig 0.16.0), or run');
        console.error('`node tools/release.mjs <version>`, which rebuilds when stale.');
        process.exit(1);
    }
    console.log('artifacts present and current: h3.wasm, build/metadata.js');
}
