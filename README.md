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
Behavior follows h3-js exactly, including its quirks (e.g. malformed
index strings parse to cell 0 and let the C library decide;
`h3IndexToSplitLong` performs no 32-bit range checks).

## Documented divergences

h3-wasm matches **h3-js**. Where `h3-node` 4.5.3 (the N-API build of the
same H3 4.5.0 C library) differs, the differences are pinned by the
divergence tests in `test/index.test.js`:

| Area | h3-wasm / h3-js | h3-node 4.5.3 |
| --- | --- | --- |
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

`build/benchmark.txt` (regenerated by the test suite) benchmarks 44
functions 3-way. On Node 24 / x86-64 Linux, h3-wasm is typically within
~2–3× of h3-node (a compiled N-API binding) and 3–10× faster than h3-js
(an emscripten build with its own allocation overhead) per call.

## Repository layout

```
index.js        ESM layer: instantiation, memory management, public API
h3.zig          Zig binding root: C API declarations + bind__* exports
support.zig     Zig support module (malloc/calloc/realloc/free, qsort, …)
mathimpl.c      C libm for wasm32-freestanding
cvar.c          C varargs support
cshim/          hand-written C headers (math.h, …) for the freestanding build
Makefile        2-stage build (support.a → h3.wasm) + metadata generation
tools/          build helpers (metadata generator)
test/           node:test suite (3-way comparison vs h3-js and h3-node)
h3/             H3 v4.5.0 C library (gitignored; clone it yourself)
h3-js/ h3-node/ reference checkouts (gitignored; not required to build)
```
