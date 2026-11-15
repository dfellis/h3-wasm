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
libm and varargs support are provided by `mathimpl.c`/`cvar.c` behind
hand-written C shim headers in `cshim/`.

## Test

```sh
make test       # or: pnpm test
```

Runs `test/index.test.js`, a `node:test` suite that compares h3-wasm
against **both** `h3-js` and `h3-node` on every function:

- Deterministic inputs (seeded mulberry32 PRNG), 25 iterations per function.
- `strict` (deep equality) for integer/index outputs; `almost` (scaled
  1e-7 tolerance, the h3-node suite's `INFINITESIMAL`) for floating-point
  geometry, since the C libm in this build differs from h3-js's emscripten
  musl by ~1e-13 deg; `set` for order-insensitive cell lists
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
  boundaries), so the 16 MiB region never exhausts.
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
| Floating-point geometry | C libm (Zig freestanding) | musl/emscripten or C libm — agreement within ~1e-13 deg |

## Performance

`build/benchmark.txt` — regenerated by the test suite (`pnpm test`) —
benchmarks 52 public functions 3-way against `h3-js` 4.5.0 and
`h3-node` 4.5.3. Per-call times below (light functions: 1000 iters, heavy:
500, 25-iter warmup) are from **Node 24 on x86-64 Linux**; the relative
pattern holds on other platforms. Fastest per row is bolded.

- **h3-node** (a compiled N-API binding) is fastest on 45 of 52 functions
  and is the performance bar.
- **h3-wasm** stays within ~1–3.4× of h3-node (median ≈ 2×) and is fastest
  outright on `splitLongToH3Index`. On the heaviest grid / compact /
  multi-polygon / coordinate functions it is ~2–4.7× faster than h3-js; on a
  few output-heavy polygon functions and on trivial accessors h3-js is
  comparable or faster.
- **h3-js** (pure JS over an emscripten build) is generally slowest on real
  work, but its inline JS wins the trivial accessors where there is little
  to compute (e.g. `degsToRads`, `getResolution`).

The cost of h3-wasm's per-call overhead (wasm invocation + argument
marshalling) is the payoff: one host-independent `h3.wasm` runs in Node,
browsers, Deno, and Bun with no native build or per-platform prebuilds.

| Function | h3-wasm | h3-js | h3-node |
| --- | ---: | ---: | ---: |
| latLngToCell | 920 ns | 4.36 µs | **461 ns** |
| cellToLatLng | 1.04 µs | 652 ns | **552 ns** |
| cellToBoundary | 2.21 µs | **1.90 µs** | 1.92 µs |
| cellToBoundaryGeoJson | 2.16 µs | **1.38 µs** | 2.09 µs |
| getResolution | 343 ns | 202 ns | **124 ns** |
| getBaseCellNumber | 308 ns | 159 ns | **117 ns** |
| isValidCell | 269 ns | 142 ns | **83.9 ns** |
| isResClassIII | 315 ns | 195 ns | **127 ns** |
| isPentagon | 256 ns | 181 ns | **128 ns** |
| getIcosahedronFaces | 610 ns | 805 ns | **337 ns** |
| gridDisk | 24.48 µs | 57.53 µs | **16.24 µs** |
| gridDiskDistances | 7.92 µs | 11.66 µs | **6.74 µs** |
| gridRingUnsafe | 3.13 µs | 3.02 µs | **2.29 µs** |
| gridDistance | 1.37 µs | 1.56 µs | **745 ns** |
| cellToLocalIj | 823 ns | 889 ns | **572 ns** |
| localIjToCell | 1.31 µs | 4.42 µs | **853 ns** |
| gridPathCells | 2.32 µs | 3.99 µs | **1.53 µs** |
| cellToParent | 596 ns | 439 ns | **186 ns** |
| cellToChildren | 16.75 µs | 12.52 µs | **12.05 µs** |
| cellToChildrenSize | 295 ns | 444 ns | **135 ns** |
| cellToCenterChild | 505 ns | 366 ns | **175 ns** |
| compactCells | 26.04 µs | 66.68 µs | **20.23 µs** |
| uncompactCells | 23.84 µs | 21.99 µs | **17.31 µs** |
| polygonToCells | 52.01 µs | 59.21 µs | **22.83 µs** |
| polygonToCellsWithHoles | 69.05 µs | 64.20 µs | **31.42 µs** |
| polygonToCellsExperimental | 348.76 µs | 184.97 µs | **123.25 µs** |
| cellsToMultiPolygon | 51.24 µs | 153.42 µs | **36.16 µs** |
| cellsToMultiPolygonGeoJson | 50.16 µs | 149.87 µs | **37.05 µs** |
| areNeighborCells | 654 ns | 862 ns | **277 ns** |
| cellsToDirectedEdge | 779 ns | 721 ns | **317 ns** |
| getDirectedEdgeOrigin | 537 ns | 420 ns | **170 ns** |
| getDirectedEdgeDestination | 553 ns | 492 ns | **189 ns** |
| directedEdgeToCells | 930 ns | 535 ns | **400 ns** |
| originToDirectedEdges | 1.14 µs | 752 ns | **721 ns** |
| directedEdgeToBoundary | 1.33 µs | **988 ns** | 1.07 µs |
| reverseDirectedEdge | 626 ns | 593 ns | **235 ns** |
| degsToRads | 63.8 ns | **22.7 ns** | 33.9 ns |
| radsToDegs | 73.9 ns | **23.1 ns** | 36.5 ns |
| getNumCells | 178 ns | 182 ns | **62.6 ns** |
| getHexagonEdgeLengthAvg | 247 ns | 201 ns | **89.8 ns** |
| edgeLength | 1.42 µs | 1.20 µs | **632 ns** |
| getHexagonAreaAvg | 183 ns | 104 ns | **54.2 ns** |
| cellArea | 2.58 µs | 1.47 µs | **997 ns** |
| greatCircleDistance | 424 ns | 489 ns | **242 ns** |
| getRes0Cells | 21.29 µs | 11.31 µs | **10.19 µs** |
| getPentagons | 1.62 µs | 2.35 µs | **1.31 µs** |
| cellToVertex | 860 ns | 1.12 µs | **432 ns** |
| cellToVertexes | 2.60 µs | 2.95 µs | **1.93 µs** |
| vertexToLatLng | 885 ns | 687 ns | **585 ns** |
| h3IndexToSplitLong | 166 ns | **114 ns** | 191 ns |
| splitLongToH3Index | **189 ns** | 272 ns | 331 ns |
| constructCell | 466 ns | 673 ns | **376 ns** |

## Repository layout

```
index.js        ESM layer: instantiation, memory management, public API
h3.zig          Zig binding root: C API declarations + bind__* exports
support.zig     Zig support module (malloc/calloc/realloc/free, qsort, …)
mathimpl.c      C libm for wasm32-freestanding
cvar.c          C varargs support
cshim/          hand-written C headers (math.h, …) for the freestanding build
Makefile        2-stage build (support.a → h3.wasm) + metadata generation
tools/          build helpers (metadata generator) + publish guard + release script
test/           node:test suite (3-way comparison vs h3-js and h3-node)
h3/             H3 v4.5.0 C library (gitignored; clone it yourself)
h3-js/ h3-node/ reference checkouts (gitignored; not required to build)
```
