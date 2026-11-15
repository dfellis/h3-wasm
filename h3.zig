//! WASM binding root for the H3 v4.5.0 C library.
//!
//! This module is the Zig root of the final shared object. It declares the
//! h3 C API and re-exposes it as `bind__*` wasm exports with a flat
//! i32/f64 argument ABI chosen for the JS layer:
//!
//!  - 64-bit H3Index values are passed as a `(lower, upper)` pair of i32s
//!    (little-endian halves), matching h3-js's "split long" convention.
//!  - Scalar outputs (i32/i64/f64) are written into JS-owned memory at a
//!    caller-provided byte offset.
//!  - Index arrays are written into caller-provided byte offsets, 8 bytes
//!    per H3Index, with 0 used as the "no value" sentinel (h3-js skips 0s).
//!
//! All exports return the h3 H3Error code (u32) where the C function reports
//! one; functions without error reporting return the value directly.
//!
//! Note: wasm32-freestanding has no `callconv(.C)`; the default `export`
//! calling convention is the wasm ABI, which is what zig cc's C code uses.
//! Export names must not collide with C-defined symbols (duplicate symbol at
//! link time), hence the `bind__` prefix.

// ---------------------------------------------------------------------------
// C API declarations
// ---------------------------------------------------------------------------

const LatLng = extern struct {
    lat: f64,
    lng: f64,
};

const CellBoundary = extern struct {
    numVerts: i32,
    _pad: u32,
    verts: [10]LatLng,
};

const GeoLoop = extern struct {
    numVerts: i32,
    verts: ?*const LatLng,
};

const GeoPolygon = extern struct {
    geoloop: GeoLoop,
    numHoles: i32,
    holes: ?*const GeoLoop,
};

const LinkedLatLng = extern struct {
    vertex: LatLng,
    next: ?*LinkedLatLng,
};

const LinkedGeoLoop = extern struct {
    first: ?*LinkedLatLng,
    last: ?*LinkedLatLng,
    next: ?*LinkedGeoLoop,
};

const LinkedGeoPolygon = extern struct {
    first: ?*LinkedGeoLoop,
    last: ?*LinkedGeoLoop,
    next: ?*LinkedGeoPolygon,
};

const CoordIJ = extern struct {
    i: i32,
    j: i32,
};

const H3Index = u64;
const H3Error = u32;

// ---------------------------------------------------------------------------
// Host libm
// ---------------------------------------------------------------------------
//
// wasm32-freestanding has no math library. Instead of shipping a software
// Taylor-series implementation (measured 2-9x slower than the host
// intrinsics, worst on inverse trig: atan2 50 ns vs 7 ns, asin/acos 66 ns
// vs 7 ns), the C transcendentals are forwarded to the env namespace, where
// index.js provides the host Math.* builtins. This is the same strategy
// emscripten uses in its JS libm shim for the h3-js asm.js build, and makes
// trig-heavy results match h3-js bit-for-bit. The C-named wrappers exist so
// the C objects' undefined symbols link against a definition (a plain
// `extern "env"` is a namespaced import and cannot resolve them); LLVM
// inlines the wrapper, so the only extra work per call is the env import
// itself. The trivial round/lround/fmin/fmax (no exact Math.* counterpart)
// live in mathcompat.c.
extern "env" fn js_sin(x: f64) f64;
extern "env" fn js_cos(x: f64) f64;
extern "env" fn js_tan(x: f64) f64;
extern "env" fn js_atan(x: f64) f64;
extern "env" fn js_atan2(y: f64, x: f64) f64;
extern "env" fn js_asin(x: f64) f64;
extern "env" fn js_acos(x: f64) f64;
extern "env" fn js_sqrt(x: f64) f64;
extern "env" fn js_floor(x: f64) f64;
extern "env" fn js_ceil(x: f64) f64;

export fn sin(x: f64) f64 {
    return js_sin(x);
}
export fn cos(x: f64) f64 {
    return js_cos(x);
}
export fn tan(x: f64) f64 {
    return js_tan(x);
}
export fn atan(x: f64) f64 {
    return js_atan(x);
}
export fn atan2(y: f64, x: f64) f64 {
    return js_atan2(y, x);
}
export fn asin(x: f64) f64 {
    return js_asin(x);
}
export fn acos(x: f64) f64 {
    return js_acos(x);
}
export fn sqrt(x: f64) f64 {
    return js_sqrt(x);
}
export fn floor(x: f64) f64 {
    return js_floor(x);
}
export fn ceil(x: f64) f64 {
    return js_ceil(x);
}

extern fn isValidCell(h: H3Index) c_int;
extern fn isValidIndex(h: H3Index) c_int;
extern fn isPentagon(h: H3Index) c_int;
extern fn isResClassIII(h: H3Index) c_int;
extern fn isValidDirectedEdge(edge: H3Index) c_int;
extern fn isValidVertex(vertex: H3Index) c_int;
extern fn getBaseCellNumber(h: H3Index) c_int;
extern fn getResolution(h: H3Index) c_int;
extern fn getIndexDigit(h: H3Index, res: c_int, out: ?*c_int) H3Error;
extern fn maxFaceCount(h3: H3Index, out: ?*c_int) H3Error;
extern fn getIcosahedronFaces(h3: H3Index, out: ?*c_int) H3Error;
extern fn getNumCells(res: c_int, out: ?*i64) H3Error;
extern fn res0CellCount() c_int;
extern fn getRes0Cells(out: ?*H3Index) H3Error;
extern fn pentagonCount() c_int;
extern fn getPentagons(res: c_int, out: ?*H3Index) H3Error;
extern fn constructCell(res: c_int, baseCellNumber: c_int, digits: ?*const c_int, out: ?*H3Index) H3Error;
extern fn latLngToCell(g: ?*const LatLng, res: c_int, out: ?*H3Index) H3Error;
extern fn cellToLatLng(h3: H3Index, g: ?*LatLng) H3Error;
extern fn cellToBoundary(h3: H3Index, gp: ?*CellBoundary) H3Error;
extern fn cellToParent(h3: H3Index, parentRes: c_int, parent: ?*H3Index) H3Error;
extern fn cellToChildrenSize(h: H3Index, childRes: c_int, out: ?*i64) H3Error;
extern fn cellToChildren(h: H3Index, childRes: c_int, children: ?*H3Index) H3Error;
extern fn cellToCenterChild(h: H3Index, childRes: c_int, child: ?*H3Index) H3Error;
extern fn cellToChildPos(child: H3Index, parentRes: c_int, out: ?*i64) H3Error;
extern fn childPosToCell(childPos: i64, parent: H3Index, childRes: c_int, child: ?*H3Index) H3Error;
extern fn maxGridDiskSize(k: c_int, out: ?*i64) H3Error;
extern fn maxGridRingSize(k: c_int, out: ?*i64) H3Error;
extern fn gridDisk(origin: H3Index, k: c_int, out: ?*H3Index) H3Error;
extern fn gridDiskDistances(origin: H3Index, k: c_int, out: ?*H3Index, distances: ?*c_int) H3Error;
extern fn gridRing(origin: H3Index, k: c_int, out: ?*H3Index) H3Error;
extern fn gridRingUnsafe(origin: H3Index, k: c_int, out: ?*H3Index) H3Error;
extern fn maxPolygonToCellsSize(geoPolygon: ?*const GeoPolygon, res: c_int, flags: u32, out: ?*i64) H3Error;
extern fn polygonToCells(geoPolygon: ?*const GeoPolygon, res: c_int, flags: u32, out: ?*H3Index) H3Error;
extern fn maxPolygonToCellsSizeExperimental(polygon: ?*const GeoPolygon, res: c_int, flags: u32, out: ?*i64) H3Error;
extern fn polygonToCellsExperimental(polygon: ?*const GeoPolygon, res: c_int, flags: u32, size: i64, out: ?*H3Index) H3Error;
extern fn cellsToLinkedMultiPolygon(h3Set: ?*const H3Index, numHexes: c_int, out: ?*LinkedGeoPolygon) H3Error;
extern fn destroyLinkedMultiPolygon(polygon: ?*LinkedGeoPolygon) void;
extern fn compactCells(h3Set: ?*const H3Index, compactedSet: ?*H3Index, numHexes: i64) H3Error;
extern fn uncompactCellsSize(compactedSet: ?*const H3Index, numCompacted: i64, res: c_int, out: ?*i64) H3Error;
extern fn uncompactCells(compactedSet: ?*const H3Index, numCompacted: i64, outSet: ?*H3Index, numOut: i64, res: c_int) H3Error;
extern fn areNeighborCells(origin: H3Index, destination: H3Index, out: ?*c_int) H3Error;
extern fn cellsToDirectedEdge(origin: H3Index, destination: H3Index, out: ?*H3Index) H3Error;
extern fn getDirectedEdgeOrigin(edge: H3Index, out: ?*H3Index) H3Error;
extern fn getDirectedEdgeDestination(edge: H3Index, out: ?*H3Index) H3Error;
extern fn directedEdgeToCells(edge: H3Index, originDestination: ?*H3Index) H3Error;
extern fn originToDirectedEdges(origin: H3Index, edges: ?*H3Index) H3Error;
extern fn directedEdgeToBoundary(edge: H3Index, gb: ?*CellBoundary) H3Error;
extern fn reverseDirectedEdge(edge: H3Index, out: ?*H3Index) H3Error;
extern fn gridDistance(origin: H3Index, h3: H3Index, distance: ?*i64) H3Error;
extern fn gridPathCellsSize(start: H3Index, end: H3Index, size: ?*i64) H3Error;
extern fn gridPathCells(start: H3Index, end: H3Index, out: ?*H3Index) H3Error;
extern fn cellToLocalIj(origin: H3Index, h3: H3Index, mode: u32, out: ?*CoordIJ) H3Error;
extern fn localIjToCell(origin: H3Index, ij: ?*const CoordIJ, mode: u32, out: ?*H3Index) H3Error;
extern fn greatCircleDistanceRads(a: ?*const LatLng, b: ?*const LatLng) f64;
extern fn greatCircleDistanceKm(a: ?*const LatLng, b: ?*const LatLng) f64;
extern fn greatCircleDistanceM(a: ?*const LatLng, b: ?*const LatLng) f64;
extern fn cellAreaRads2(h: H3Index, out: ?*f64) H3Error;
extern fn cellAreaKm2(h: H3Index, out: ?*f64) H3Error;
extern fn cellAreaM2(h: H3Index, out: ?*f64) H3Error;
extern fn edgeLengthRads(edge: H3Index, length: ?*f64) H3Error;
extern fn edgeLengthKm(edge: H3Index, length: ?*f64) H3Error;
extern fn edgeLengthM(edge: H3Index, length: ?*f64) H3Error;
extern fn getHexagonAreaAvgKm2(res: c_int, out: ?*f64) H3Error;
extern fn getHexagonAreaAvgM2(res: c_int, out: ?*f64) H3Error;
extern fn getHexagonEdgeLengthAvgKm(res: c_int, out: ?*f64) H3Error;
extern fn getHexagonEdgeLengthAvgM(res: c_int, out: ?*f64) H3Error;
extern fn cellToVertex(origin: H3Index, vertexNum: c_int, out: ?*H3Index) H3Error;
extern fn cellToVertexes(origin: H3Index, vertexes: ?*H3Index) H3Error;
extern fn vertexToLatLng(vertex: H3Index, point: ?*LatLng) H3Error;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Combine the little-endian 32-bit halves of a split long into an H3Index.
fn idx(lo: i32, hi: i32) H3Index {
    return @as(u32, @bitCast(lo)) | (@as(u64, @as(u32, @bitCast(hi))) << 32);
}

/// Byte-offset -> optional pointer (for C output params).
fn optptr(comptime T: type, off: i32) ?*T {
    return @ptrFromInt(@as(usize, @intCast(off)));
}

/// Byte-offset -> optional const pointer (for C input structs).
fn constoptptr(comptime T: type, off: i32) ?*const T {
    return @ptrFromInt(@as(usize, @intCast(off)));
}

// ---------------------------------------------------------------------------
// Core predicates and inspection
// ---------------------------------------------------------------------------

export fn bind__isValidCell(lo: i32, hi: i32) i32 {
    return isValidCell(idx(lo, hi));
}

export fn bind__isValidIndex(lo: i32, hi: i32) i32 {
    return isValidIndex(idx(lo, hi));
}

export fn bind__isPentagon(lo: i32, hi: i32) i32 {
    return isPentagon(idx(lo, hi));
}

export fn bind__isResClassIII(lo: i32, hi: i32) i32 {
    return isResClassIII(idx(lo, hi));
}

export fn bind__isValidDirectedEdge(lo: i32, hi: i32) i32 {
    return isValidDirectedEdge(idx(lo, hi));
}

export fn bind__isValidVertex(lo: i32, hi: i32) i32 {
    return isValidVertex(idx(lo, hi));
}

export fn bind__getBaseCellNumber(lo: i32, hi: i32) i32 {
    return getBaseCellNumber(idx(lo, hi));
}

export fn bind__getResolution(lo: i32, hi: i32) i32 {
    return getResolution(idx(lo, hi));
}

export fn bind__getIndexDigit(lo: i32, hi: i32, digit: i32, out: i32) u32 {
    return getIndexDigit(idx(lo, hi), digit, optptr(c_int, out));
}

export fn bind__maxFaceCount(lo: i32, hi: i32, out: i32) u32 {
    return maxFaceCount(idx(lo, hi), optptr(c_int, out));
}

export fn bind__getIcosahedronFaces(lo: i32, hi: i32, out: i32) u32 {
    return getIcosahedronFaces(idx(lo, hi), optptr(c_int, out));
}

export fn bind__getNumCells(res: i32, out: i32) u32 {
    return getNumCells(res, optptr(i64, out));
}

export fn bind__res0CellCount() i32 {
    return res0CellCount();
}

export fn bind__getRes0Cells(out: i32) u32 {
    return getRes0Cells(optptr(H3Index, out));
}

export fn bind__pentagonCount() i32 {
    return pentagonCount();
}

export fn bind__getPentagons(res: i32, out: i32) u32 {
    return getPentagons(res, optptr(H3Index, out));
}

// ---------------------------------------------------------------------------
// Construction and basic conversion
// ---------------------------------------------------------------------------

export fn bind__constructCell(res: i32, baseCellNumber: i32, digits: i32, out: i32) u32 {
    return constructCell(res, baseCellNumber, constoptptr(c_int, digits), optptr(H3Index, out));
}

export fn bind__latLngToCell(lat: f64, lng: f64, res: i32, out: i32) u32 {
    var g = LatLng{ .lat = lat, .lng = lng };
    return latLngToCell(&g, res, optptr(H3Index, out));
}

export fn bind__cellToLatLng(lo: i32, hi: i32, out: i32) u32 {
    return cellToLatLng(idx(lo, hi), optptr(LatLng, out));
}

export fn bind__cellToBoundary(lo: i32, hi: i32, out: i32) u32 {
    return cellToBoundary(idx(lo, hi), optptr(CellBoundary, out));
}

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

export fn bind__cellToParent(lo: i32, hi: i32, parentRes: i32, out: i32) u32 {
    return cellToParent(idx(lo, hi), parentRes, optptr(H3Index, out));
}

export fn bind__cellToChildrenSize(lo: i32, hi: i32, childRes: i32, out: i32) u32 {
    return cellToChildrenSize(idx(lo, hi), childRes, optptr(i64, out));
}

export fn bind__cellToChildren(lo: i32, hi: i32, childRes: i32, out: i32) u32 {
    return cellToChildren(idx(lo, hi), childRes, optptr(H3Index, out));
}

export fn bind__cellToCenterChild(lo: i32, hi: i32, childRes: i32, out: i32) u32 {
    return cellToCenterChild(idx(lo, hi), childRes, optptr(H3Index, out));
}

export fn bind__cellToChildPos(lo: i32, hi: i32, parentRes: i32, out: i32) u32 {
    return cellToChildPos(idx(lo, hi), parentRes, optptr(i64, out));
}

export fn bind__childPosToCell(cpLo: i32, cpHi: i32, parentLo: i32, parentHi: i32, childRes: i32, out: i32) u32 {
    const childPos: i64 = @bitCast(@as(u32, @bitCast(cpLo)) | (@as(u64, @as(u32, @bitCast(cpHi))) << 32));
    return childPosToCell(childPos, idx(parentLo, parentHi), childRes, optptr(H3Index, out));
}

// ---------------------------------------------------------------------------
// Grid algorithms
// ---------------------------------------------------------------------------

export fn bind__maxGridDiskSize(k: i32, out: i32) u32 {
    return maxGridDiskSize(k, optptr(i64, out));
}

export fn bind__maxGridRingSize(k: i32, out: i32) u32 {
    return maxGridRingSize(k, optptr(i64, out));
}

export fn bind__gridDisk(lo: i32, hi: i32, k: i32, out: i32) u32 {
    return gridDisk(idx(lo, hi), k, optptr(H3Index, out));
}

export fn bind__gridDiskDistances(lo: i32, hi: i32, k: i32, outIdx: i32, outDist: i32) u32 {
    return gridDiskDistances(idx(lo, hi), k, optptr(H3Index, outIdx), optptr(c_int, outDist));
}

export fn bind__gridRing(lo: i32, hi: i32, k: i32, out: i32) u32 {
    return gridRing(idx(lo, hi), k, optptr(H3Index, out));
}

export fn bind__gridRingUnsafe(lo: i32, hi: i32, k: i32, out: i32) u32 {
    return gridRingUnsafe(idx(lo, hi), k, optptr(H3Index, out));
}

// ---------------------------------------------------------------------------
// Polyfill
// ---------------------------------------------------------------------------

export fn bind__maxPolygonToCellsSize(poly: i32, res: i32, flags: u32, out: i32) u32 {
    return maxPolygonToCellsSize(constoptptr(GeoPolygon, poly), res, flags, optptr(i64, out));
}

export fn bind__polygonToCells(poly: i32, res: i32, flags: u32, out: i32) u32 {
    return polygonToCells(constoptptr(GeoPolygon, poly), res, flags, optptr(H3Index, out));
}

export fn bind__maxPolygonToCellsSizeExperimental(poly: i32, res: i32, flags: u32, out: i32) u32 {
    return maxPolygonToCellsSizeExperimental(constoptptr(GeoPolygon, poly), res, flags, optptr(i64, out));
}

export fn bind__polygonToCellsExperimental(poly: i32, res: i32, flags: u32, sizeLo: i32, sizeHi: i32, out: i32) u32 {
    const size: i64 = @bitCast(@as(u32, @bitCast(sizeLo)) | (@as(u64, @as(u32, @bitCast(sizeHi))) << 32));
    return polygonToCellsExperimental(constoptptr(GeoPolygon, poly), res, flags, size, optptr(H3Index, out));
}

export fn bind__cellsToLinkedMultiPolygon(set: i32, numHexes: i32, out: i32) u32 {
    return cellsToLinkedMultiPolygon(constoptptr(H3Index, set), numHexes, optptr(LinkedGeoPolygon, out));
}

export fn bind__destroyLinkedMultiPolygon(poly: i32) void {
    destroyLinkedMultiPolygon(optptr(LinkedGeoPolygon, poly));
}

/// Defensive cap on walk length; a corrupted list must not hang the module.
const MAX_FLAT_WALK = 0x7fffffff;

/// Writes [numPolygons, numLoopsTotal, numCoordsTotal] as three i32s.
/// Returns E_SUCCESS (0) or E_FAILED (1) if a walk exceeds MAX_FLAT_WALK
/// (corrupted structure).
export fn bind__linkedMultiPolygonInfo(poly: i32, out: i32) u32 {
    var cur: ?*const LinkedGeoPolygon = constoptptr(LinkedGeoPolygon, poly);
    var numPolygons: i32 = 0;
    var numLoops: i32 = 0;
    var numCoords: i32 = 0;
    while (cur) |cp| {
        numPolygons += 1;
        var loop: ?*const LinkedGeoLoop = cp.first;
        while (loop) |cl| {
            numLoops += 1;
            var coord: ?*const LinkedLatLng = cl.first;
            while (coord) |cc| {
                numCoords += 1;
                if (numCoords > MAX_FLAT_WALK) return 1;
                coord = cc.next;
            }
            loop = cl.next;
        }
        cur = cp.next;
    }
    const o = @as([*]i32, @ptrFromInt(@as(usize, @intCast(out))));
    o[0] = numPolygons;
    o[1] = numLoops;
    o[2] = numCoords;
    return 0;
}

/// Flattens a LinkedGeoPolygon into JS-owned memory:
///   - numPolygons i32s: loop count per polygon
///   - numLoopsTotal i32s: coordinate count per loop
///   - numCoordsTotal LatLng structs (lat, lng, radians, in walk order)
/// JS must have called bind__linkedMultiPolygonInfo first to size the buffer.
/// Returns E_SUCCESS (0) or E_FAILED (1) if a walk exceeds MAX_FLAT_WALK
/// (corrupted structure).
export fn bind__flattenLinkedMultiPolygon(poly: i32, out: i32) u32 {
    const oi = @as([*]i32, @ptrFromInt(@as(usize, @intCast(out))));
    const of = @as([*]f64, @ptrFromInt(@as(usize, @intCast(out))));
    var pos: usize = 0;
    var steps: i32 = 0;

    // Pass 1: loop count per polygon.
    var cur: ?*const LinkedGeoPolygon = constoptptr(LinkedGeoPolygon, poly);
    while (cur) |cp| {
        var loopCount: i32 = 0;
        var loop: ?*const LinkedGeoLoop = cp.first;
        while (loop) |cl| {
            loopCount += 1;
            loop = cl.next;
        }
        oi[pos >> 2] = loopCount;
        pos += 4;
        cur = cp.next;
    }

    // Pass 2: coordinate count per loop (walk order).
    cur = constoptptr(LinkedGeoPolygon, poly);
    while (cur) |cp| {
        var loop: ?*const LinkedGeoLoop = cp.first;
        while (loop) |cl| {
            var coordCount: i32 = 0;
            var coord: ?*const LinkedLatLng = cl.first;
            while (coord) |cc| {
                coordCount += 1;
                steps += 1;
                if (steps > MAX_FLAT_WALK) return 1;
                coord = cc.next;
            }
            oi[pos >> 2] = coordCount;
            pos += 4;
            loop = cl.next;
        }
        cur = cp.next;
    }

    // Pass 3: the coordinates themselves (walk order).
    cur = constoptptr(LinkedGeoPolygon, poly);
    while (cur) |cp| {
        var loop: ?*const LinkedGeoLoop = cp.first;
        while (loop) |cl| {
            var coord: ?*const LinkedLatLng = cl.first;
            while (coord) |cc| {
                of[pos >> 3] = cc.vertex.lat;
                of[(pos >> 3) + 1] = cc.vertex.lng;
                pos += 16;
                coord = cc.next;
            }
            loop = cl.next;
        }
        cur = cp.next;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export fn bind__compactCells(set: i32, out: i32, numHexes: i32) u32 {
    return compactCells(constoptptr(H3Index, set), optptr(H3Index, out), numHexes);
}

export fn bind__uncompactCellsSize(set: i32, numCompacted: i32, res: i32, out: i32) u32 {
    return uncompactCellsSize(optptr(H3Index, set), numCompacted, res, optptr(i64, out));
}

export fn bind__uncompactCells(set: i32, numCompacted: i32, out: i32, numOut: i32, res: i32) u32 {
    return uncompactCells(constoptptr(H3Index, set), numCompacted, optptr(H3Index, out), numOut, res);
}

// ---------------------------------------------------------------------------
// Directed edges
// ---------------------------------------------------------------------------

export fn bind__areNeighborCells(oLo: i32, oHi: i32, dLo: i32, dHi: i32, out: i32) u32 {
    return areNeighborCells(idx(oLo, oHi), idx(dLo, dHi), optptr(c_int, out));
}

export fn bind__cellsToDirectedEdge(oLo: i32, oHi: i32, dLo: i32, dHi: i32, out: i32) u32 {
    return cellsToDirectedEdge(idx(oLo, oHi), idx(dLo, dHi), optptr(H3Index, out));
}

export fn bind__getDirectedEdgeOrigin(lo: i32, hi: i32, out: i32) u32 {
    return getDirectedEdgeOrigin(idx(lo, hi), optptr(H3Index, out));
}

export fn bind__getDirectedEdgeDestination(lo: i32, hi: i32, out: i32) u32 {
    return getDirectedEdgeDestination(idx(lo, hi), optptr(H3Index, out));
}

export fn bind__directedEdgeToCells(lo: i32, hi: i32, out: i32) u32 {
    return directedEdgeToCells(idx(lo, hi), optptr(H3Index, out));
}

export fn bind__originToDirectedEdges(lo: i32, hi: i32, out: i32) u32 {
    return originToDirectedEdges(idx(lo, hi), optptr(H3Index, out));
}

export fn bind__directedEdgeToBoundary(lo: i32, hi: i32, out: i32) u32 {
    return directedEdgeToBoundary(idx(lo, hi), optptr(CellBoundary, out));
}

export fn bind__reverseDirectedEdge(lo: i32, hi: i32, out: i32) u32 {
    return reverseDirectedEdge(idx(lo, hi), optptr(H3Index, out));
}

// ---------------------------------------------------------------------------
// Grid distance / path
// ---------------------------------------------------------------------------

export fn bind__gridDistance(oLo: i32, oHi: i32, dLo: i32, dHi: i32, out: i32) u32 {
    return gridDistance(idx(oLo, oHi), idx(dLo, dHi), optptr(i64, out));
}

export fn bind__gridPathCellsSize(oLo: i32, oHi: i32, dLo: i32, dHi: i32, out: i32) u32 {
    return gridPathCellsSize(idx(oLo, oHi), idx(dLo, dHi), optptr(i64, out));
}

export fn bind__gridPathCells(oLo: i32, oHi: i32, dLo: i32, dHi: i32, out: i32) u32 {
    return gridPathCells(idx(oLo, oHi), idx(dLo, dHi), optptr(H3Index, out));
}

// ---------------------------------------------------------------------------
// Local IJ coordinates
// ---------------------------------------------------------------------------

export fn bind__cellToLocalIj(oLo: i32, oHi: i32, dLo: i32, dHi: i32, out: i32) u32 {
    return cellToLocalIj(idx(oLo, oHi), idx(dLo, dHi), 0, optptr(CoordIJ, out));
}

export fn bind__localIjToCell(oLo: i32, oHi: i32, i: i32, j: i32, out: i32) u32 {
    var ij = CoordIJ{ .i = i, .j = j };
    return localIjToCell(idx(oLo, oHi), &ij, 0, optptr(H3Index, out));
}

// ---------------------------------------------------------------------------
// Distance / area
// ---------------------------------------------------------------------------

export fn bind__greatCircleDistanceRads(lat1: f64, lng1: f64, lat2: f64, lng2: f64) f64 {
    var a = LatLng{ .lat = lat1, .lng = lng1 };
    var b = LatLng{ .lat = lat2, .lng = lng2 };
    return greatCircleDistanceRads(&a, &b);
}

export fn bind__greatCircleDistanceKm(lat1: f64, lng1: f64, lat2: f64, lng2: f64) f64 {
    var a = LatLng{ .lat = lat1, .lng = lng1 };
    var b = LatLng{ .lat = lat2, .lng = lng2 };
    return greatCircleDistanceKm(&a, &b);
}

export fn bind__greatCircleDistanceM(lat1: f64, lng1: f64, lat2: f64, lng2: f64) f64 {
    var a = LatLng{ .lat = lat1, .lng = lng1 };
    var b = LatLng{ .lat = lat2, .lng = lng2 };
    return greatCircleDistanceM(&a, &b);
}

export fn bind__cellAreaRads2(lo: i32, hi: i32, out: i32) u32 {
    return cellAreaRads2(idx(lo, hi), optptr(f64, out));
}

export fn bind__cellAreaKm2(lo: i32, hi: i32, out: i32) u32 {
    return cellAreaKm2(idx(lo, hi), optptr(f64, out));
}

export fn bind__cellAreaM2(lo: i32, hi: i32, out: i32) u32 {
    return cellAreaM2(idx(lo, hi), optptr(f64, out));
}

export fn bind__edgeLengthRads(lo: i32, hi: i32, out: i32) u32 {
    return edgeLengthRads(idx(lo, hi), optptr(f64, out));
}

export fn bind__edgeLengthKm(lo: i32, hi: i32, out: i32) u32 {
    return edgeLengthKm(idx(lo, hi), optptr(f64, out));
}

export fn bind__edgeLengthM(lo: i32, hi: i32, out: i32) u32 {
    return edgeLengthM(idx(lo, hi), optptr(f64, out));
}

export fn bind__getHexagonAreaAvgM2(res: i32, out: i32) u32 {
    return getHexagonAreaAvgM2(res, optptr(f64, out));
}

export fn bind__getHexagonAreaAvgKm2(res: i32, out: i32) u32 {
    return getHexagonAreaAvgKm2(res, optptr(f64, out));
}

export fn bind__getHexagonEdgeLengthAvgM(res: i32, out: i32) u32 {
    return getHexagonEdgeLengthAvgM(res, optptr(f64, out));
}

export fn bind__getHexagonEdgeLengthAvgKm(res: i32, out: i32) u32 {
    return getHexagonEdgeLengthAvgKm(res, optptr(f64, out));
}

// ---------------------------------------------------------------------------
// Vertex mode
// ---------------------------------------------------------------------------

export fn bind__cellToVertex(lo: i32, hi: i32, vertexNum: i32, out: i32) u32 {
    return cellToVertex(idx(lo, hi), vertexNum, optptr(H3Index, out));
}

export fn bind__cellToVertexes(lo: i32, hi: i32, out: i32) u32 {
    return cellToVertexes(idx(lo, hi), optptr(H3Index, out));
}

export fn bind__vertexToLatLng(lo: i32, hi: i32, out: i32) u32 {
    return vertexToLatLng(idx(lo, hi), optptr(LatLng, out));
}

// ---------------------------------------------------------------------------
// JS glue helpers
// ---------------------------------------------------------------------------

/// Parse an H3 index hex string into a 64-bit index, written as
/// little-endian 32-bit halves (lower first) at `out`. Mirrors h3-js's
/// h3IndexToSplitLong: the lower half is the last 8 characters; the upper
/// half is everything before that, accumulated mod 2^32 (matching the i32
/// coercion the emscripten glue applies to h3-js's longer parseInt result).
/// Any non-hex character writes 0, the "no value" sentinel h3-js produces
/// as [0, 0] on its regex failure.
///
/// The caller (index.js) guarantees ASCII-only input and len >= 9: strings
/// of 8 characters or fewer yield upper === parseInt('') === NaN in h3-js,
/// a value that does not fit in a u32, so that case is handled in JS.
export fn bind__h3IndexFromString(ptr: i32, len: i32, out: i32) void {
    const bytes = @as([*]const u8, @ptrFromInt(@as(usize, @intCast(ptr))))[0..@as(usize, @intCast(len))];
    const upperEnd: usize = bytes.len - 8;
    var upper: u32 = 0;
    var lower: u32 = 0;
    var ok = true;
    var i: usize = 0;
    while (i < bytes.len) : (i += 1) {
        const c = bytes[i];
        const v: u32 = if (c >= '0' and c <= '9')
            c - '0'
        else if (c >= 'a' and c <= 'f')
            c - 'a' + 10
        else if (c >= 'A' and c <= 'F')
            c - 'A' + 10
        else {
            ok = false;
            break;
        };
        if (i < upperEnd) {
            upper = upper * 16 + v;
        } else {
            lower = lower * 16 + v;
        }
    }
    const val: u64 = if (ok) (@as(u64, upper) << 32) | @as(u64, lower) else 0;
    const outPtr = @as([*]u32, @ptrFromInt(@as(usize, @intCast(out))));
    outPtr[0] = @truncate(val);
    outPtr[1] = @truncate(val >> 32);
}
