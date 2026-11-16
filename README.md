# H3-Wasm

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

WASM-compiled [H3](https://github.com/uber/h3) v4.5.0 for Node and the
browser, built with Zig. A drop-in replacement for [`h3-js`](https://github.com/uber/h3-js):
same API, same semantics — `h3-js` is the reference for any behavior that
differs between H3 bindings.

## Requirements

- Node.js 18+ (developed and tested on Node 24)
- [Zig](https://ziglang.org) 0.16.0
- [pnpm](https://pnpm.io) (package manager; yarn/npm are not supported)
- The H3 v4.5.0 C library checked out at `./h3/` (gitignored — see below)

## Setup

```sh
git clone https://github.com/uber/h3.git
cd h3 && git checkout v4.5.0 && cd ..
pnpm install
```

`pnpm install` brings in the dev dependencies used by the test suite:
`h3-js@^4.5.0` and `h3-node@^4.5.6` (prebuilt N-API binaries).

## Build

```sh
make            # or: pnpm build
```

Produces:

- `h3.wasm` — the H3 C library plus Zig binding exports, linked as a wasm
  shared object (`wasm32-freestanding`, `-mcpu baseline`, `-OReleaseSmall`).
- `build/support.a` — a small Zig support module (allocators, string/memory
  helpers) compiled as a separate module and statically linked in.
- `build/metadata.js` — memory/table/data-segment facts generated from the
  linked wasm; imported by `index.js` at startup.

The build is intentionally a plain `zig build-lib` invocation (see the
Makefile comments for why `zig build` is not used). No libc, no build.zig:
varargs support is `cvar.c`, the trivial libm functions are `mathcompat.c`,
and the transcendentals (`sin`/`cos`/`atan2`/…) are imported from the host
`Math.*` builtins at runtime — all behind hand-written C shim headers in
`cshim/`.

## Test

```sh
make test       # or: pnpm test
```

Runs `test/index.test.js`, a `node:test` suite that compares h3-wasm
against **both** `h3-js` and `h3-node` on every function:

- Deterministic inputs (seeded mulberry32 PRNG), 25 iterations per function.
- `strict` (deep equality) for integer/index outputs; `almost` (scaled
  1e-7 tolerance, the h3-node suite's `INFINITESIMAL`) for floating-point
  geometry, since h3-node's platform C libm can differ from the host
  `Math.*` builtins by ~1e-13 deg (h3-wasm and h3-js both use `Math.*`
  and agree bit-for-bit); `set` for order-insensitive cell lists
  (`polygonToCells*`); `mp` for `cellsToMultiPolygon` (polygon order
  depends on the C side's per-heap hash seed).
- Whenever wasm and h3-js throw, their `H3Error` codes must match (same C
  library ⇒ same code) and h3-node must throw too.
- Dedicated divergence tests pin the documented h3-js vs h3-node
  differences (below).
- A 3-way benchmark writes `build/benchmark.txt` (per-function ns/call for
  h3-wasm / h3-js / h3-node).

## CI

`.github/workflows/test.yml` mimics h3-node's test workflow:

- A `build` job fetches the H3 v4.5.0 tag, generates `h3api.h` (what
  CMake's `configure_file` does in a regular H3 build), builds `h3.wasm`
  once with Zig 0.16.0, and uploads it — the artifact is host-independent,
  so it is not rebuilt per OS (unlike h3-node's native prebuilds).
- The `test` matrix runs the suite on ubuntu/windows/macos × node
  22/24/26, loading h3-node's platform prebuilds as the reference.
- `test-musl` runs the same suite in a `node:24-alpine` container to
  cover the musl prebuild, mirroring h3-node's musl job.

## Releasing

Unlike h3-node's native prebuilds, `h3.wasm` is host-independent, so a
release is cut entirely from a local checkout — no CI publishing, no tokens:

1. Run the release script with the next version. It verifies the built
   `h3.wasm` / `build/metadata.js` are current (rebuilding with `make` if
   not — that step needs the `./h3/` checkout and Zig 0.16.0), runs the
   test suite, bumps `version` in `package.json`, commits, and tags that
   commit `v<version>`:

   ```sh
   node tools/release.mjs 0.1.0
   ```

2. Publish by hand — `npm publish` requires 2FA, so it is the one step that
   must be done interactively:

   ```sh
   npm publish
   ```

   (For a prerelease version npm requires a dist-tag, e.g.
   `npm publish --tag alpha` for `0.1.0-alpha` — the script prints the
   command to use.)

   The `files` whitelist ships exactly `index.js`, `h3.wasm`, and
   `build/metadata.js` (plus the auto-included `README`/`LICENSE`).
   `prepublishOnly` (`tools/check-artifacts.mjs`) re-checks that the
   artifacts exist and are current, so a publish that skips the script
   still cannot ship a missing or stale wasm.

3. Push the release commit and tag once the publish succeeded:

   ```sh
   git push origin main
   git push origin v0.1.0
   ```

Optionally, attach the raw `h3.wasm` + `build/metadata.js` to a GitHub
release (for hand-instantiating the wasm without the package):

```sh
gh release create v0.1.0 h3.wasm build/metadata.js
```

## Usage

```js
import { latLngToCell, cellToLatLng, gridDisk } from 'h3-wasm';

const cell = latLngToCell(37.77, -122.43, 9);
cellToLatLng(cell);
gridDisk(cell, 2);
```

H3 indexes may be passed as hex strings or as "split long" two-element
integer arrays `[lower32, upper32]` — exactly like h3-js.

## Architecture

- **WASM ABI** — i32/f64 only. 64-bit `H3Index` values cross the boundary
  as a `(lower, upper)` i32 pair (h3-js's "split long"). Scalar and array
  outputs are written into JS-owned wasm memory at caller-provided offsets
  (two-phase size→fill for variable-length results).
- **Memory layout** — the host supplies a 256-page (16 MiB) initial memory.
  The wasm data segment occupies the low addresses; a JS-owned bump region
  follows it; the C/Zig stack descends from the top of initial memory while
  the Zig heap grows up from that boundary via `memory.grow()`.
  `memory.grow()` detaches the `ArrayBuffer`, so `index.js` re-wraps its
  typed-array views on every boundary crossing. The bump region is recycled
  at the start of every public API call (all scratch is dead at call
  boundaries), so the 16 MiB region never exhausts. The first 256 bytes of
  the bump region are fixed slots for the string parser (input buffer +
  parsed output), so the bump allocator starts behind them.
- **Host libm** — wasm32-freestanding has no math library, so the C
  transcendentals (`sin`/`cos`/`atan2`/…) are imported from the host `env`
  namespace, where `index.js` provides the `Math.*` builtins — the same
  strategy emscripten's JS shim uses for h3-js, which makes trig results
  match bit-for-bit. A software Taylor-series libm in wasm measured 2–9×
  slower than the builtins (worst: `asin`/`acos`, 66 ns vs 7 ns). The few
  trivial functions with no exact `Math.*` counterpart (`round`/`lround` —
  C rounds half away from zero; `fmin`/`fmax` — C NaN propagation) live in
  `mathcompat.c`.
- **String parsing in Zig** — H3 hex strings are parsed to their 64-bit
  index by `bind__h3IndexFromString` in `h3.zig` (a few ns in wasm) rather
  than the JS regex/`substring`/`parseInt` path (~50 ns). It mirrors
  h3-js's `h3IndexToSplitLong` semantics exactly, including edge cases
  (non-hex input ⇒ cell 0; 8-char-or-shorter strings keep their `NaN` upper
  half in JS; 248+ char strings fall back to the legacy JS parse).
- **Stringification in Zig** — array outputs of three or more cells
  (`cellToChildren`, `gridDisk`, `getRes0Cells`, …) are stringified in
  `bind__h3IndexArrayToStrings` in `h3.zig`: each 64-bit index becomes one
  17-byte slot — a length byte plus up to 16 lowercase hex chars (upper 32
  bits unpadded, lower 32 bits zero-padded to 8; 16 is a hard maximum, so
  no fallback path is needed). JS then reads the whole block with one
  `TextDecoder.decode` and one `slice` per cell, replacing ~150 ns of JS
  `toString(16)`/`padStart` work per cell with a few ns (`getRes0Cells`:
  18.6 µs → ~3.1 µs). Outputs below three cells and polygons too large for
  the bump region keep the legacy JS path.
- **Binding surface** — `h3.zig` declares the H3 C API and re-exports it as
  `bind__*` wasm exports (the prefix avoids symbol collisions with the C
  library at link time).

## API parity

All 58 public functions of h3-js 4.5.0 are implemented, plus the `E_*`
error-code constants and `H3LibraryError`/`JSBindingError` factories.
Behavior follows h3-js, including its quirks (e.g. malformed index
strings parse to cell 0 and let the C library decide;
`h3IndexToSplitLong` performs no 32-bit range checks). One deliberate
exception: `cellToChildren` on an invalid cell throws `E_CELL_INVALID`
(like h3-node) rather than returning `[]` (like h3-js) — see
[Documented divergences](#documented-divergences).

## Documented divergences

h3-wasm matches **h3-js**. Where `h3-node` 4.5.6 (the N-API build of the
same H3 4.5.0 C library) differs, the differences are pinned by the
divergence tests in `test/index.test.js`. (h3-node 4.5.4 aligned its error
contract with h3-js — numeric error codes, exact unit matching, dense
`getIcosahedronFaces` — which removed several 4.5.3-era divergences.)

| Area | h3-wasm / h3-js | h3-node 4.5.6 |
| --- | --- | --- |
| `cellToChildren` on an invalid cell (`cellToChildren('zzz', 10)`) | **wasm throws `E_CELL_INVALID` (5); h3-js returns `[]`** — the one place wasm follows h3-node | throws `E_FAILED` (1) from a binding pre-check |
| Malformed index strings (`getResolution('zzz')`, `cellToLatLng(null)`, …) | parse to cell 0; C library decides (sentinels like `-1`, or a real result) | throws numeric codes (caller error: `E_FAILED` 1 / `E_DOMAIN` 2) |
| TypedArray index input | only plain two-element integer arrays are split longs; anything else parses to cell 0 | accepts a two-element `Uint32Array` as a split long |
| Non-string units (`greatCircleDistance(o, d, 5)`) | throws `E_UNKNOWN_UNIT` (1000) — C's unit compare fails | throws `E_DOMAIN` (2) — N-API string extraction fails first |
| Error code encoding | numeric `H3Error` codes (3, 4, 5, 11, …) and JS codes (1000, 1001, 1002) | same numeric codes — except where the binding pre-validates before the C call: `cellToChildren*` on an invalid cell ⇒ `E_FAILED` (1); `constructCell` digit/res checks ⇒ `E_DOMAIN` (2) / `E_RES_DOMAIN` (4) |
| `localIjToCell(origin, 'nope')` | plain `Error('Coordinates must be provided as an {i, j} object')` | `E_DOMAIN` (2) |
| `degsToRads` / `radsToDegs` | pure JS: `(deg * Math.PI) / 180` | H3's C implementation `deg * (M_PI / 180.0)` — may differ by 1 ulp |
| Floating-point geometry | host `Math.*` builtins (imported via the wasm `env` namespace — same as h3-js's emscripten shim) | platform C libm — agreement within ~1e-13 deg |

## Performance

`build/benchmark.txt` — regenerated by the test suite (`pnpm test`) —
benchmarks 52 public functions 3-way against `h3-js` 4.5.0 and
`h3-node` 4.5.6. Per-call times below (light functions: 50,000 iters, heavy:
500, 5,000-iter warmup per case, 500 arg sets cycled — steady-state
Turbofan) are from **Node 24 on x86-64 Linux**; the relative pattern holds
on other platforms. Fastest per row is bolded. Expect a few percent
run-to-run variance (occasionally ~30% on a single row).

- **h3-node** (a compiled N-API binding) is fastest on 30 of 52 functions
  and is the performance bar. Since 4.5.6 it stringifies index arrays in C
  (17-byte hex slots in an `ArrayBuffer`), which widened its lead on the
  string-output rows (`gridDisk`, `cellToChildren`, `getRes0Cells`, …).
- **h3-wasm** is fastest outright on 16 of 52 (tied twice, within
  run-to-run noise: `degsToRads` with h3-js, `cellToVertexes` with
  h3-node; e.g. `cellToBoundary`, `uncompactCells`, `cellsToMultiPolygon`,
  `originToDirectedEdges`, `splitLongToH3Index`), beats h3-js on 35 of 52,
  and sits ≈1.24× (median) off the row winner. On the heavy geometry /
  grid / compact / multi-polygon functions it is ~1.4–6.2× faster than
  h3-js; on trivial string-input accessors (`getResolution`, `isValidCell`,
  `getBaseCellNumber`, …) h3-js is faster.
- **h3-js** (the same C compiled to asm.js via emscripten) wins a handful of
  trivial accessors where there is little to compute (e.g.
  `getBaseCellNumber`, `isResClassIII`, `h3IndexToSplitLong`). Its trig-heavy
  rows are within ~1.3× of h3-wasm's: both route the C transcendentals to the
  host `Math.*` builtins (h3-wasm via a wasm import, h3-js via emscripten's
  JS shim — see [Architecture](#architecture)).

The cost of h3-wasm's per-call overhead (wasm invocation + argument
marshalling) is the payoff: one host-independent `h3.wasm` runs in Node,
browsers, Deno, and Bun with no native build or per-platform prebuilds.

| latLngToCell | 678.2 ns | 826.7 ns | **320.8 ns** |
| cellToLatLng | **334.7 ns** | 351.2 ns | 405.9 ns |
| cellToBoundary | **774.5 ns** | 938.7 ns | 1761 ns |
| cellToBoundaryGeoJson | **726.4 ns** | 986.8 ns | 1899 ns |
| getResolution | 156.8 ns | 114.5 ns | **90.1 ns** |
| getBaseCellNumber | 135.8 ns | 88.5 ns | **88.1 ns** |
| isValidCell | 109 ns | 79.5 ns | **54.3 ns** |
| isResClassIII | 140.7 ns | 91.6 ns | **81.2 ns** |
| isPentagon | 136.4 ns | 94.3 ns | **88.6 ns** |
| getIcosahedronFaces | **286.5 ns** | 329.2 ns | 316 ns |
| gridDisk | 9847 ns | 61.0 µs | **8466 ns** |
| gridDiskDistances | 6853 ns | 11.4 µs | **2808 ns** |
| gridRingUnsafe | **840.5 ns** | 2195 ns | 917.1 ns |
| gridDistance | 370.9 ns | 385.9 ns | **232.6 ns** |
| cellToLocalIj | **351.3 ns** | 419.7 ns | 491 ns |
| localIjToCell | 533.1 ns | 649 ns | **371.9 ns** |
| gridPathCells | 2167 ns | 1858 ns | **1275 ns** |
| cellToParent | 298.3 ns | 225.7 ns | **139.7 ns** |
| cellToChildren | 3557 ns | 12.2 µs | **2550 ns** |
| cellToChildrenSize | 176.6 ns | 221.9 ns | **95.3 ns** |
| cellToCenterChild | 269.2 ns | 189.8 ns | **140.8 ns** |
| compactCells | 16.5 µs | 61.9 µs | **15.1 µs** |
| uncompactCells | **6925 ns** | 18.9 µs | 7507 ns |
| polygonToCells | 24.2 µs | 52.7 µs | **21.5 µs** |
| polygonToCellsWithHoles | 32.6 µs | 62.0 µs | **29.5 µs** |
| polygonToCellsExperimental | 130.99 µs | 180.93 µs | **120.56 µs** |
| cellsToMultiPolygon | **32.4 µs** | 142.55 µs | 34.6 µs |
| cellsToMultiPolygonGeoJson | **31.9 µs** | 143.07 µs | 34.9 µs |
| areNeighborCells | 330.4 ns | 376.4 ns | **183.8 ns** |
| cellsToDirectedEdge | 428 ns | 460.7 ns | **240.5 ns** |
| getDirectedEdgeOrigin | 275.4 ns | 181.7 ns | **133 ns** |
| getDirectedEdgeDestination | 285.3 ns | 228.7 ns | **157.2 ns** |
| directedEdgeToCells | 400 ns | **322.7 ns** | 349.3 ns |
| originToDirectedEdges | **404.7 ns** | 630.4 ns | 458.6 ns |
| directedEdgeToBoundary | **508.8 ns** | 688.9 ns | 847.4 ns |
| reverseDirectedEdge | 318.2 ns | 336.4 ns | **186 ns** |
| degsToRads | **9.4 ns** | **9.4 ns** | 26 ns |
| radsToDegs | **10.7 ns** | 11.5 ns | 28.4 ns |
| getNumCells | 59.9 ns | 43.7 ns | **29.4 ns** |
| getHexagonEdgeLengthAvg | 62.1 ns | **32.6 ns** | 43.2 ns |
| edgeLength | 506.9 ns | 662.8 ns | **447.4 ns** |
| getHexagonAreaAvg | 61.9 ns | **32.1 ns** | 43.5 ns |
| cellArea | 875.5 ns | 1128 ns | **797.7 ns** |
| greatCircleDistance | **73.9 ns** | 198.1 ns | 210.4 ns |
| getRes0Cells | 3115 ns | 10.3 µs | **2034 ns** |
| getPentagons | **561.4 ns** | 1086 ns | 598 ns |
| cellToVertex | 423.5 ns | 527.5 ns | **284.5 ns** |
| cellToVertexes | **1538 ns** | 2541 ns | **1541 ns** |
| vertexToLatLng | **331.4 ns** | 403 ns | 429 ns |
| h3IndexToSplitLong | 115.5 ns | 83.8 ns | **77.8 ns** |
| splitLongToH3Index | **107.5 ns** | 253.6 ns | 252.1 ns |
| constructCell | 184.8 ns | **159.1 ns** | 347.2 ns |

## Repository layout

```
index.js        ESM layer: instantiation, memory management, public API
h3.zig          Zig binding root: C API declarations + bind__* exports
support.zig     Zig support module (malloc/calloc/realloc/free, qsort, …)
mathcompat.c    trivial libm (round/lround/fmin/fmax); transcendentals import host Math.*
cvar.c          C varargs support
cshim/          hand-written C headers (math.h, …) for the freestanding build
Makefile        2-stage build (support.a → h3.wasm) + metadata generation
tools/          build helpers (metadata generator) + publish guard + release script
test/           node:test suite (3-way comparison vs h3-js and h3-node)
h3/             H3 v4.5.0 C library (gitignored; clone it yourself)
h3-js/ h3-node/ reference checkouts (gitignored; not required to build)
```
