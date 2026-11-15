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
`h3-js@^4.5.0` and `h3-node@^4.5.3` (prebuilt N-API binaries).

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

h3-wasm matches **h3-js**. Where `h3-node` 4.5.3 (the N-API build of the
same H3 4.5.0 C library) differs, the differences are pinned by the
divergence tests in `test/index.test.js`:

| Area | h3-wasm / h3-js | h3-node 4.5.3 |
| --- | --- | --- |
| `cellToChildren` on an invalid cell | **wasm throws `E_CELL_INVALID` (5); h3-js returns `[]`** — the one place wasm follows h3-node | throws (argument-level error) |
| Malformed index strings (`getResolution('zzz')`, `cellToLatLng(null)`, …) | parse to cell 0; C library decides (sentinels like `-1`, or a real result) | throws `EINVAL` (caller error) |
| TypedArray index input | only plain two-element integer arrays are split longs; anything else parses to cell 0 | accepts a two-element `Uint32Array` as a split long |
| Unknown units (`'miles'`, `'m2'` where invalid) | throws `E_UNKNOWN_UNIT` (code 1000) | prefix parsing: `unit[0] == 'm'` ⇒ meters (no throw) for `greatCircleDistance`/`getHexagonEdgeLengthAvg`; empty/non-string ⇒ `EINVAL` |
| Error code encoding | numeric `H3Error` codes (3, 4, 5, 11, …) and JS codes (1000, 1001, 1002) | numeric strings for generic C errors (`'1'`, `'5'`, …), `'EINVAL'` for special cases |
| `localIjToCell(origin, 'nope')` | plain `Error('Coordinates must be provided as an {i, j} object')` | `EINVAL` |
| `degsToRads` / `radsToDegs` | pure JS: `(deg * Math.PI) / 180` | H3's C implementation `deg * (M_PI / 180.0)` — may differ by 1 ulp |
| `getIcosahedronFaces` | dense array, e.g. `[7]` | result sized to `maxFaceCount` with holes for unused slots, e.g. `[7, <hole>]` (bug; fixed upstream after v4.5.3) |
| `cellToChildren('zzz', 10)` | `[]` | throws |
| Floating-point geometry | host `Math.*` builtins (imported via the wasm `env` namespace — same as h3-js's emscripten shim) | platform C libm — agreement within ~1e-13 deg |

## Performance

`build/benchmark.txt` — regenerated by the test suite (`pnpm test`) —
benchmarks 52 public functions 3-way against `h3-js` 4.5.0 and
`h3-node` 4.5.3. Per-call times below (light functions: 50,000 iters, heavy:
500, 5,000-iter warmup per case, 500 arg sets cycled — steady-state
Turbofan) are from **Node 24 on x86-64 Linux**; the relative pattern holds
on other platforms. Fastest per row is bolded. Expect a few percent
run-to-run variance (occasionally ~30% on a single row).

- **h3-node** (a compiled N-API binding) is fastest on 29 of 52 functions
  and is the performance bar.
- **h3-wasm** is fastest outright on 11 of 52 (e.g. `cellToBoundary`,
  `cellsToMultiPolygon`, `greatCircleDistance`, `splitLongToH3Index`),
  beats h3-js on 27 of 52, and sits ≈1.32× (median) off the row winner. On
  the heavy geometry / grid / compact / multi-polygon functions it is
  ~1.1–4.5× faster than h3-js; on trivial string-input accessors
  (`getResolution`, `isValidCell`, `getBaseCellNumber`, …) h3-js is faster.
- **h3-js** (the same C compiled to asm.js via emscripten) wins the trivial
  accessors where there is little to compute. Its trig-heavy rows are within
  ~1.25× of h3-wasm's: both route the C transcendentals to the host `Math.*`
  builtins (h3-wasm via a wasm import, h3-js via emscripten's JS shim — see
  [Architecture](#architecture)).

The cost of h3-wasm's per-call overhead (wasm invocation + argument
marshalling) is the payoff: one host-independent `h3.wasm` runs in Node,
browsers, Deno, and Bun with no native build or per-platform prebuilds.

| Function | h3-wasm | h3-js | h3-node |
| --- | ---: | ---: | ---: |
| latLngToCell | 636 ns | 803 ns | **280 ns** |
| cellToLatLng | 345 ns | **312 ns** | 414 ns |
| cellToBoundary | **761 ns** | 921 ns | 1796 ns |
| cellToBoundaryGeoJson | **752 ns** | 965 ns | 1970 ns |
| getResolution | 170 ns | 107 ns | **99.0 ns** |
| getBaseCellNumber | 146 ns | **87.4 ns** | 99.6 ns |
| isValidCell | 121 ns | 81.7 ns | **53.5 ns** |
| isResClassIII | 149 ns | **95.7 ns** | 96.3 ns |
| isPentagon | 147 ns | **93.7 ns** | 97.1 ns |
| getIcosahedronFaces | 305 ns | 323 ns | **290 ns** |
| gridDisk | 24.4 µs | 63.8 µs | **17.7 µs** |
| gridDiskDistances | 7115 ns | 11.8 µs | **7073 ns** |
| gridRingUnsafe | 2332 ns | 2266 ns | **1748 ns** |
| gridDistance | 395 ns | 359 ns | **253 ns** |
| cellToLocalIj | **373 ns** | 421 ns | 469 ns |
| localIjToCell | 563 ns | 642 ns | **371 ns** |
| gridPathCells | 2326 ns | 1863 ns | **1346 ns** |
| cellToParent | 318 ns | 206 ns | **156 ns** |
| cellToChildren | 14.6 µs | 12.6 µs | **11.4 µs** |
| cellToChildrenSize | 209 ns | 237 ns | **114 ns** |
| cellToCenterChild | 300 ns | 187 ns | **147 ns** |
| compactCells | 20.0 µs | 60.6 µs | **18.2 µs** |
| uncompactCells | 16.9 µs | 18.4 µs | **15.7 µs** |
| polygonToCells | 25.1 µs | 53.1 µs | **22.5 µs** |
| polygonToCellsWithHoles | 33.1 µs | 61.5 µs | **30.1 µs** |
| polygonToCellsExperimental | 129.34 µs | 180.87 µs | **121.72 µs** |
| cellsToMultiPolygon | **32.4 µs** | 142.87 µs | 34.8 µs |
| cellsToMultiPolygonGeoJson | **31.8 µs** | 144.12 µs | 34.9 µs |
| areNeighborCells | 358 ns | 331 ns | **185 ns** |
| cellsToDirectedEdge | 436 ns | 410 ns | **218 ns** |
| getDirectedEdgeOrigin | 280 ns | 181 ns | **138 ns** |
| getDirectedEdgeDestination | 293 ns | 220 ns | **152 ns** |
| directedEdgeToCells | 388 ns | **325 ns** | 355 ns |
| originToDirectedEdges | 828 ns | **626 ns** | 670 ns |
| directedEdgeToBoundary | **515 ns** | 647 ns | 846 ns |
| reverseDirectedEdge | 336 ns | 345 ns | **174 ns** |
| degsToRads | 9.2 ns | **8.9 ns** | 26.2 ns |
| radsToDegs | **10.7 ns** | 11.6 ns | 28.5 ns |
| getNumCells | 71.9 ns | 45.0 ns | **27.3 ns** |
| getHexagonEdgeLengthAvg | 71.6 ns | **34.0 ns** | 40.2 ns |
| edgeLength | 523 ns | 686 ns | **455 ns** |
| getHexagonAreaAvg | 72.3 ns | **33.2 ns** | 39.3 ns |
| cellArea | 907 ns | 1119 ns | **800 ns** |
| greatCircleDistance | **76.1 ns** | 205 ns | 214 ns |
| getRes0Cells | 18.9 µs | **10.5 µs** | 11.3 µs |
| getPentagons | **1123 ns** | 1129 ns | 1273 ns |
| cellToVertex | 438 ns | 546 ns | **295 ns** |
| cellToVertexes | 1986 ns | 2528 ns | **1848 ns** |
| vertexToLatLng | **351 ns** | 391 ns | 426 ns |
| h3IndexToSplitLong | 116 ns | **83.0 ns** | 83.5 ns |
| splitLongToH3Index | **108 ns** | 254 ns | 258 ns |
| constructCell | 189 ns | **166 ns** | 352 ns |

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
