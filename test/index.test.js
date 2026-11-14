/**
 * Three-way test suite: h3-wasm vs h3-js vs h3-node.
 *
 * h3-js is the reference for behavior: on every (deterministic, seeded)
 * random input, the wasm output must match h3-js — exactly (strict mode),
 * within a scaled 1e-7 tolerance for floating-point outputs (C libm
 * differences are ~1e-13 deg, and h3-js/h3-node already differ from each
 * other at that scale), or as a sorted set for functions whose output
 * order is not part of the contract (polygonToCells). h3-node (the N-API
 * build of the same H3 4.5.0 C library) is a parity check: on valid
 * inputs it must produce the same value, and whenever wasm throws it must
 * throw too (its error code encoding differs: numeric strings for generic
 * C errors, 'EINVAL' for special cases).
 *
 * When all three throw for the same input (e.g. pentagon distortion in
 * gridRingUnsafe), the wasm/h3-js error codes must be equal — same C code
 * ⇒ same H3Error — and h3-node must have thrown as well.
 *
 * Documented divergences between h3-js and h3-node (malformed-input
 * handling, unit parsing, error encoding) are covered by the dedicated
 * "divergence" tests below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as h3wasm from '../index.js';

const require = createRequire(import.meta.url);
const h3js = require('h3-js');
const h3node = require('h3-node');

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so the whole suite is reproducible
// ---------------------------------------------------------------------------

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rand = mulberry32(0x5eed42);
const randLat = () => 180 * rand() - 90;
const randLng = () => 360 * rand() - 180;
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// A cell that is not itself a pentagon. Walks may still *encounter* a
// pentagon; all three libraries then throw deterministically (E_PENTAGON
// or E_FAILED), which compare3 handles via its "both threw" rule.
function randomCell(res) {
    for (let attempt = 0; attempt < 64; attempt++) {
        const cell = h3wasm.latLngToCell(randLat(), randLng(), res);
        if (!h3wasm.isPentagon(cell)) {
            return cell;
        }
    }
    throw new Error('could not find a non-pentagon cell');
}

function randomEdge() {
    const origin = randomCell(9);
    const neighbor = pick(h3wasm.gridDisk(origin, 1).filter((c) => c !== origin));
    return h3wasm.cellsToDirectedEdge(origin, neighbor);
}

// ---------------------------------------------------------------------------
// Fixed geometry (from the h3-node suite)
// ---------------------------------------------------------------------------

const SF_RING = [
    [37.77, -122.43],
    [37.55, -122.43],
    [37.55, -122.23],
    [37.77, -122.23],
    [37.77, -122.43],
];
const SF_HOLE = [
    [37.67, -122.43],
    [37.55, -122.43],
    [37.55, -122.33],
    [37.67, -122.33],
    [37.67, -122.43],
];
const SF_POLY = [SF_RING, SF_HOLE];
// GeoJSON order is [lng, lat]
const SF_GEOJSON_RING = SF_RING.map(([lat, lng]) => [lng, lat]);

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

// The h3-node suite's INFINITESIMAL: tolerance scaled to magnitude.
const INFINITESIMAL = 1e-7;

function almostEqual(a, b) {
    if (typeof a === 'number' && typeof b === 'number') {
        return Math.abs(a - b) <= INFINITESIMAL * Math.max(1, Math.abs(b));
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => almostEqual(v, b[i]));
    }
    return a === b;
}

// cellsToMultiPolygon: the order of polygons in the result depends on the
// C side's hash seed (which differs per heap), so compare polygons as an
// order-insensitive set keyed by their outer ring.
function mpKey(polygon) {
    return JSON.stringify(
        [...polygon[0]]
            .map((c) => c.slice())
            .sort((x, y) => x[0] - y[0] || x[1] - y[1])
    );
}

function mpEqual(a, b) {
    const na = [...a].sort((p, q) => mpKey(p).localeCompare(mpKey(q)));
    const nb = [...b].sort((p, q) => mpKey(p).localeCompare(mpKey(q)));
    return almostEqual(na, nb);
}

function compareValues(w, j, mode, where) {
    switch (mode) {
        case 'strict':
            assert.deepEqual(w, j, where);
            break;
        case 'almost':
            assert.ok(almostEqual(w, j), where);
            break;
        case 'set':
            assert.deepEqual([...w].sort(), [...j].sort(), where);
            break;
        case 'mp':
            assert.ok(mpEqual(w, j), where);
            break;
        default:
            throw new Error(`unknown mode ${mode}`);
    }
}

// ---------------------------------------------------------------------------
// compare3 engine: wasm vs h3-js (the target) + h3-node parity
// ---------------------------------------------------------------------------

function run(fn) {
    try {
        return { value: fn(), error: null };
    } catch (e) {
        return { value: null, error: e };
    }
}

// nodeMode / nodeSanitize allow a per-test relaxation of the h3-node
// parity check where h3-node 4.5.3 legitimately differs from h3-js (the
// divergence tests document each case):
//  - h3-node runs H3's C degsToRads/radsToDegs (deg * (M_PI / 180.0)),
//    which differs from h3-js's pure-JS (deg * Math.PI) / 180 by 1 ulp;
//  - the h3-node 4.5.3 prebuild's getIcosahedronFaces sizes its result
//    to maxFaceCount and leaves holes for unused slots (fixed upstream
//    after v4.5.3), so holes are filtered out before comparing.
function compare3(name, args, mode, nodeMode, nodeSanitize) {
    const where = `${name}(${JSON.stringify(args)})`;
    const w = run(() => h3wasm[name](...args));
    const j = run(() => h3js[name](...args));
    const n = run(() => h3node[name](...args));

    if (w.error && j.error) {
        // Target: same C library ⇒ same H3Error code.
        assert.equal(
            w.error.code,
            j.error.code,
            `${where}: wasm/h3-js error codes differ (wasm=${w.error.code}, h3-js=${j.error.code})`
        );
        // Parity: h3-node must fail too (its code encoding differs).
        assert.ok(n.error, `${where}: h3-node succeeded where wasm threw code ${w.error.code}`);
        return;
    }
    if (w.error || j.error) {
        assert.fail(
            `${where}: exactly one of wasm/h3-js threw — wasm: ${w.error ? w.error.message : 'ok'}, ` +
                `h3-js: ${j.error ? j.error.message : 'ok'}`
        );
    }

    compareValues(w.value, j.value, mode, `${where}: wasm != h3-js`);

    // Parity against h3-node on valid inputs.
    assert.ok(
        !n.error,
        `${where}: h3-node threw on valid input: ${n.error ? n.error.message : ''}`
    );
    const nv = nodeSanitize ? nodeSanitize(n.value) : n.value;
    compareValues(w.value, nv, nodeMode || mode, `${where}: wasm != h3-node`);
}

const RUNS = 25;

function compare3Test(name, genArgs, mode, extraName = '', runs = RUNS, nodeMode, nodeSanitize) {
    test(`${name}${extraName}`, () => {
        for (let i = 0; i < runs; i++) {
            compare3(name, genArgs(), mode, nodeMode, nodeSanitize);
        }
    });
}

// ---------------------------------------------------------------------------
// Random 3-way comparison tests
// ---------------------------------------------------------------------------

compare3Test('latLngToCell', () => [randLat(), randLng(), randInt(0, 15)], 'strict');
compare3Test('cellToLatLng', () => [randomCell(9)], 'almost');
compare3Test('cellToBoundary', () => [randomCell(9)], 'almost');
compare3Test('cellToBoundary', () => [randomCell(9), true], 'almost', 'GeoJson');
compare3Test('cellToBoundary', () => [h3wasm.getPentagons(randInt(0, 15))[0]], 'almost', 'Pentagon');
compare3Test('cellToBoundary', () => [h3wasm.getPentagons(randInt(0, 15))[0], true], 'almost', 'PentagonGeoJson');
compare3Test('getResolution', () => [randomCell(randInt(0, 15))], 'strict');
compare3Test('getBaseCellNumber', () => [randomCell(9)], 'strict');
compare3Test('isValidCell', () => [rand() < 0.5 ? randomCell(randInt(0, 15)) : 'asdfjkl;'], 'strict');
compare3Test('isValidIndex', () => {
    const cell = randomCell(9);
    return [rand() < 0.8 ? (rand() < 0.5 ? cell : h3wasm.cellToVertex(cell, 0)) : 'zzz'];
}, 'strict');
compare3Test('isValidVertex', () => {
    const cell = randomCell(9);
    return [rand() < 0.5 ? h3wasm.cellToVertex(cell, randInt(0, 5)) : 'zzz'];
}, 'strict');
compare3Test('isResClassIII', () => [randomCell(randInt(0, 15))], 'strict');
compare3Test('isPentagon', () => {
    const res = randInt(0, 15);
    return [rand() < 0.3 ? h3wasm.getPentagons(res)[0] : randomCell(res)];
}, 'strict');
compare3Test(
    'getIcosahedronFaces',
    () => [randomCell(randInt(0, 2))],
    'strict',
    '',
    RUNS,
    undefined,
    (v) => v.filter((x) => x != null)
);
compare3Test('gridDisk', () => [randomCell(randInt(0, 15)), randInt(0, 10)], 'strict');
compare3Test('gridDiskDistances', () => [randomCell(randInt(0, 15)), randInt(0, 5)], 'strict');
compare3Test('gridRing', () => [randomCell(randInt(0, 15)), randInt(0, 4)], 'strict');
compare3Test('gridRingUnsafe', () => [randomCell(randInt(0, 15)), randInt(0, 4)], 'strict');
compare3Test('gridDistance', () => {
    const origin = randomCell(randInt(0, 15));
    return [origin, pick(h3wasm.gridDisk(origin, 3))];
}, 'strict');
compare3Test('gridPathCells', () => {
    const origin = randomCell(9);
    return [origin, pick(h3wasm.gridDisk(origin, 2))];
}, 'strict');
compare3Test('cellToLocalIj', () => {
    const origin = randomCell(9);
    return [origin, pick(h3wasm.gridDisk(origin, 2))];
}, 'strict');
compare3Test('localIjToCell', () => [
    randomCell(randInt(0, 15)),
    { i: randInt(-3, 3), j: randInt(-3, 3) },
], 'strict');
compare3Test('cellToParent', () => [randomCell(9), randInt(0, 8)], 'strict');
compare3Test('cellToChildren', () => [randomCell(9), randInt(10, 15)], 'strict');
compare3Test('cellToChildrenSize', () => [
    randomCell(randInt(0, 12)),
    randInt(13, 15),
], 'strict');
compare3Test('cellToCenterChild', () => [randomCell(9), randInt(10, 15)], 'strict');
compare3Test('cellToChildPos', () => [randomCell(randInt(9, 14)), randInt(0, 8)], 'strict');
compare3Test('childPosToCell', () => {
    const child = randomCell(randInt(9, 14));
    const parentRes = randInt(0, 8);
    return [
        h3wasm.cellToChildPos(child, parentRes),
        h3wasm.cellToParent(child, parentRes),
        h3wasm.getResolution(child),
    ];
}, 'strict');
compare3Test('compactCells', () => [h3wasm.gridDisk(randomCell(9), 6)], 'strict');
compare3Test('uncompactCells', () => [
    h3wasm.compactCells(h3wasm.gridDisk(randomCell(9), 6)),
    9,
], 'strict');
compare3Test('polygonToCells', () => [SF_RING, 6], 'set');
compare3Test('polygonToCells', () => [SF_POLY, 6], 'set', 'WithHoles');
compare3Test('polygonToCells', () => [SF_GEOJSON_RING, 6, true], 'set', 'GeoJson');
compare3Test('polygonToCellsExperimental', () => [SF_RING, 6, 'containmentCenter'], 'set', 'Center');
compare3Test('polygonToCellsExperimental', () => [SF_RING, 6, 'containmentFull'], 'set', 'Full');
compare3Test('polygonToCellsExperimental', () => [
    SF_RING,
    6,
    'containmentOverlapping',
], 'set', 'Overlapping');
compare3Test('cellsToMultiPolygon', () => [h3wasm.gridDisk(randomCell(9), 3)], 'mp');
compare3Test('cellsToMultiPolygon', () => [h3wasm.gridDisk(randomCell(9), 3), true], 'mp', 'GeoJson');
compare3Test(
    'cellsToMultiPolygon',
    () => [
        [...new Set([...h3wasm.gridDisk(randomCell(9), 6), ...h3wasm.gridDisk(randomCell(9), 3)])],
    ],
    'mp',
    'TrueMultiPolygon'
);
compare3Test('areNeighborCells', () => {
    const origin = randomCell(9);
    return [origin, pick(h3wasm.gridDisk(origin, 1))];
}, 'strict');
compare3Test('cellsToDirectedEdge', () => {
    const origin = randomCell(9);
    return [origin, pick(h3wasm.gridDisk(origin, 1).filter((c) => c !== origin))];
}, 'strict');
compare3Test('getDirectedEdgeOrigin', () => [randomEdge()], 'strict');
compare3Test('getDirectedEdgeDestination', () => [randomEdge()], 'strict');
compare3Test('directedEdgeToCells', () => [randomEdge()], 'strict');
compare3Test('isValidDirectedEdge', () => [rand() < 0.5 ? randomEdge() : randomCell(9)], 'strict');
compare3Test('originToDirectedEdges', () => [randomCell(9)], 'strict');
compare3Test('directedEdgeToBoundary', () => [randomEdge()], 'almost');
compare3Test('directedEdgeToBoundary', () => [randomEdge(), true], 'almost', 'GeoJson');
compare3Test('reverseDirectedEdge', () => [randomEdge()], 'strict');
// h3-node computes these with H3's C implementation (deg * (M_PI / 180.0)),
// which can differ from h3-js's pure-JS (deg * Math.PI) / 180 by 1 ulp.
// wasm must match h3-js exactly (ours is the same JS expression).
compare3Test('degsToRads', () => [randInt(-180, 180)], 'strict', '', RUNS, 'almost');
compare3Test('radsToDegs', () => [rand() * 2 * Math.PI], 'strict', '', RUNS, 'almost');
compare3Test('getNumCells', () => [randInt(0, 15)], 'strict');
compare3Test('getHexagonEdgeLengthAvg', () => [randInt(0, 15), rand() < 0.5 ? 'm' : 'km'], 'almost');
compare3Test('edgeLength', () => [randomEdge(), pick(['m', 'km', 'rads'])], 'almost');
compare3Test('getHexagonAreaAvg', () => [randInt(0, 15), rand() < 0.5 ? 'm2' : 'km2'], 'almost');
compare3Test('cellArea', () => [randomCell(randInt(0, 15)), pick(['m2', 'km2', 'rads2'])], 'almost');
compare3Test('greatCircleDistance', () => [
    [randLat(), randLng()],
    [randLat(), randLng()],
    pick(['m', 'km', 'rads']),
], 'almost');
compare3Test('getRes0Cells', () => [], 'strict');
compare3Test('getPentagons', () => [randInt(0, 15)], 'strict');
compare3Test('cellToVertex', () => [randomCell(9), randInt(0, 5)], 'strict');
compare3Test('cellToVertexes', () => [randomCell(9)], 'strict');
compare3Test('vertexToLatLng', () => [h3wasm.cellToVertex(randomCell(9), randInt(0, 5))], 'almost');
compare3Test('h3IndexToSplitLong', () => [randomCell(9)], 'strict');
compare3Test('splitLongToH3Index', () => h3wasm.h3IndexToSplitLong(randomCell(9)), 'strict');

// ---------------------------------------------------------------------------
// Input format tests (split-long array / Uint32Array H3 indexes)
// ---------------------------------------------------------------------------

test('isValidCell split-long array input', () => {
    for (const lib of [h3wasm, h3js]) {
        // Two-element integer arrays pass through as split longs (h3-js
        // semantics — no 32-bit range checks)
        assert.equal(lib.isValidCell([0x3fffffff, 0x8528347]), true, 'valid integer H3 index');
        assert.equal(lib.isValidCell([0x73fffffff, 0xff2834]), false, 'bad bits');
        // Anything that is not a two-element integer array or a hex string
        // parses to cell 0, which is itself invalid
        assert.equal(lib.isValidCell([]), false, 'empty array');
        assert.equal(lib.isValidCell([1]), false, 'single element');
        assert.equal(lib.isValidCell([1, 'a']), false, 'invalid element');
        assert.equal(lib.isValidCell([0x3fffffff, 0x8528347, 0]), false, 'extra element');
        assert.equal(lib.isValidCell('zzz'), false, 'non-hex string');
        // TypedArrays are not split longs in h3-js: they parse to cell 0
        // as well (h3-node does accept them — see the divergence test)
        assert.equal(
            lib.isValidCell(new Uint32Array([0x3fffffff, 0x8528347])),
            false,
            'Uint32Array parses to cell 0'
        );
        assert.equal(lib.isValidCell(new Uint32Array([])), false, 'Uint32Array empty');
    }
});

test('cellToLatLng split-long array input', () => {
    for (const lib of [h3wasm, h3js]) {
        // Two-element integer arrays are used as the split long
        assert.deepEqual(
            lib.cellToLatLng([0x3fffffff, 0x8528347]),
            lib.cellToLatLng('85283473fffffff'),
            'integer H3 index is considered an index'
        );
        assert.deepEqual(
            lib.cellToLatLng([0x73fffffff, 0xff2834]),
            lib.cellToLatLng('ff28343fffffff'),
            'integer with incorrect bits handled consistently'
        );
        // Everything else parses to cell 0 and returns its center —
        // h3-js never throws on unparseable index input
        for (const bad of [
            [],
            [1],
            [1, 'a'],
            [0x3fffffff, 0x8528347, 0],
            'zzz',
            null,
            new Uint32Array([]),
            new Uint32Array([1]),
            new Uint32Array([0x3fffffff, 0x8528347, 1]),
        ]) {
            const v = lib.cellToLatLng(bad);
            assert.ok(almostEqual(v, h3js.cellToLatLng(bad)), `cellToLatLng(${String(bad)}) -> cell 0 center`);
        }
    }
});

// ---------------------------------------------------------------------------
// Structure tests (GeoJSON shapes, round trips)
// ---------------------------------------------------------------------------

test('cellToBoundary geoJson mode', () => {
    const index = '8928342e20fffff';
    for (const lib of [h3wasm, h3js]) {
        const boundary = lib.cellToBoundary(index);
        const geo = lib.cellToBoundary(index, true);
        assert.equal(geo.length, boundary.length + 1, 'GeoJSON boundary closes the ring');
        assert.deepEqual(geo[0], [boundary[0][1], boundary[0][0]], 'GeoJSON uses [lng, lat]');
        assert.deepEqual(geo[geo.length - 1], geo[0], 'GeoJSON ring is closed');
    }
    assert.ok(
        almostEqual(h3wasm.cellToBoundary(index, true), h3js.cellToBoundary(index, true)),
        'wasm GeoJSON boundary matches h3-js'
    );
});

test('directedEdgeToBoundary geoJson mode', () => {
    const index = '8928342e20fffff';
    const destination = h3wasm.gridDisk(index, 1).find((c) => c !== index);
    const edge = h3wasm.cellsToDirectedEdge(index, destination);
    for (const lib of [h3wasm, h3js]) {
        const boundary = lib.directedEdgeToBoundary(edge);
        const geo = lib.directedEdgeToBoundary(edge, true);
        assert.equal(geo.length, boundary.length, 'edge boundary keeps vertex count');
        assert.deepEqual(
            geo.map(([lng, lat]) => [lat, lng]),
            boundary,
            'GeoJSON edge boundary uses [lng, lat]'
        );
    }
    assert.ok(
        almostEqual(
            h3wasm.directedEdgeToBoundary(edge, true),
            h3js.directedEdgeToBoundary(edge, true)
        ),
        'wasm GeoJSON edge boundary matches h3-js'
    );
});

test('cellsToMultiPolygon geoJson mode', () => {
    const index = '8928342e20fffff';
    const cells = h3wasm.gridDisk(index, 1);
    const mp = h3wasm.cellsToMultiPolygon(cells);
    const geo = h3wasm.cellsToMultiPolygon(cells, true);
    assert.ok(almostEqual(mp, h3js.cellsToMultiPolygon(cells)), 'default matches h3-js');
    assert.ok(
        almostEqual(geo, h3js.cellsToMultiPolygon(cells, true)),
        'GeoJSON matches h3-js'
    );
    assert.ok(
        geo.every((p) =>
            p.every(
                (ring) =>
                    ring.length > 1 &&
                    ring[0][0] === ring[ring.length - 1][0] &&
                    ring[0][1] === ring[ring.length - 1][1]
            )
        ),
        'GeoJSON rings are closed'
    );
    assert.ok(
        geo.every((p) =>
            p.every((ring) => ring.every(([lng, lat]) => Math.abs(lng) <= 180 && Math.abs(lat) <= 90))
        ),
        'GeoJSON coordinates are [lng, lat] in range'
    );
});

test('cellsToMultiPolygon round trip through polygonToCells', () => {
    const cell = h3wasm.latLngToCell(37.77, -122.43, 9);
    const cells = h3wasm.gridDisk(cell, 2);
    const defaultRing = h3wasm.cellsToMultiPolygon(cells)[0][0];
    const geoJsonRing = h3wasm.cellsToMultiPolygon(cells, true)[0][0];
    assert.deepEqual(
        [...h3wasm.polygonToCells(defaultRing, 9)].sort(),
        [...cells].sort(),
        'default output round-trips'
    );
    assert.deepEqual(
        [...h3wasm.polygonToCells(geoJsonRing, 9, true)].sort(),
        [...cells].sort(),
        'GeoJSON output round-trips'
    );
    assert.ok(
        almostEqual(h3wasm.cellsToMultiPolygon(cells), h3node.cellsToMultiPolygon(cells)),
        'wasm matches h3-node'
    );
    assert.ok(
        almostEqual(
            h3wasm.cellsToMultiPolygon(cells, true),
            h3node.cellsToMultiPolygon(cells, true)
        ),
        'wasm GeoJSON matches h3-node'
    );
});

test('constructCell round trip', () => {
    for (let i = 0; i < 10; i++) {
        const res = randInt(1, 15);
        const cell = h3wasm.latLngToCell(randLat(), randLng(), res);
        const base = h3wasm.getBaseCellNumber(cell);
        const digits = [];
        for (let d = 1; d <= res; d++) {
            digits.push(h3wasm.getIndexDigit(cell, d));
        }
        assert.equal(h3wasm.constructCell(base, digits, res), cell, 'reconstructs the cell');
        assert.equal(
            h3wasm.constructCell(base, digits, res),
            h3js.constructCell(base, digits, res),
            'matches h3-js'
        );
        assert.equal(h3wasm.constructCell(base, digits), cell, 'infers res from digits length');
        assert.equal(
            h3wasm.constructCell(base, digits),
            h3node.constructCell(base, digits),
            'matches h3-node'
        );
    }
});

test('empty inputs return empty arrays', () => {
    assert.deepEqual(h3wasm.polygonToCells([], 6), []);
    assert.deepEqual(h3js.polygonToCells([], 6), []);
    assert.deepEqual(h3wasm.cellsToMultiPolygon([]), []);
    assert.deepEqual(h3js.cellsToMultiPolygon([]), []);
    assert.deepEqual(h3wasm.compactCells([]), []);
    assert.deepEqual(h3js.compactCells([]), []);
    assert.deepEqual(h3wasm.uncompactCells([], 9), []);
    assert.deepEqual(h3js.uncompactCells([], 9), []);
});

test('gridRing k=0 returns the origin', () => {
    const cell = '892830828a3ffff';
    for (const lib of [h3wasm, h3js, h3node]) {
        assert.deepEqual(lib.gridRing(cell, 0), [cell]);
    }
});

test('isValidVertex / isValidIndex reject unparseable input', () => {
    for (const lib of [h3wasm, h3js, h3node]) {
        assert.equal(lib.isValidVertex('zzzzzzzzzzzzzzzz'), false, 'non-hex string');
        assert.equal(lib.isValidVertex([]), false, 'empty array');
        assert.equal(lib.isValidVertex(12345), false, 'bare number');
        assert.equal(lib.isValidIndex('zzzzzzzzzzzzzzzz'), false, 'non-hex string');
        assert.equal(lib.isValidIndex([]), false, 'empty array');
        assert.equal(lib.isValidIndex(12345), false, 'bare number');
    }
});

test('h3IndexToSplitLong / splitLongToH3Index', () => {
    for (const lib of [h3wasm, h3js, h3node]) {
        assert.deepEqual(lib.h3IndexToSplitLong('zzzzzzzzzzzzzzzz'), [0, 0], 'non-hex string');
        assert.deepEqual(lib.h3IndexToSplitLong(12345), [0, 0], 'bare number');
        assert.deepEqual(lib.h3IndexToSplitLong([1, 2]), [1, 2], 'split longs pass through');
        // h3-js semantics: no 32-bit range checks on array input...
        assert.deepEqual(lib.h3IndexToSplitLong([2 ** 32, 0]), [2 ** 32, 0], 'no lo range check');
        assert.deepEqual(
            lib.h3IndexToSplitLong([0x3fffffff, 0x100000000]),
            [0x3fffffff, 0x100000000],
            'no hi range check'
        );
        // ...or on hex strings (a 16-char string is split as-is)
        assert.deepEqual(
            lib.h3IndexToSplitLong('ffffffffffffffff'),
            [0xffffffff, 0xffffffff],
            'full 64-bit hex string'
        );
    }
    const cell = '892830828a3ffff';
    const [lo, hi] = h3wasm.h3IndexToSplitLong(cell);
    assert.equal(h3wasm.splitLongToH3Index(lo, hi), cell, 'round trip');
});

// ---------------------------------------------------------------------------
// Error path tests (deterministic; wasm and h3-js must report the same
// H3Error code; h3-node must throw, though it encodes codes differently)
// ---------------------------------------------------------------------------

function expectThrow(lib, name, args) {
    try {
        lib[name](...args);
    } catch (e) {
        return e;
    }
    assert.fail(`${name}(${JSON.stringify(args)}) did not throw`);
}

test('error codes match h3-js', () => {
    const cell = '892830828a3ffff';
    const parent8 = h3wasm.cellToParent(cell, 8);
    const disk2 = h3wasm.gridDisk(cell, 2);
    const far = disk2[disk2.length - 1];
    const cases = [
        // [name, args, expected code]
        ['latLngToCell', [NaN, 0, 9], 3], // E_LATLNG_DOMAIN
        ['latLngToCell', [0, 0, 16], 4], // E_RES_DOMAIN
        ['cellToParent', [cell, 16], 4], // E_RES_DOMAIN
        ['getHexagonAreaAvg', [16, 'm2'], 4], // E_RES_DOMAIN
        ['cellToChildrenSize', ['zzz', 10], 5], // E_CELL_INVALID
        ['compactCells', [['992830828a3ffff']], 5], // E_CELL_INVALID (reserved bits set)
        ['cellsToDirectedEdge', [cell, far], 11], // E_NOT_NEIGHBORS
        ['gridDistance', [cell, parent8], 12], // E_RES_MISMATCH
        ['constructCell', [191, [1, 2, 3], 2], 18], // E_DIGIT_DOMAIN (length != res)
        ['constructCell', [191, new Array(16).fill(1), 16], 18], // E_DIGIT_DOMAIN (> 15 digits)
        ['gridDisk', [cell, -1], 2], // E_DOMAIN
        ['cellToVertex', [cell, 7], 2], // E_DOMAIN
        ['cellArea', [cell, 'miles'], 1000], // E_UNKNOWN_UNIT
        ['edgeLength', [cell + '8', 'miles'], 1000], // E_UNKNOWN_UNIT
        ['polygonToCellsExperimental', [SF_RING, 6, 'bogus'], 15], // E_OPTION_INVALID
    ];
    for (const [name, args, code] of cases) {
        const we = expectThrow(h3wasm, name, args);
        const je = expectThrow(h3js, name, args);
        assert.equal(we.code, code, `wasm ${name} error code`);
        assert.equal(je.code, code, `h3-js ${name} error code`);
        expectThrow(h3node, name, args); // h3-node throws too (own code encoding)
    }

    // Unit errors where h3-node 4.5.3 does NOT throw: it parses units by
    // prefix (unit[0] == 'm' ⇒ meters), so 'm2' and 'miles' are silently
    // treated as meters. wasm/h3-js reject them with E_UNKNOWN_UNIT. The
    // greatCircleDistance case is pinned in the dedicated divergence test.
    assert.equal(
        expectThrow(h3wasm, 'getHexagonEdgeLengthAvg', [9, 'm2']).code,
        1000,
        'wasm E_UNKNOWN_UNIT'
    );
    assert.equal(
        expectThrow(h3js, 'getHexagonEdgeLengthAvg', [9, 'm2']).code,
        1000,
        'h3-js E_UNKNOWN_UNIT'
    );
    assert.ok(
        almostEqual(
            h3node.getHexagonEdgeLengthAvg(9, 'm2'),
            h3node.getHexagonEdgeLengthAvg(9, 'm')
        ),
        'h3-node treats "m2" as meters'
    );
    assert.equal(
        expectThrow(h3wasm, 'greatCircleDistance', [[0, 0], [1, 1], 'miles']).code,
        1000,
        'wasm E_UNKNOWN_UNIT'
    );
    assert.equal(
        expectThrow(h3js, 'greatCircleDistance', [[0, 0], [1, 1], 'miles']).code,
        1000,
        'h3-js E_UNKNOWN_UNIT'
    );
});

test('localIjToCell validates coords object', () => {
    const origin = '892830828a3ffff';
    const we = expectThrow(h3wasm, 'localIjToCell', [origin, 'nope']);
    const je = expectThrow(h3js, 'localIjToCell', [origin, 'nope']);
    assert.equal(we.message, 'Coordinates must be provided as an {i, j} object');
    assert.equal(je.message, 'Coordinates must be provided as an {i, j} object');
    assert.equal(we.code, undefined, 'plain Error, no code');
    assert.equal(je.code, undefined, 'plain Error, no code');
    const ne = expectThrow(h3node, 'localIjToCell', [origin, 'nope']);
    assert.equal(ne.code, 'EINVAL', 'h3-node reports EINVAL');
});

// ---------------------------------------------------------------------------
// Documented divergences: h3-js (and wasm) follow the h3-js reference
// behavior; h3-node intentionally differs. These tests pin both sides.
// ---------------------------------------------------------------------------

test('divergence: malformed index strings (sentinels vs throws)', () => {
    // h3-js/wasm parse non-hex strings to cell 0 and let the C library
    // decide; h3-node rejects them as caller errors.
    assert.equal(h3wasm.getResolution('zzz'), -1);
    assert.equal(h3js.getResolution('zzz'), -1);
    expectThrow(h3node, 'getResolution', ['zzz']);

    assert.equal(h3wasm.getBaseCellNumber('zzz'), 0);
    assert.equal(h3js.getBaseCellNumber('zzz'), 0);
    expectThrow(h3node, 'getBaseCellNumber', ['zzz']);

    // cellToLatLng of cell 0: cell-0 center (libm differs ~1e-13)
    assert.ok(almostEqual(h3wasm.cellToLatLng('zzz'), h3js.cellToLatLng('zzz')));
    expectThrow(h3node, 'cellToLatLng', ['zzz']);

    assert.deepEqual(h3wasm.gridDisk('zzz', 1), []);
    assert.deepEqual(h3js.gridDisk('zzz', 1), []);
    expectThrow(h3node, 'gridDisk', ['zzz', 1]);

    assert.deepEqual(h3wasm.compactCells(['zzz']), []);
    assert.deepEqual(h3js.compactCells(['zzz']), []);
    expectThrow(h3node, 'compactCells', [['zzz']]);

    assert.equal(h3wasm.isPentagon('zzz'), false);
    assert.equal(h3js.isPentagon('zzz'), false);
    expectThrow(h3node, 'isPentagon', ['zzz']);

    // isValid* never throws in any of the three
    assert.equal(h3wasm.isValidCell('zzz'), false);
    assert.equal(h3js.isValidCell('zzz'), false);
    assert.equal(h3node.isValidCell('zzz'), false);

    // null / bare numbers behave the same way (parse to cell 0)
    assert.ok(almostEqual(h3wasm.cellToLatLng(null), h3js.cellToLatLng(null)));
    expectThrow(h3node, 'cellToLatLng', [null]);
    assert.equal(h3wasm.getResolution(0), -1);
    assert.equal(h3js.getResolution(0), -1);
    expectThrow(h3node, 'getResolution', [0]);
});

test('divergence: greatCircleDistance unknown unit', () => {
    const we = expectThrow(h3wasm, 'greatCircleDistance', [[0, 0], [1, 1], 'miles']);
    const je = expectThrow(h3js, 'greatCircleDistance', [[0, 0], [1, 1], 'miles']);
    assert.equal(we.code, 1000, 'wasm E_UNKNOWN_UNIT');
    assert.equal(je.code, 1000, 'h3-js E_UNKNOWN_UNIT');
    // h3-node treats any unknown non-empty string unit as meters
    const nodeMiles = h3node.greatCircleDistance([0, 0], [1, 1], 'miles');
    assert.equal(nodeMiles, h3node.greatCircleDistance([0, 0], [1, 1], 'm'));
    assert.ok(
        almostEqual(nodeMiles, h3wasm.greatCircleDistance([0, 0], [1, 1], 'm')),
        'node "miles" == wasm meters'
    );
    // h3-node throws EINVAL for empty / non-string units
    assert.equal(
        expectThrow(h3node, 'greatCircleDistance', [[0, 0], [1, 1], '']).code,
        'EINVAL'
    );
    assert.equal(
        expectThrow(h3node, 'greatCircleDistance', [[0, 0], [1, 1], 5]).code,
        'EINVAL'
    );
});

test('divergence: polygonToCellsExperimental invalid flag', () => {
    const we = expectThrow(h3wasm, 'polygonToCellsExperimental', [SF_RING, 6, 'bogus']);
    const je = expectThrow(h3js, 'polygonToCellsExperimental', [SF_RING, 6, 'bogus']);
    assert.equal(we.code, 15, 'wasm E_OPTION_INVALID');
    assert.equal(je.code, 15, 'h3-js E_OPTION_INVALID');
    assert.equal(
        expectThrow(h3node, 'polygonToCellsExperimental', [SF_RING, 6, 'bogus']).code,
        'EINVAL',
        'h3-node reports EINVAL'
    );
});

test('divergence: cellToChildrenSize vs cellToChildren on invalid cell', () => {
    // h3-js/wasm: cellToChildren returns [] for an invalid cell, while
    // cellToChildrenSize throws E_CELL_INVALID. h3-node throws in both.
    assert.deepEqual(h3wasm.cellToChildren('zzz', 10), []);
    assert.deepEqual(h3js.cellToChildren('zzz', 10), []);
    assert.equal(
        expectThrow(h3wasm, 'cellToChildrenSize', ['zzz', 10]).code,
        5
    );
    assert.equal(expectThrow(h3js, 'cellToChildrenSize', ['zzz', 10]).code, 5);
    expectThrow(h3node, 'cellToChildren', ['zzz', 10]);
    expectThrow(h3node, 'cellToChildrenSize', ['zzz', 10]);
});

test('divergence: h3-node accepts Uint32Array split longs', () => {
    // h3-node's N-API argument parsing accepts a two-element Uint32Array
    // as a split long wherever an H3 index is expected; h3-js (and wasm)
    // only accept plain two-element integer arrays — anything else parses
    // to cell 0.
    const ta = new Uint32Array([0x3fffffff, 0x8528347]);
    const cell = '85283473fffffff';
    assert.equal(h3node.isValidCell(ta), true, 'h3-node accepts typed-array indexes');
    assert.equal(h3wasm.isValidCell(ta), false, 'wasm follows h3-js');
    assert.equal(h3js.isValidCell(ta), false, 'h3-js parses to cell 0');
    assert.ok(
        almostEqual(h3node.cellToLatLng(ta), h3node.cellToLatLng(cell)),
        'h3-node typed-array == string'
    );
    assert.ok(
        almostEqual(h3wasm.cellToLatLng(ta), h3js.cellToLatLng(ta)),
        'wasm and h3-js both parse the typed array to cell 0'
    );
});

test('divergence: h3-node 4.5.3 getIcosahedronFaces leaves array holes', () => {
    // The h3-node 4.5.3 prebuild sizes the result to maxFaceCount and
    // skips unused slots, leaving holes (e.g. [7, <hole>] for a hexagon
    // on one face); fixed upstream after v4.5.3 (variable array + dense
    // packing). wasm/h3-js return a dense array.
    const cell = '8928342e20fffff'; // hexagon on a single icosahedron face
    assert.deepEqual(h3wasm.getIcosahedronFaces(cell), [7]);
    assert.deepEqual(h3js.getIcosahedronFaces(cell), [7]);
    const n = h3node.getIcosahedronFaces(cell);
    assert.deepEqual(n.filter((x) => x != null), [7], 'h3-node faces, dense view');
    assert.equal(n.length, 2, 'h3-node array sized to maxFaceCount');
    assert.equal('1' in n, false, 'unused slot is a hole');
});

// ---------------------------------------------------------------------------
// Benchmarks: 3-way, results written to build/benchmark.txt
// ---------------------------------------------------------------------------

const BENCH_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'benchmark.txt');
const LIGHT_ITERS = 1000;
const HEAVY_ITERS = 500;

const benchmarkCases = [
    ['latLngToCell', 'latLngToCell', () => [randLat(), randLng(), 9], LIGHT_ITERS],
    ['cellToLatLng', 'cellToLatLng', () => [randomCell(9)], LIGHT_ITERS],
    ['cellToBoundary', 'cellToBoundary', () => [randomCell(9)], LIGHT_ITERS],
    ['cellToBoundaryGeoJson', 'cellToBoundary', () => [randomCell(9), true], LIGHT_ITERS],
    ['getResolution', 'getResolution', () => [randomCell(randInt(0, 15))], LIGHT_ITERS],
    ['getBaseCellNumber', 'getBaseCellNumber', () => [randomCell(9)], LIGHT_ITERS],
    ['isValidCell', 'isValidCell', () => [rand() < 0.5 ? randomCell(9) : 'zzz'], LIGHT_ITERS],
    ['isResClassIII', 'isResClassIII', () => [randomCell(randInt(0, 15))], LIGHT_ITERS],
    ['isPentagon', 'isPentagon', () => [randomCell(randInt(0, 15))], LIGHT_ITERS],
    ['getIcosahedronFaces', 'getIcosahedronFaces', () => [randomCell(randInt(0, 2))], LIGHT_ITERS],
    ['gridDisk', 'gridDisk', () => [randomCell(randInt(0, 15)), randInt(1, 10)], HEAVY_ITERS],
    ['gridDiskDistances', 'gridDiskDistances', () => [randomCell(randInt(0, 15)), randInt(1, 5)], HEAVY_ITERS],
    ['gridRingUnsafe', 'gridRingUnsafe', () => [randomCell(randInt(0, 15)), randInt(1, 4)], LIGHT_ITERS],
    [
        'gridDistance',
        'gridDistance',
        () => {
            const o = randomCell(randInt(0, 15));
            return [o, pick(h3wasm.gridDisk(o, 3))];
        },
        LIGHT_ITERS,
    ],
    [
        'cellToLocalIj',
        'cellToLocalIj',
        () => {
            const o = randomCell(9);
            return [o, pick(h3wasm.gridDisk(o, 2))];
        },
        LIGHT_ITERS,
    ],
    [
        'localIjToCell',
        'localIjToCell',
        () => [randomCell(randInt(0, 15)), { i: randInt(-3, 3), j: randInt(-3, 3) }],
        LIGHT_ITERS,
    ],
    [
        'gridPathCells',
        'gridPathCells',
        () => {
            const o = randomCell(9);
            return [o, pick(h3wasm.gridDisk(o, 2))];
        },
        HEAVY_ITERS,
    ],
    ['cellToParent', 'cellToParent', () => [randomCell(9), randInt(0, 8)], LIGHT_ITERS],
    ['cellToChildren', 'cellToChildren', () => [randomCell(9), randInt(10, 12)], HEAVY_ITERS],
    [
        'cellToChildrenSize',
        'cellToChildrenSize',
        () => [randomCell(randInt(0, 12)), randInt(13, 15)],
        LIGHT_ITERS,
    ],
    ['cellToCenterChild', 'cellToCenterChild', () => [randomCell(9), randInt(10, 12)], LIGHT_ITERS],
    [
        'compactCells',
        'compactCells',
        () => [h3wasm.gridDisk(randomCell(9), 6)],
        LIGHT_ITERS,
    ],
    [
        'uncompactCells',
        'uncompactCells',
        () => [h3wasm.compactCells(h3wasm.gridDisk(randomCell(9), 6)), 9],
        HEAVY_ITERS,
    ],
    ['polygonToCells', 'polygonToCells', () => [SF_RING, 6], HEAVY_ITERS],
    ['polygonToCellsWithHoles', 'polygonToCells', () => [SF_POLY, 6], HEAVY_ITERS],
    [
        'polygonToCellsExperimental',
        'polygonToCellsExperimental',
        () => [SF_RING, 6, 'containmentFull'],
        HEAVY_ITERS,
    ],
    [
        'cellsToMultiPolygon',
        'cellsToMultiPolygon',
        () => [h3wasm.gridDisk(randomCell(9), 3)],
        HEAVY_ITERS,
    ],
    [
        'cellsToMultiPolygonGeoJson',
        'cellsToMultiPolygon',
        () => [h3wasm.gridDisk(randomCell(9), 3), true],
        HEAVY_ITERS,
    ],
    [
        'areNeighborCells',
        'areNeighborCells',
        () => {
            const o = randomCell(9);
            return [o, pick(h3wasm.gridDisk(o, 1))];
        },
        LIGHT_ITERS,
    ],
    [
        'cellsToDirectedEdge',
        'cellsToDirectedEdge',
        () => {
            const o = randomCell(9);
            return [o, pick(h3wasm.gridDisk(o, 1).filter((c) => c !== o))];
        },
        LIGHT_ITERS,
    ],
    ['getDirectedEdgeOrigin', 'getDirectedEdgeOrigin', () => [randomEdge()], LIGHT_ITERS],
    ['getDirectedEdgeDestination', 'getDirectedEdgeDestination', () => [randomEdge()], LIGHT_ITERS],
    ['directedEdgeToCells', 'directedEdgeToCells', () => [randomEdge()], LIGHT_ITERS],
    ['originToDirectedEdges', 'originToDirectedEdges', () => [randomCell(9)], LIGHT_ITERS],
    ['directedEdgeToBoundary', 'directedEdgeToBoundary', () => [randomEdge()], LIGHT_ITERS],
    ['reverseDirectedEdge', 'reverseDirectedEdge', () => [randomEdge()], LIGHT_ITERS],
    ['degsToRads', 'degsToRads', () => [randInt(-180, 180)], LIGHT_ITERS],
    ['radsToDegs', 'radsToDegs', () => [rand() * 2 * Math.PI], LIGHT_ITERS],
    ['getNumCells', 'getNumCells', () => [randInt(0, 15)], LIGHT_ITERS],
    [
        'getHexagonEdgeLengthAvg',
        'getHexagonEdgeLengthAvg',
        () => [randInt(0, 15), rand() < 0.5 ? 'm' : 'km'],
        LIGHT_ITERS,
    ],
    ['edgeLength', 'edgeLength', () => [randomEdge(), pick(['m', 'km', 'rads'])], LIGHT_ITERS],
    [
        'getHexagonAreaAvg',
        'getHexagonAreaAvg',
        () => [randInt(0, 15), rand() < 0.5 ? 'm2' : 'km2'],
        LIGHT_ITERS,
    ],
    [
        'cellArea',
        'cellArea',
        () => [randomCell(randInt(0, 15)), pick(['m2', 'km2', 'rads2'])],
        LIGHT_ITERS,
    ],
    [
        'greatCircleDistance',
        'greatCircleDistance',
        () => [[randLat(), randLng()], [randLat(), randLng()], pick(['m', 'km', 'rads'])],
        LIGHT_ITERS,
    ],
    ['getRes0Cells', 'getRes0Cells', () => [], LIGHT_ITERS],
    ['getPentagons', 'getPentagons', () => [randInt(0, 15)], LIGHT_ITERS],
    ['cellToVertex', 'cellToVertex', () => [randomCell(9), randInt(0, 5)], LIGHT_ITERS],
    ['cellToVertexes', 'cellToVertexes', () => [randomCell(9)], LIGHT_ITERS],
    [
        'vertexToLatLng',
        'vertexToLatLng',
        () => [h3wasm.cellToVertex(randomCell(9), randInt(0, 5))],
        LIGHT_ITERS,
    ],
    ['h3IndexToSplitLong', 'h3IndexToSplitLong', () => [randomCell(9)], LIGHT_ITERS],
    ['splitLongToH3Index', 'splitLongToH3Index', () => h3wasm.h3IndexToSplitLong(randomCell(9)), LIGHT_ITERS],
    [
        'constructCell',
        'constructCell',
        () => {
            const c = randomCell(9);
            const digits = [];
            for (let d = 1; d <= 9; d++) {
                digits.push(h3wasm.getIndexDigit(c, d));
            }
            return [h3wasm.getBaseCellNumber(c), digits];
        },
        LIGHT_ITERS,
    ],
];

test('benchmarks (3-way) -> build/benchmark.txt', { timeout: 600000 }, () => {
    const lines = [];
    lines.push('# h3-wasm 3-way benchmark');
    lines.push(`# node ${process.version} on ${process.platform}/${process.arch}`);
    lines.push(`# light=${LIGHT_ITERS} iters, heavy=${HEAVY_ITERS} iters, 25-iter warmup per case`);
    lines.push('');

    for (const [label, fnName, genArgs, iters] of benchmarkCases) {
        const runs = [];
        for (let i = 0; i < iters; i++) {
            runs.push(genArgs());
        }
        const times = {};
        for (const [libName, lib] of [
            ['h3-wasm', h3wasm],
            ['h3-js', h3js],
            ['h3-node', h3node],
        ]) {
            for (let i = 0; i < 25; i++) {
                try {
                    lib[fnName](...runs[i]);
                } catch {}
            }
            const start = process.hrtime.bigint();
            for (let i = 0; i < iters; i++) {
                try {
                    lib[fnName](...runs[i]);
                } catch {}
            }
            times[libName] = Number(process.hrtime.bigint() - start);
        }
        const fastest = Math.min(times['h3-wasm'], times['h3-js'], times['h3-node']);
        lines.push(`${label} (${iters} iters):`);
        for (const [libName] of [['h3-wasm'], ['h3-js'], ['h3-node']]) {
            const ns = times[libName];
            const ratio = (ns / fastest).toFixed(2);
            lines.push(
                `  ${libName.padEnd(8)} ${String(ns).padStart(12)} ns total  ${String((
                    ns / iters
                ).toFixed(1)).padStart(10)} ns/call  ${ratio}x fastest`
            );
        }
        lines.push('');
    }

    mkdirSync(dirname(BENCH_PATH), { recursive: true });
    writeFileSync(BENCH_PATH, lines.join('\n'));
    console.log(lines.join('\n'));
});
