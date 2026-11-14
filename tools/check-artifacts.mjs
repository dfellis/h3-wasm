// Publish guard (run as `prepublishOnly`): the npm tarball ships the built
// wasm and the metadata.js it imports, both of which are build outputs
// (gitignored). Fail fast with a clear message if they're missing rather than
// publishing a package that throws on import.
//
// Build them with `make` (needs the H3 v4.5.0 checkout at ./h3/ and Zig
// 0.16.0). In CI the release workflow runs `make` before `pnpm publish`.
import { existsSync } from 'node:fs';

const REQUIRED = ['h3.wasm', 'build/metadata.js'];
const missing = REQUIRED.filter((p) => !existsSync(p));

if (missing.length > 0) {
    console.error(
        `Refusing to publish: missing build artifact(s) ${missing.join(', ')}`
    );
    console.error('Run `make` first (requires ./h3/ and Zig 0.16.0).');
    process.exit(1);
}
console.log(`artifacts present: ${REQUIRED.join(', ')}`);
