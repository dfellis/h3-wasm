const std = @import("std");
const h3 = @cImport({
    @cInclude("h3api.h");
});

// TODO: Why aren't these implemented by the musl bindings? At least confirmed these exactly match
// the "real" math.h implementations.
export fn lroundl(x: c_longdouble) c_long {
    return @intFromFloat(@round(x));
}

export fn asin(x: f64) f64 {
    return std.math.asin(x);
}

export fn acos(x: f64) f64 {
    return std.math.acos(x);
}

export fn atan(x: f64) f64 {
    return std.math.atan(x);
}

export fn atan2(y: f64, x: f64) f64 {
    return std.math.atan2(f64, y, x);
}

// Only h3ToString uses sprintf, which for some reason is not included in the WASM musl libc, so
// instead just re-implementing h3ToString with a non-exported variant as it's a lot easier
fn h3ToString(cell: h3.H3Index, mem: *[17]u8) void {
    _ = std.fmt.bufPrint(mem, "{x}", .{cell}) catch 0;
}

// Similarly, only stringToH3 uses sscanf so just reimplementing it. Not sure why these functions
// aren't being properly defined, though. :/
fn stringToH3(cellStr: [*]u8) !h3.H3Index {
    return std.fmt.parseInt(u64, cellStr[0..15], 16);
}

// Binding API. Basic JSON object manipulation using handle-like ID mechanism. All binding functions
// return an ID they acquire from this API with the actual value(s) attached to it. The supported
// values to associate with an ID are int32s, strings, booleans, and JS Arrays, Objects, and Errors.
// The JS array and object types can have any of the other types (excluding errors) attached to them
// with complex nesting such as objects inside of arrays done by constructing all of the objects and
// then adding the object by ID to the array. You can only add elements to the array in order and
// you can only add new key-value pairs to the objects, so don't mess up! ;) You can read int32s and
// strings only

// Root object creation. Returns the handle ID.
extern fn makeArr() u32;
extern fn makeObj() u32;
extern fn makeErr(u32) u32;
extern fn makeInt32(i32) u32;
extern fn makeStr([*]u8) u32;
extern fn makeBool(c_int) u32;
// Root object reads. Returns pointer to desired data. Only ints and strings for now.
extern fn getInt32(u32) *i32;
extern fn getDouble(u32) *f64;
extern fn getStr(u32) [*c]u8;
// Array manipulation. Takes the handle ID and the value to append to the array.
extern fn appendInt32(u32, i32) void;
extern fn appendDouble(u32, f64) void;
extern fn appendStr(u32, [*]u8) void;
extern fn appendBool(u32, c_int) void;
extern fn appendObj(u32, u32) void;
// Object manipulation. Takes the handle ID, the key string, and the value to add to the object.
extern fn addInt32(u32, [*]u8, i32) void;
extern fn addDouble(u32, [*]u8, f64) void;
extern fn addStr(u32, [*]u8, [*]u8) void;
extern fn addBool(u32, [*]u8, c_int) void;
extern fn addObj(u32, [*]u8, u32) void;
// Debugging tool
extern fn consoleLog([*]const u8) void;

// Memory management functions to provide to JS side
export fn alloc(size: usize) [*]u8 {
    const allocator = std.heap.page_allocator;
    const dummy: [1]u8 = .{0};

    const memory = allocator.alloc(u8, size) catch &dummy;
    return @ptrCast(@constCast(memory));
}

// Zig generics are wonky, so not trying until I better understand them
export fn freef64(ptr: *f64) void {
    const i: usize = @intFromPtr(ptr);
    const p: [*]u8 = @ptrFromInt(i);
    const slice = p[0..8];
    const allocator = std.heap.page_allocator;
    allocator.free(slice);
}

export fn freei32(ptr: *i32) void {
    const i: usize = @intFromPtr(ptr);
    const p: [*]u8 = @ptrFromInt(i);
    const slice = p[0..4];
    const allocator = std.heap.page_allocator;
    allocator.free(slice);
}

export fn freestr(ptr: [*]u8, size: usize) void {
    const allocator = std.heap.page_allocator;
    const slice = ptr[0..size];
    allocator.free(slice);
}

// Actual binding functions, prefixed with `bind__` to prevent collisions with the C functions with
// the same name.

export fn bind__helloWorld() u32 {
    return makeStr(@constCast("Hello, World!"));
}

export fn bind__greet() u32 {
    const allocator = std.heap.page_allocator;
    const name = getStr(0);
    const len = std.mem.len(name);
    var dummy: [1]u8 = .{0};
    var out = allocator.alloc(u8, len + 9) catch &dummy;
    _ = std.fmt.bufPrint(out, "Hello, {s}!", .{name}) catch &dummy;
    return makeStr(out.ptr);
}

///////////////////////////////////////////////////////////////////////////////
// Indexing Functions                                                        //
///////////////////////////////////////////////////////////////////////////////

export fn bind__latLngToCell() u32 {
    const lat = getDouble(0);
    defer freef64(lat);
    const lng = getDouble(1);
    defer freef64(lng);
    const res = getInt32(2);
    defer freei32(res);
    var cell: u64 = 0;
    const latLng = h3.LatLng{ .lat = h3.degsToRads(lat.*), .lng = h3.degsToRads(lng.*) };
    const err = h3.latLngToCell(&latLng, res.*, &cell);
    if (err > 0) {
        return makeErr(err);
    }
    var cellStr = std.mem.zeroes([17]u8);
    h3ToString(cell, &cellStr);
    return makeStr(&cellStr);
}

export fn bind__cellToLatLng() u32 {
    const cellStr = getStr(0);
    defer freestr(cellStr, 16);
    const cell = stringToH3(cellStr) catch 0;
    if (cell == 0) {
        return makeErr(1);
    }
    var latLng = h3.LatLng{ .lat = 0, .lng = 0 };
    const err = h3.cellToLatLng(cell, &latLng);
    if (err > 0) {
        return makeErr(err);
    }
    const out = makeArr();
    appendDouble(out, h3.radsToDegs(latLng.lat));
    appendDouble(out, h3.radsToDegs(latLng.lng));
    return out;
}

export fn bind__cellToBoundary() u32 {
    const cellStr = getStr(0);
    defer freestr(cellStr, 16);
    const cell = stringToH3(cellStr) catch 0;
    if (cell == 0) {
        return makeErr(1);
    }

    var cellBoundary = std.mem.zeroes(h3.CellBoundary);
    const err = h3.cellToBoundary(cell, &cellBoundary);
    if (err > 0) {
        return makeErr(err);
    }
    const out = makeArr();
    // Zig, you're just making this more awkward...
    var i: usize = 0;
    while (i < cellBoundary.numVerts) {
        const latLng = makeArr();
        appendDouble(latLng, h3.radsToDegs(cellBoundary.verts[i].lat));
        appendDouble(latLng, h3.radsToDegs(cellBoundary.verts[i].lng));
        appendObj(out, latLng);
        i += 1;
    }
    return out;
}

///////////////////////////////////////////////////////////////////////////////
// Inspection Functions                                                      //
///////////////////////////////////////////////////////////////////////////////

export fn bind__getResolution() u32 {
    const cellStr = getStr(0);
    defer freestr(cellStr, 16);
    const cell = stringToH3(cellStr) catch 0;
    if (cell == 0) {
        return makeErr(1);
    }

    return makeInt32(h3.getResolution(cell));
}

export fn bind__isValidCell() u32 {
    // TODO: Add the array and typed array support
    const cellStr = getStr(0);
    defer freestr(cellStr, 16);
    const cell = stringToH3(cellStr) catch 0;
    if (cell == 0) {
        return makeErr(1);
    }

    return makeBool(h3.isValidCell(cell));
}

export fn bind__isResClassIII() u32 {
    const cellStr = getStr(0);
    defer freestr(cellStr, 16);
    const cell = stringToH3(cellStr) catch 0;
    if (cell == 0) {
        return makeErr(1);
    }

    return makeBool(h3.isResClassIII(cell));
}

export fn bind__isPentagon() u32 {
    const cellStr = getStr(0);
    defer freestr(cellStr, 16);
    const cell = stringToH3(cellStr) catch 0;
    if (cell == 0) {
        return makeErr(1);
    }

    return makeBool(h3.isPentagon(cell));
}

export fn bind__getIcosahedronFaces() u32 {
    const cellStr = getStr(0);
    defer freestr(cellStr, 16);
    const cell = stringToH3(cellStr) catch 0;
    if (cell == 0) {
        return makeErr(1);
    }

    // I know I'm supposed to use `maxFaceCount`, but it's always going to be <= 5, so I'm just
    // statically allocating at that maximum
    var faces = [5]i32{ -1, -1, -1, -1, -1 };

    const err = h3.getIcosahedronFaces(cell, &faces);
    if (err > 0) {
        return makeErr(err);
    }
    const out = makeArr();
    var i: u8 = 0;
    while (i < 5) {
        if (faces[i] >= 0) {
            appendInt32(out, faces[i]);
        }
        i += 1;
    }
    return out;
}
