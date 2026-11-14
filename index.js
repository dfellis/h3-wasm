/*
 * h3-wasm: WASM build of Uber's H3 v4.5.0 C library, compiled with Zig
 * for wasm32-freestanding. Drop-in replacement for h3-js: same API, same
 * semantics (h3-js is the reference for divergent behavior).
 *
 * The wasm module is a shared object whose memory, table, and stack
 * globals are supplied here at instantiation. H3Index values cross the
 * boundary as "split longs" (lower/upper 32-bit halves, exactly like
 * h3-js), and all scalar/array outputs are written into JS-owned wasm
 * memory at offsets managed by a bump allocator starting after the data
 * segment (address 0 is reserved wasm data and is never used).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    memoryMin,
    memoryMax,
    tableMin,
    tableMax,
    dataEnd,
} from './build/metadata.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Instantiation
// ---------------------------------------------------------------------------

// The dylib's stack grows DOWN from the top of the initial memory (the
// __stack_pointer import), while the Zig heap used by H3's internal
// allocations grows UP from that same boundary via memory.grow(). JS-owned
// data lives in between, after the data segment. The module only declares
// memoryMin pages, so we must supply the headroom ourselves: with just
// memoryMin pages the C stack and the JS bump region would collide.
const PAGE = 65536;
const INITIAL_PAGES = 256; // 16 MiB: data | JS region | stack top / heap base
const memory = new WebAssembly.Memory({
    initial: Math.max(memoryMin, INITIAL_PAGES),
    ...(memoryMax !== null ? { maximum: memoryMax } : {}),
});

const table = new WebAssembly.Table({
    initial: tableMin,
    maximum: tableMax === null ? tableMin : tableMax,
    element: 'anyfunc',
});

const wasmBytes = readFileSync(join(__dirname, 'h3.wasm'));
const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: {
        memory,
        __indirect_function_table: table,
        // Stack grows down from the top of the initial memory; the Zig heap
        // (used by h3's internal allocations) grows up from there via
        // memory.grow(). JS-owned data lives in between, after the data
        // segment.
        __stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true }, memory.buffer.byteLength),
        __memory_base: new WebAssembly.Global({ value: 'i32' }, 0),
        __table_base: new WebAssembly.Global({ value: 'i32' }, 0),
    },
});

const H3 = instance.exports;

// wasm-ld dylib convention: data segments contain pointer slots that are
// relocated against __memory_base at runtime; the host must apply them
// after instantiation (there is no start section in a dylib).
H3.__wasm_apply_data_relocs();

// memory.grow() detaches the ArrayBuffer, so re-wrap typed views whenever
// the buffer identity changes (checked after every wasm call).
let lastBuffer = null;
let u32, f64;
function refreshViews() {
    if (memory.buffer !== lastBuffer) {
        lastBuffer = memory.buffer;
        u32 = new Uint32Array(lastBuffer);
        f64 = new Float64Array(lastBuffer);
    }
}
refreshViews();

// ---------------------------------------------------------------------------
// JS-owned memory region (bump allocator)
// ---------------------------------------------------------------------------

// Top of the initial memory: the boundary between the JS-owned bump region
// below and the stack (descending) / Zig heap (ascending via memory.grow)
// above.
const INITIAL_TOP = memory.buffer.byteLength;
// All scratch written by a single public API call is dead once the call
// returns (C-side structures are destroyed inside the call), so the bump
// region is recycled at the start of every public function. Without this,
// long-running consumers would exhaust the JS-owned region.
const SCRATCH_BASE = (dataEnd + 15) & ~15;
let nextFree = SCRATCH_BASE;

function releaseScratch() {
    nextFree = SCRATCH_BASE;
}

function alloc(bytes) {
    refreshViews();
    nextFree = (nextFree + 15) & ~15;
    const p = nextFree;
    nextFree += bytes;
    if (nextFree > INITIAL_TOP) {
        throw new Error(`h3-wasm: JS-owned wasm memory exhausted (requested ${bytes} bytes)`);
    }
    return p;
}

// ---------------------------------------------------------------------------
// Error handling (mirrors h3-js/lib/errors.js)
// ---------------------------------------------------------------------------

export const E_SUCCESS = 0;
export const E_FAILED = 1;
export const E_DOMAIN = 2;
export const E_LATLNG_DOMAIN = 3;
export const E_RES_DOMAIN = 4;
export const E_CELL_INVALID = 5;
export const E_DIR_EDGE_INVALID = 6;
export const E_UNDIR_EDGE_INVALID = 7;
export const E_VERTEX_INVALID = 8;
export const E_PENTAGON = 9;
export const E_DUPLICATE_INPUT = 10;
export const E_NOT_NEIGHBORS = 11;
export const E_RES_MISMATCH = 12;
export const E_MEMORY_ALLOC = 13;
export const E_MEMORY_BOUNDS = 14;
export const E_OPTION_INVALID = 15;
export const E_INDEX_INVALID = 16;
export const E_BASE_CELL_DOMAIN = 17;
export const E_DIGIT_DOMAIN = 18;
export const E_DELETED_DIGIT = 19;

// Error codes for JS errors thrown in the bindings
export const E_UNKNOWN_UNIT = 1000;
export const E_ARRAY_LENGTH = 1001;
export const E_NULL_INDEX = 1002;

const H3_ERROR_MSGS = {
    [E_SUCCESS]: 'Success',
    [E_FAILED]: 'The operation failed but a more specific error is not available',
    [E_DOMAIN]: 'Argument was outside of acceptable range',
    [E_LATLNG_DOMAIN]: 'Latitude or longitude arguments were outside of acceptable range',
    [E_RES_DOMAIN]: 'Resolution argument was outside of acceptable range',
    [E_CELL_INVALID]: 'Cell argument was not valid',
    [E_DIR_EDGE_INVALID]: 'Directed edge argument was not valid',
    [E_UNDIR_EDGE_INVALID]: 'Undirected edge argument was not valid',
    [E_VERTEX_INVALID]: 'Vertex argument was not valid',
    [E_PENTAGON]: 'Pentagon distortion was encountered',
    [E_DUPLICATE_INPUT]: 'Duplicate input',
    [E_NOT_NEIGHBORS]: 'Cell arguments were not neighbors',
    [E_RES_MISMATCH]: 'Cell arguments had incompatible resolutions',
    [E_MEMORY_ALLOC]: 'Memory allocation failed',
    [E_MEMORY_BOUNDS]: 'Bounds of provided memory were insufficient',
    [E_OPTION_INVALID]: 'Mode or flags argument was not valid',
    [E_INDEX_INVALID]: 'Index argument was not valid',
    [E_BASE_CELL_DOMAIN]: 'Base cell number was outside of acceptable range',
    [E_DIGIT_DOMAIN]: 'Child indexing digits invalid',
    [E_DELETED_DIGIT]: 'Child indexing digits refer to a deleted subsequence'
};

const JS_ERROR_MESSAGES = {
    [E_UNKNOWN_UNIT]: 'Unknown unit',
    [E_ARRAY_LENGTH]: 'Array length out of bounds',
    [E_NULL_INDEX]: 'Got unexpected null value for H3 index'
};

const UNKNOWN_ERROR_MSG = 'Unknown error';

function createError(messages, errCode, meta) {
    const hasValue = meta && 'value' in meta;
    const err = new Error(
        `${messages[errCode] || UNKNOWN_ERROR_MSG} (code: ${errCode}${
            hasValue ? `, value: ${meta.value}` : ''
        })`
    );
    // @ts-expect-error - TS doesn't like extending Error
    err.code = errCode;
    return err;
}

export function H3LibraryError(errCode, value) {
    refreshViews();
    const meta = arguments.length === 2 ? { value } : {};
    return createError(H3_ERROR_MSGS, errCode, meta);
}

export function JSBindingError(errCode, value) {
    refreshViews();
    const meta = arguments.length === 2 ? { value } : {};
    return createError(JS_ERROR_MESSAGES, errCode, meta);
}

function throwIfError(errCode) {
    if (errCode !== 0) {
        throw H3LibraryError(errCode);
    }
}

// ---------------------------------------------------------------------------
// Unit constants
// ---------------------------------------------------------------------------

export const UNITS = {
    m: 'm',
    m2: 'm2',
    km: 'km',
    km2: 'km2',
    rads: 'rads',
    rads2: 'rads2'
};

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export const POLYGON_TO_CELLS_FLAGS = {
    containmentCenter: 'containmentCenter',
    containmentFull: 'containmentFull',
    containmentOverlapping: 'containmentOverlapping',
    containmentOverlappingBbox: 'containmentOverlappingBbox'
};

// ---------------------------------------------------------------------------
// Split-long and misc helpers (behaviorally identical to h3-js)
// ---------------------------------------------------------------------------

const BASE_16 = 16;
const INVALID_HEXIDECIMAL_CHAR = /[^0-9a-fA-F]/;

export function h3IndexToSplitLong(h3Index) {
    refreshViews();
    // NOTE: no releaseScratch() here — this helper runs inside public
    // functions (storeH3Index, etc.) while their scratch is still live.
    // Mirror h3-js exactly: a two-element integer array passes through
    // untouched, and hex strings are split without a 64-bit range check.
    // Out-of-32-bit values are truncated when the halves reach the wasm
    // i32 imports, same as the emscripten glue h3-js uses.
    if (
        Array.isArray(h3Index) &&
        h3Index.length === 2 &&
        Number.isInteger(h3Index[0]) &&
        Number.isInteger(h3Index[1])
    ) {
        return h3Index;
    }
    if (typeof h3Index !== 'string' || INVALID_HEXIDECIMAL_CHAR.test(h3Index)) {
        return [0, 0];
    }
    const upper = parseInt(h3Index.substring(0, h3Index.length - 8), BASE_16);
    const lower = parseInt(h3Index.substring(h3Index.length - 8), BASE_16);
    return [lower, upper];
}

export function splitLongToH3Index(lower, upper) {
    refreshViews();
    // `>>> 0` reinterprets each half as unsigned, so a half with the top bit
    // set — which arrives as a negative signed i32 from numberToSplitLong or a
    // wasm i32 export — still formats as its 8 hex digits. The upper half is
    // not padded: a valid H3 index is 15 hex digits, so its upper half
    // (0x08-0x0a…) is always 7 digits.
    return (
        (upper >>> 0).toString(BASE_16) +
        (lower >>> 0).toString(BASE_16).padStart(8, '0')
    );
}

// One more than the max size of an unsigned 32-bit int.
// Dividing by this number is equivalent to num >>> 32
const UPPER_BIT_DIVISOR = Math.pow(2, 32);

function numberToSplitLong(num) {
    if (typeof num !== 'number') {
        return [0, 0];
    }
    return [num | 0, (num / UPPER_BIT_DIVISOR) | 0];
}

export function degsToRads(deg) {
    refreshViews();
    return (deg * Math.PI) / 180;
}

export function radsToDegs(rad) {
    refreshViews();
    return (rad * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Memory read/write helpers
// ---------------------------------------------------------------------------

/**
 * Read an H3 index from a pointer. Returns null (h3-js sentinel) when the
 * upper 32 bits are 0.
 */
function readH3IndexFromPtr(cAddress) {
    const lower = u32[cAddress >> 2];
    const upper = u32[(cAddress >> 2) + 1];
    return upper ? splitLongToH3Index(lower, upper) : null;
}

/**
 * Read an array of 64-bit H3 indexes, skipping 0s.
 */
function readIndexArray(cAddress, maxCount) {
    const out = [];
    for (let i = 0; i < maxCount; i++) {
        const h3Index = readH3IndexFromPtr(cAddress + 8 * i);
        if (h3Index !== null) {
            out.push(h3Index);
        }
    }
    return out;
}

/**
 * Store an H3 index as little-endian [lower, upper] 32-bit halves.
 */
function storeH3Index(h3Index, cAddress, offset) {
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    u32[(cAddress >> 2) + 2 * offset] = lo >>> 0;
    u32[(cAddress >> 2) + 2 * offset + 1] = hi >>> 0;
}

function storeArrayOfH3Indexes(cAddress, hexagons) {
    for (let i = 0; i < hexagons.length; i++) {
        storeH3Index(hexagons[i], cAddress, i);
    }
}

/**
 * Read a signed 64-bit int as a JS number (may lose precision above
 * MAX_SAFE_INTEGER, same as h3-js).
 */
function readI64(cAddress) {
    const lo = u32[cAddress >> 2];
    const hi = u32[(cAddress >> 2) + 1];
    return lo + (hi | 0) * 4294967296;
}

function readDoubleFromPtr(cAddress) {
    return f64[cAddress >> 3];
}

function readLatLng(cAddress) {
    return [radsToDegs(f64[cAddress >> 3]), radsToDegs(f64[(cAddress >> 3) + 1])];
}

/**
 * Read the CellBoundary structure (numVerts at +0, LatLng verts at +8 due to
 * 8-byte alignment) into a list of coordinate pairs.
 */
function readCellBoundary(cellBoundary, geoJsonCoords, closedLoop) {
    const numVerts = u32[cellBoundary >> 2] | 0;
    const out = [];
    for (let i = 0; i < numVerts; i++) {
        const a = cellBoundary + 8 + 16 * i;
        const lat = radsToDegs(f64[a >> 3]);
        const lng = radsToDegs(f64[(a >> 3) + 1]);
        out.push(geoJsonCoords ? [lng, lat] : [lat, lng]);
    }
    if (closedLoop) {
        out.push(out[0]);
    }
    return out;
}

/**
 * Allocate a zeroed C array for binding output.
 */
function callocArray(count, itemSize) {
    const byteLength = count * itemSize;
    if (!Number.isSafeInteger(byteLength) || byteLength > MAX_WASM_ALLOCATION_BYTE_LENGTH) {
        throw H3LibraryError(E_MEMORY_ALLOC, byteLength);
    }
    const ptr = alloc(byteLength);
    for (let i = 0; i < byteLength / 4; i++) {
        u32[(ptr >> 2) + i] = 0;
    }
    return ptr;
}

/**
 * Write a GeoLoop struct at geoLoopPtr, allocating the vertex array in
 * JS-owned memory.
 */
function writeGeoLoop(polygonArray, geoLoopPtr, isGeoJson) {
    const numVerts = polygonArray.length;
    const geoCoordArray = callocArray(numVerts, 16);
    const latIndex = isGeoJson ? 1 : 0;
    const lngIndex = isGeoJson ? 0 : 1;
    for (let i = 0; i < numVerts; i++) {
        f64[(geoCoordArray >> 3) + 2 * i] = degsToRads(polygonArray[i][latIndex]);
        f64[(geoCoordArray >> 3) + 2 * i + 1] = degsToRads(polygonArray[i][lngIndex]);
    }
    u32[geoLoopPtr >> 2] = numVerts;
    u32[(geoLoopPtr >> 2) + 1] = geoCoordArray;
}

/**
 * Create a GeoPolygon struct in JS-owned memory. Any loops beyond the first
 * are holes.
 */
function writeGeoPolygon(coordinates, isGeoJson) {
    // GeoPolygon = GeoLoop(8) + int numHoles(4) + GeoLoop *holes(4) = 16 bytes
    const numHoles = coordinates.length - 1;
    const geoPolygon = alloc(16);
    writeGeoLoop(coordinates[0], geoPolygon, isGeoJson);
    let holes = 0;
    if (numHoles > 0) {
        holes = callocArray(numHoles, 8);
        for (let i = 0; i < numHoles; i++) {
            writeGeoLoop(coordinates[i + 1], holes + 8 * i, isGeoJson);
        }
    }
    u32[(geoPolygon >> 2) + 2] = numHoles;
    u32[(geoPolygon >> 2) + 3] = holes;
    return geoPolygon;
}

// ---------------------------------------------------------------------------
// Validation helpers (identical to h3-js)
// ---------------------------------------------------------------------------

function validateRes(res) {
    if (typeof res !== 'number' || res < 0 || res > 15 || Math.floor(res) !== res) {
        throw H3LibraryError(E_RES_DOMAIN, res);
    }
    return res;
}

function validateH3Index(h3Index) {
    if (!h3Index) throw JSBindingError(E_NULL_INDEX);
    return h3Index;
}

const MAX_JS_ARRAY_LENGTH = Math.pow(2, 32) - 1;
const MAX_WASM_ALLOCATION_BYTE_LENGTH = Math.pow(2, 31) - 1;

function validateArrayLength(length) {
    if (length > MAX_JS_ARRAY_LENGTH) {
        throw JSBindingError(E_ARRAY_LENGTH, length);
    }
    return length;
}

function polygonToCellsFlagsToNumber(flags) {
    switch (flags) {
        case POLYGON_TO_CELLS_FLAGS.containmentCenter:
            return 0;
        case POLYGON_TO_CELLS_FLAGS.containmentFull:
            return 1;
        case POLYGON_TO_CELLS_FLAGS.containmentOverlapping:
            return 2;
        case POLYGON_TO_CELLS_FLAGS.containmentOverlappingBbox:
            return 3;
        default:
            throw JSBindingError(E_OPTION_INVALID, flags);
    }
}

// ---------------------------------------------------------------------------
// Public API functions: Core
// ---------------------------------------------------------------------------

export function isValidCell(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    return Boolean(H3.bind__isValidCell(lo, hi));
}

export function isValidIndex(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    return Boolean(H3.bind__isValidIndex(lo, hi));
}

export function isPentagon(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    return Boolean(H3.bind__isPentagon(lo, hi));
}

export function isResClassIII(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    return Boolean(H3.bind__isResClassIII(lo, hi));
}

export function getBaseCellNumber(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    return H3.bind__getBaseCellNumber(lo, hi);
}

export function getIndexDigit(h3Index, digit) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const out = alloc(4);
    refreshViews();
    throwIfError(H3.bind__getIndexDigit(lo, hi, digit, out));
    refreshViews();
    return u32[out >> 2] | 0;
}

export function getIcosahedronFaces(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const countPtr = alloc(4);
    refreshViews();
    throwIfError(H3.bind__maxFaceCount(lo, hi, countPtr));
    refreshViews();
    const count = u32[countPtr >> 2] | 0;
    const faces = alloc(4 * count);
    refreshViews();
    throwIfError(H3.bind__getIcosahedronFaces(lo, hi, faces));
    refreshViews();
    // Negative values are considered invalid and ignored in output
    const out = [];
    for (let i = 0; i < count; i++) {
        const int = u32[(faces >> 2) + i] | 0;
        if (int >= 0) {
            out.push(int);
        }
    }
    return out;
}

export function getResolution(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    // Accept any valid index (cell, directed edge, or vertex), matching the C API docs.
    if (!H3.bind__isValidIndex(lo, hi)) {
        // Compatibility with stated API
        return -1;
    }
    return H3.bind__getResolution(lo, hi);
}

export function constructCell(baseCellNumber, digits, res) {
    refreshViews();
    releaseScratch();
    if (res === undefined) {
        res = digits.length;
    }
    if (digits.length !== res) {
        throw H3LibraryError(E_DIGIT_DOMAIN, digits.length);
    }
    if (digits.length > 15) {
        throw H3LibraryError(E_DIGIT_DOMAIN, digits.length);
    }

    const digitsMemory = alloc(4 * digits.length);
    const h3IndexPtr = alloc(8);
    refreshViews();
    for (let i = 0; i < digits.length; i++) {
        u32[(digitsMemory >> 2) + i] = digits[i];
    }
    throwIfError(H3.bind__constructCell(res, baseCellNumber, digitsMemory, h3IndexPtr));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(h3IndexPtr));
}

export function latLngToCell(lat, lng, res) {
    refreshViews();
    releaseScratch();
    const h3IndexPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__latLngToCell(degsToRads(lat), degsToRads(lng), res, h3IndexPtr));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(h3IndexPtr));
}

export function cellToLatLng(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const latLng = alloc(16);
    refreshViews();
    throwIfError(H3.bind__cellToLatLng(lo, hi, latLng));
    refreshViews();
    return readLatLng(latLng);
}

export function cellToBoundary(h3Index, formatAsGeoJson) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    // CellBoundary = int numVerts(4) + pad(4) + 10 * LatLng(16) = 88 bytes
    const cellBoundary = alloc(88);
    refreshViews();
    throwIfError(H3.bind__cellToBoundary(lo, hi, cellBoundary));
    refreshViews();
    return readCellBoundary(cellBoundary, formatAsGeoJson, formatAsGeoJson);
}

// ---------------------------------------------------------------------------
// Public API functions: Algorithms
// ---------------------------------------------------------------------------

export function cellToParent(h3Index, res) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const parent = alloc(8);
    refreshViews();
    throwIfError(H3.bind__cellToParent(lo, hi, res, parent));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(parent));
}

export function cellToChildren(h3Index, res) {
    refreshViews();
    releaseScratch();
    // C's cellToChildren does not validate its input: an invalid (nonzero)
    // cell at a high child resolution makes the child iterator run 7^n
    // times (up to ~4.7e12), so cellToChildrenSize (below) validates the
    // cell up front and throws E_CELL_INVALID. h3-js instead returns []
    // here; like h3-node's malformed-input handling, we treat it as a
    // caller error.
    const count = validateArrayLength(cellToChildrenSize(h3Index, res));
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const hexagons = callocArray(count, 8);
    refreshViews();
    throwIfError(H3.bind__cellToChildren(lo, hi, res, hexagons));
    refreshViews();
    return readIndexArray(hexagons, count);
}

export function cellToChildrenSize(h3Index, res) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    // C's cellToChildrenSize only range-checks the resolution, not the
    // cell: an invalid cell would yield a plausible-looking 7^n (and
    // cellToChildren would then iterate 7^n garbage children), so the cell
    // is validated up front.
    if (!H3.bind__isValidCell(lo, hi)) {
        throw H3LibraryError(E_CELL_INVALID);
    }
    const countPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__cellToChildrenSize(lo, hi, res, countPtr));
    refreshViews();
    return readI64(countPtr);
}

export function cellToCenterChild(h3Index, res) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const centerChild = alloc(8);
    refreshViews();
    throwIfError(H3.bind__cellToCenterChild(lo, hi, res, centerChild));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(centerChild));
}

export function cellToChildPos(h3Index, parentRes) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const childPos = alloc(8);
    refreshViews();
    throwIfError(H3.bind__cellToChildPos(lo, hi, parentRes, childPos));
    refreshViews();
    return readI64(childPos);
}

export function childPosToCell(childPos, h3Index, childRes) {
    refreshViews();
    releaseScratch();
    const [cpLo, cpHi] = numberToSplitLong(childPos);
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const child = alloc(8);
    refreshViews();
    throwIfError(H3.bind__childPosToCell(cpLo, cpHi, lo, hi, childRes, child));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(child));
}

export function gridDisk(h3Index, ringSize) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const countPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__maxGridDiskSize(ringSize, countPtr));
    refreshViews();
    const count = validateArrayLength(readI64(countPtr));
    const hexagons = callocArray(count, 8);
    refreshViews();
    throwIfError(H3.bind__gridDisk(lo, hi, ringSize, hexagons));
    refreshViews();
    return readIndexArray(hexagons, count);
}

export function gridDiskDistances(h3Index, ringSize) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const countPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__maxGridDiskSize(ringSize, countPtr));
    refreshViews();
    const count = validateArrayLength(readI64(countPtr));
    const kRings = callocArray(count, 8);
    const distances = callocArray(count, 4);
    refreshViews();
    throwIfError(H3.bind__gridDiskDistances(lo, hi, ringSize, kRings, distances));
    refreshViews();
    const out = [];
    for (let i = 0; i < ringSize + 1; i++) {
        out.push([]);
    }
    for (let i = 0; i < count; i++) {
        const cell = readH3IndexFromPtr(kRings + 8 * i);
        const index = u32[(distances >> 2) + i] | 0;
        if (cell !== null) {
            out[index].push(cell);
        }
    }
    return out;
}

export function gridRing(h3Index, ringSize) {
    refreshViews();
    releaseScratch();
    const maxCount = ringSize === 0 ? 1 : 6 * ringSize;
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const hexagons = callocArray(maxCount, 8);
    refreshViews();
    throwIfError(H3.bind__gridRing(lo, hi, ringSize, hexagons));
    refreshViews();
    return readIndexArray(hexagons, maxCount);
}

export function gridRingUnsafe(h3Index, ringSize) {
    refreshViews();
    releaseScratch();
    const maxCount = ringSize === 0 ? 1 : 6 * ringSize;
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const hexagons = callocArray(maxCount, 8);
    refreshViews();
    throwIfError(H3.bind__gridRingUnsafe(lo, hi, ringSize, hexagons));
    refreshViews();
    return readIndexArray(hexagons, maxCount);
}

export function polygonToCells(coordinates, res, isGeoJson) {
    refreshViews();
    releaseScratch();
    validateRes(res);
    isGeoJson = Boolean(isGeoJson);
    // Guard against empty input
    if (coordinates.length === 0 || coordinates[0].length === 0) {
        return [];
    }
    // Wrap to expected format if a single loop is provided
    const polygon = typeof coordinates[0][0] === 'number' ? [coordinates] : coordinates;
    const geoPolygon = writeGeoPolygon(polygon, isGeoJson);
    const countPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__maxPolygonToCellsSize(geoPolygon, res, 0, countPtr));
    refreshViews();
    const count = validateArrayLength(readI64(countPtr));
    const hexagons = callocArray(count, 8);
    refreshViews();
    throwIfError(H3.bind__polygonToCells(geoPolygon, res, 0, hexagons));
    refreshViews();
    return readIndexArray(hexagons, count);
}

export function polygonToCellsExperimental(coordinates, res, flags, isGeoJson) {
    refreshViews();
    releaseScratch();
    validateRes(res);
    isGeoJson = Boolean(isGeoJson);
    const flagsInt = polygonToCellsFlagsToNumber(flags);
    // Guard against empty input
    if (coordinates.length === 0 || coordinates[0].length === 0) {
        return [];
    }
    // Wrap to expected format if a single loop is provided
    const polygon = typeof coordinates[0][0] === 'number' ? [coordinates] : coordinates;
    const geoPolygon = writeGeoPolygon(polygon, isGeoJson);
    const countPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__maxPolygonToCellsSizeExperimental(geoPolygon, res, flagsInt, countPtr));
    refreshViews();
    const count = validateArrayLength(readI64(countPtr));
    const hexagons = callocArray(count, 8);
    refreshViews();
    throwIfError(H3.bind__polygonToCellsExperimental(geoPolygon, res, flagsInt, count, 0, hexagons));
    refreshViews();
    return readIndexArray(hexagons, count);
}

export function cellsToMultiPolygon(h3Indexes, formatAsGeoJson) {
    refreshViews();
    releaseScratch();
    // Early exit on empty input
    if (!h3Indexes || !h3Indexes.length) {
        return [];
    }
    const indexCount = h3Indexes.length;
    const set = callocArray(indexCount, 8);
    const polygon = alloc(12);
    refreshViews();
    storeArrayOfH3Indexes(set, h3Indexes);
    u32[polygon >> 2] = 0;
    u32[(polygon >> 2) + 1] = 0;
    u32[(polygon >> 2) + 2] = 0;
    throwIfError(H3.bind__cellsToLinkedMultiPolygon(set, indexCount, polygon));
    refreshViews();
    // Size the flat output, flatten, then destroy the C-side structure
    const infoPtr = alloc(12);
    refreshViews();
    throwIfError(H3.bind__linkedMultiPolygonInfo(polygon, infoPtr));
    refreshViews();
    const numPolygons = u32[infoPtr >> 2];
    const numLoopsTotal = u32[(infoPtr >> 2) + 1];
    const numCoordsTotal = u32[(infoPtr >> 2) + 2];
    const dataPtr = alloc(4 * numPolygons + 4 * numLoopsTotal + 16 * numCoordsTotal);
    refreshViews();
    throwIfError(H3.bind__flattenLinkedMultiPolygon(polygon, dataPtr));
    refreshViews();
    H3.bind__destroyLinkedMultiPolygon(polygon);
    // Reconstruct nested [polygon][loop][coord] structure
    let pos = dataPtr;
    const loopsPerPolygon = [];
    for (let i = 0; i < numPolygons; i++) {
        loopsPerPolygon.push(u32[pos >> 2]);
        pos += 4;
    }
    const coordsPerLoop = [];
    for (let i = 0; i < numLoopsTotal; i++) {
        coordsPerLoop.push(u32[pos >> 2]);
        pos += 4;
    }
    const output = [];
    let loopIndex = 0;
    for (let p = 0; p < numPolygons; p++) {
        const loops = [];
        for (let q = 0; q < loopsPerPolygon[p]; q++, loopIndex++) {
            const coords = [];
            const numCoords = coordsPerLoop[loopIndex];
            for (let c = 0; c < numCoords; c++) {
                const lat = radsToDegs(f64[pos >> 3]);
                const lng = radsToDegs(f64[(pos >> 3) + 1]);
                pos += 16;
                coords.push(formatAsGeoJson ? [lng, lat] : [lat, lng]);
            }
            if (formatAsGeoJson) {
                coords.push(coords[0]);
            }
            loops.push(coords);
        }
        output.push(loops);
    }
    return output;
}

export function compactCells(h3Set) {
    refreshViews();
    releaseScratch();
    if (!h3Set || !h3Set.length) {
        return [];
    }
    const count = h3Set.length;
    const set = callocArray(count, 8);
    const compactedSet = callocArray(count, 8);
    refreshViews();
    storeArrayOfH3Indexes(set, h3Set);
    throwIfError(H3.bind__compactCells(set, compactedSet, count));
    refreshViews();
    return readIndexArray(compactedSet, count);
}

export function uncompactCells(compactedSet, res) {
    refreshViews();
    releaseScratch();
    validateRes(res);
    if (!compactedSet || !compactedSet.length) {
        return [];
    }
    const count = compactedSet.length;
    const set = callocArray(count, 8);
    const uncompactCellSizePtr = alloc(8);
    refreshViews();
    storeArrayOfH3Indexes(set, compactedSet);
    throwIfError(H3.bind__uncompactCellsSize(set, count, res, uncompactCellSizePtr));
    refreshViews();
    const uncompactCellSize = validateArrayLength(readI64(uncompactCellSizePtr));
    const uncompactedSet = callocArray(uncompactCellSize, 8);
    refreshViews();
    throwIfError(H3.bind__uncompactCells(set, count, uncompactedSet, uncompactCellSize, res));
    refreshViews();
    return readIndexArray(uncompactedSet, uncompactCellSize);
}

// ---------------------------------------------------------------------------
// Public API functions: Directed edges
// ---------------------------------------------------------------------------

export function areNeighborCells(origin, destination) {
    refreshViews();
    releaseScratch();
    const [oLo, oHi] = h3IndexToSplitLong(origin);
    const [dLo, dHi] = h3IndexToSplitLong(destination);
    const out = alloc(4);
    refreshViews();
    throwIfError(H3.bind__areNeighborCells(oLo, oHi, dLo, dHi, out));
    refreshViews();
    return Boolean(u32[out >> 2] | 0);
}

export function cellsToDirectedEdge(origin, destination) {
    refreshViews();
    releaseScratch();
    const [oLo, oHi] = h3IndexToSplitLong(origin);
    const [dLo, dHi] = h3IndexToSplitLong(destination);
    const h3IndexPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__cellsToDirectedEdge(oLo, oHi, dLo, dHi, h3IndexPtr));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(h3IndexPtr));
}

export function getDirectedEdgeOrigin(edgeIndex) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(edgeIndex);
    const h3IndexPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__getDirectedEdgeOrigin(lo, hi, h3IndexPtr));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(h3IndexPtr));
}

export function getDirectedEdgeDestination(edgeIndex) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(edgeIndex);
    const h3IndexPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__getDirectedEdgeDestination(lo, hi, h3IndexPtr));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(h3IndexPtr));
}

export function isValidDirectedEdge(edgeIndex) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(edgeIndex);
    return Boolean(H3.bind__isValidDirectedEdge(lo, hi));
}

export function directedEdgeToCells(edgeIndex) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(edgeIndex);
    const hexagons = callocArray(2, 8);
    refreshViews();
    throwIfError(H3.bind__directedEdgeToCells(lo, hi, hexagons));
    refreshViews();
    return readIndexArray(hexagons, 2);
}

export function originToDirectedEdges(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const edges = callocArray(6, 8);
    refreshViews();
    throwIfError(H3.bind__originToDirectedEdges(lo, hi, edges));
    refreshViews();
    return readIndexArray(edges, 6);
}

export function directedEdgeToBoundary(edgeIndex, formatAsGeoJson) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(edgeIndex);
    const cellBoundary = alloc(88);
    refreshViews();
    throwIfError(H3.bind__directedEdgeToBoundary(lo, hi, cellBoundary));
    refreshViews();
    return readCellBoundary(cellBoundary, formatAsGeoJson);
}

export function reverseDirectedEdge(edgeIndex) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(edgeIndex);
    const out = alloc(8);
    refreshViews();
    throwIfError(H3.bind__reverseDirectedEdge(lo, hi, out));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(out));
}

// ---------------------------------------------------------------------------
// Public API functions: Grid distance / path
// ---------------------------------------------------------------------------

export function gridDistance(origin, destination) {
    refreshViews();
    releaseScratch();
    const [oLo, oHi] = h3IndexToSplitLong(origin);
    const [dLo, dHi] = h3IndexToSplitLong(destination);
    const countPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__gridDistance(oLo, oHi, dLo, dHi, countPtr));
    refreshViews();
    return readI64(countPtr);
}

export function gridPathCells(origin, destination) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(origin);
    const [dLo, dHi] = h3IndexToSplitLong(destination);
    const countPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__gridPathCellsSize(lo, hi, dLo, dHi, countPtr));
    refreshViews();
    const count = validateArrayLength(readI64(countPtr));
    const hexagons = callocArray(count, 8);
    refreshViews();
    throwIfError(H3.bind__gridPathCells(lo, hi, dLo, dHi, hexagons));
    refreshViews();
    return readIndexArray(hexagons, count);
}

// ---------------------------------------------------------------------------
// Public API functions: Local IJ
// ---------------------------------------------------------------------------

const LOCAL_IJ_DEFAULT_MODE = 0;

export function cellToLocalIj(origin, destination) {
    refreshViews();
    releaseScratch();
    const [oLo, oHi] = h3IndexToSplitLong(origin);
    const [dLo, dHi] = h3IndexToSplitLong(destination);
    const ij = alloc(8);
    refreshViews();
    throwIfError(H3.bind__cellToLocalIj(oLo, oHi, dLo, dHi, ij));
    refreshViews();
    return {
        i: u32[ij >> 2] | 0,
        j: u32[(ij >> 2) + 1] | 0
    };
}

export function localIjToCell(origin, coords) {
    refreshViews();
    releaseScratch();
    // Validate input coords
    if (!coords || typeof coords.i !== 'number' || typeof coords.j !== 'number') {
        throw new Error('Coordinates must be provided as an {i, j} object');
    }
    const [lo, hi] = h3IndexToSplitLong(origin);
    const out = alloc(8);
    refreshViews();
    throwIfError(H3.bind__localIjToCell(lo, hi, coords.i, coords.j, out));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(out));
}

// ---------------------------------------------------------------------------
// Public API functions: Distance/area utilities
// ---------------------------------------------------------------------------

export function greatCircleDistance(latLng1, latLng2, unit) {
    refreshViews();
    releaseScratch();
    const lat1 = degsToRads(latLng1[0]);
    const lng1 = degsToRads(latLng1[1]);
    const lat2 = degsToRads(latLng2[0]);
    const lng2 = degsToRads(latLng2[1]);
    switch (unit) {
        case UNITS.m:
            return H3.bind__greatCircleDistanceM(lat1, lng1, lat2, lng2);
        case UNITS.km:
            return H3.bind__greatCircleDistanceKm(lat1, lng1, lat2, lng2);
        case UNITS.rads:
            return H3.bind__greatCircleDistanceRads(lat1, lng1, lat2, lng2);
        default:
            throw JSBindingError(E_UNKNOWN_UNIT, unit);
    }
}

export function cellArea(h3Index, unit) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const out = alloc(8);
    refreshViews();
    switch (unit) {
        case UNITS.m2:
            throwIfError(H3.bind__cellAreaM2(lo, hi, out));
            break;
        case UNITS.km2:
            throwIfError(H3.bind__cellAreaKm2(lo, hi, out));
            break;
        case UNITS.rads2:
            throwIfError(H3.bind__cellAreaRads2(lo, hi, out));
            break;
        default:
            throw JSBindingError(E_UNKNOWN_UNIT, unit);
    }
    refreshViews();
    return readDoubleFromPtr(out);
}

export function edgeLength(edge, unit) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(edge);
    const out = alloc(8);
    refreshViews();
    switch (unit) {
        case UNITS.m:
            throwIfError(H3.bind__edgeLengthM(lo, hi, out));
            break;
        case UNITS.km:
            throwIfError(H3.bind__edgeLengthKm(lo, hi, out));
            break;
        case UNITS.rads:
            throwIfError(H3.bind__edgeLengthRads(lo, hi, out));
            break;
        default:
            throw JSBindingError(E_UNKNOWN_UNIT, unit);
    }
    refreshViews();
    return readDoubleFromPtr(out);
}

export function getHexagonAreaAvg(res, unit) {
    refreshViews();
    releaseScratch();
    validateRes(res);
    const out = alloc(8);
    refreshViews();
    switch (unit) {
        case UNITS.m2:
            throwIfError(H3.bind__getHexagonAreaAvgM2(res, out));
            break;
        case UNITS.km2:
            throwIfError(H3.bind__getHexagonAreaAvgKm2(res, out));
            break;
        default:
            throw JSBindingError(E_UNKNOWN_UNIT, unit);
    }
    refreshViews();
    return readDoubleFromPtr(out);
}

export function getHexagonEdgeLengthAvg(res, unit) {
    refreshViews();
    releaseScratch();
    validateRes(res);
    const out = alloc(8);
    refreshViews();
    switch (unit) {
        case UNITS.m:
            throwIfError(H3.bind__getHexagonEdgeLengthAvgM(res, out));
            break;
        case UNITS.km:
            throwIfError(H3.bind__getHexagonEdgeLengthAvgKm(res, out));
            break;
        default:
            throw JSBindingError(E_UNKNOWN_UNIT, unit);
    }
    refreshViews();
    return readDoubleFromPtr(out);
}

// ---------------------------------------------------------------------------
// Public API functions: Vertex mode
// ---------------------------------------------------------------------------

export function cellToVertex(h3Index, vertexNum) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const vertexIndex = alloc(8);
    refreshViews();
    throwIfError(H3.bind__cellToVertex(lo, hi, vertexNum, vertexIndex));
    refreshViews();
    return validateH3Index(readH3IndexFromPtr(vertexIndex));
}

export function cellToVertexes(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const maxNumVertexes = 6;
    const vertexIndexes = callocArray(maxNumVertexes, 8);
    refreshViews();
    throwIfError(H3.bind__cellToVertexes(lo, hi, vertexIndexes));
    refreshViews();
    return readIndexArray(vertexIndexes, maxNumVertexes);
}

export function vertexToLatLng(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    const latlng = alloc(16);
    refreshViews();
    throwIfError(H3.bind__vertexToLatLng(lo, hi, latlng));
    refreshViews();
    return readLatLng(latlng);
}

export function isValidVertex(h3Index) {
    refreshViews();
    releaseScratch();
    const [lo, hi] = h3IndexToSplitLong(h3Index);
    return Boolean(H3.bind__isValidVertex(lo, hi));
}

// ---------------------------------------------------------------------------
// Public informational utilities
// ---------------------------------------------------------------------------

export function getNumCells(res) {
    refreshViews();
    releaseScratch();
    validateRes(res);
    const countPtr = alloc(8);
    refreshViews();
    throwIfError(H3.bind__getNumCells(res, countPtr));
    refreshViews();
    return readI64(countPtr);
}

export function getRes0Cells() {
    refreshViews();
    releaseScratch();
    const count = H3.bind__res0CellCount();
    const hexagons = callocArray(count, 8);
    refreshViews();
    throwIfError(H3.bind__getRes0Cells(hexagons));
    refreshViews();
    return readIndexArray(hexagons, count);
}

export function getPentagons(res) {
    refreshViews();
    releaseScratch();
    validateRes(res);
    const count = H3.bind__pentagonCount();
    const hexagons = callocArray(count, 8);
    refreshViews();
    throwIfError(H3.bind__getPentagons(res, hexagons));
    refreshViews();
    return readIndexArray(hexagons, count);
}
