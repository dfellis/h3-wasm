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

Before compiling, `make` applies the committed performance patch
(`patches/h3-v4.5.0-optimizations.patch`) to `./h3/` (idempotent — it is
re-applied automatically after `./h3/` is re-extracted or reset, which CI
does on every run).

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
  CMake's `configure_file` does in a regular H3 build), and builds
  `h3.wasm` once with Zig 0.16.0 — the Makefile first applies the
  committed performance patch (`patches/`) to the fetched source — then
  uploads it. The artifact is host-independent, so it is not rebuilt per OS
  (unlike h3-node's native prebuilds).
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

- **h3-node** (a compiled N-API binding) is fastest on 24 of 52 functions
  and remains the performance bar on the trivial accessor and string-output
  rows (`getRes0Cells`, `gridDiskDistances`, `getBaseCellNumber`, …). Since
  4.5.6 it stringifies index arrays in C (17-byte hex slots in an
  `ArrayBuffer`).
- **h3-wasm** (the v4.5.0 C source plus the committed performance patch in
  `patches/`, applied at build time) is fastest outright on 23 of 52
  (e.g. `cellToBoundary`, `cellToLatLng`, `compactCells`,
  `uncompactCells`, `cellsToMultiPolygon`, `originToDirectedEdges`,
  `splitLongToH3Index`), beats h3-js on 41 of 52, and sits ≈1.00× (median)
  off the row winner. On the heavy geometry / grid / compact /
  multi-polygon functions it is 1.3–5.4× faster than h3-js, beats h3-node
  on `compactCells`, `uncompactCells`, and `cellsToMultiPolygon`, and is
  within ~10% of it on `gridDisk`, `polygonToCells`, and `cellArea`.
- **h3-js** (the same C compiled to asm.js via emscripten) wins 5 of 52,
  mostly pure-conversion rows with little to compute (`getNumCells`,
  `getHexagonAreaAvg`, `constructCell`, …). Its trig-heavy rows are within
  ~2× of h3-wasm's: both route the C transcendentals to the host `Math.*`
  builtins (h3-wasm via a wasm import, h3-js via emscripten's JS shim — see
  [Architecture](#architecture)).

The cost of h3-wasm's per-call overhead (wasm invocation + argument
marshalling) is the payoff: one host-independent `h3.wasm` runs in Node,
browsers, Deno, and Bun with no native build or per-platform prebuilds.

| Function | h3-wasm | h3-js | h3-node |
| --- | ---: | ---: | ---: |
| latLngToCell | 451.6 ns | 684.4 ns | **305.9 ns** |
| cellToLatLng | **292.8 ns** | 332 ns | 398.7 ns |
| cellToBoundary | **644.9 ns** | 829.9 ns | 1711 ns |
| cellToBoundaryGeoJson | **671.9 ns** | 856.4 ns | 1883 ns |
| getResolution | 90.5 ns | 99 ns | **85.6 ns** |
| getBaseCellNumber | 78.2 ns | **73.5 ns** | 83.2 ns |
| isValidCell | 73.3 ns | 80.8 ns | **50.4 ns** |
| isResClassIII | **78 ns** | 79.5 ns | 82.2 ns |
| isPentagon | 102.5 ns | 92 ns | **84.9 ns** |
| getIcosahedronFaces | **213.6 ns** | 301.8 ns | 307.5 ns |
| gridDisk | 9161 ns | 49.2 µs | **6971 ns** |
| gridDiskDistances | 7024 ns | 10.4 µs | **3859 ns** |
| gridRingUnsafe | **791.8 ns** | 2140 ns | 926 ns |
| gridDistance | 250 ns | 355.3 ns | **229.8 ns** |
| cellToLocalIj | **220.7 ns** | 364.9 ns | 472.1 ns |
| localIjToCell | **315.5 ns** | 589.8 ns | 372.4 ns |
| gridPathCells | 1461 ns | 1861 ns | **1302 ns** |
| cellToParent | 245.4 ns | 186.7 ns | **134.6 ns** |
| cellToChildren | 3108 ns | 14.3 µs | **2811 ns** |
| cellToChildrenSize | 126.3 ns | 211.1 ns | **94.6 ns** |
| cellToCenterChild | 213.1 ns | 170.5 ns | **136.3 ns** |
| compactCells | **10.6 µs** | 57.3 µs | 14.8 µs |
| uncompactCells | **6118 ns** | 18.3 µs | 7614 ns |
| polygonToCells | 21.7 µs | 52.4 µs | **21.6 µs** |
| polygonToCellsWithHoles | 29.1 µs | 61.6 µs | **29.1 µs** |
| polygonToCellsExperimental | 123.27 µs | 177.67 µs | **120.99 µs** |
| cellsToMultiPolygon | **29.4 µs** | 140.77 µs | 35.2 µs |
| cellsToMultiPolygonGeoJson | **30.1 µs** | 139.55 µs | 34.5 µs |
| areNeighborCells | 222.8 ns | 289 ns | **179.1 ns** |
| cellsToDirectedEdge | 303.9 ns | 382.6 ns | **231.7 ns** |
| getDirectedEdgeOrigin | 218.2 ns | 167.5 ns | **127.3 ns** |
| getDirectedEdgeDestination | 214.1 ns | 206.3 ns | **144.6 ns** |
| directedEdgeToCells | 340.5 ns | **305 ns** | 355.9 ns |
| originToDirectedEdges | **323.1 ns** | 606.1 ns | 546.3 ns |
| directedEdgeToBoundary | **423.9 ns** | 618.3 ns | 878.7 ns |
| reverseDirectedEdge | 261.1 ns | 299 ns | **171.4 ns** |
| degsToRads | **8.8 ns** | 9.1 ns | 28.1 ns |
| radsToDegs | **10.7 ns** | 11.4 ns | 28.2 ns |
| getNumCells | 59.2 ns | 43.1 ns | **29.7 ns** |
| getHexagonEdgeLengthAvg | 62.9 ns | **32 ns** | 42.1 ns |
| edgeLength | **425.3 ns** | 647.4 ns | 470.8 ns |
| getHexagonAreaAvg | 61.9 ns | **31.9 ns** | 40.7 ns |
| cellArea | 802.9 ns | 1083 ns | **797.3 ns** |
| greatCircleDistance | **73.1 ns** | 198.7 ns | 207.5 ns |
| getRes0Cells | 3058 ns | 10.4 µs | **1783 ns** |
| getPentagons | **556.9 ns** | 1120 ns | 688 ns |
| cellToVertex | 372.8 ns | 508.3 ns | **302.7 ns** |
| cellToVertexes | **1413 ns** | 2573 ns | 1613 ns |
| vertexToLatLng | **274.7 ns** | 378 ns | 434.8 ns |
| h3IndexToSplitLong | **58.3 ns** | 68.1 ns | 71.3 ns |
| splitLongToH3Index | **111.5 ns** | 256.9 ns | 255.5 ns |
| constructCell | 179.1 ns | **164.8 ns** | 354.5 ns |
## Repository layout

```
index.js        ESM layer: instantiation, memory management, public API
h3.zig          Zig binding root: C API declarations + bind__* exports
support.zig     Zig support module (malloc/calloc/realloc/free, qsort, …)
mathcompat.c    trivial libm (round/lround/fmin/fmax); transcendentals import host Math.*
cvar.c          C varargs support
cshim/          hand-written C headers (math.h, …) for the freestanding build
Makefile        2-stage build (support.a → h3.wasm) + metadata generation
patches/        performance patch applied to the v4.5.0 H3 source at build time
tools/          build helpers (patch applier, metadata generator) + publish guard + release script
test/           node:test suite (3-way comparison vs h3-js and h3-node)
h3/             H3 v4.5.0 C library (gitignored; clone it yourself)
h3-js/ h3-node/ reference checkouts (gitignored; not required to build)
```
