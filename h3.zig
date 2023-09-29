const std = @import("std");
const print = @import("std").debug.print;

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
extern fn makeErr(i32) u32;
extern fn makeInt32(i32) u32;
extern fn makeStr([*]u8) u32;
extern fn makeBool(u8) u32;
// Root object reads. Returns pointer to desired data. Only ints and strings for now.
extern fn getInt32(u32) *i32;
extern fn getStr(u32) [*c]u8;
// Array manipulation. Takes the handle ID and the value to append to the array.
extern fn appendInt32(u32, i32) void;
extern fn appendStr(u32, [*]u8) void;
extern fn appendBool(u32, u8) void;
extern fn appendObj(u32, u32) void;
// Object manipulation. Takes the handle ID, the key string, and the value to add to the object.
extern fn addInt32(u32, [*]u8, i32) void;
extern fn addStr(u32, [*]u8, [*]u8) void;
extern fn addBool(u32, [*]u8, u8) void;
extern fn addObj(u32, [*]u8, u32) void;

// Memory management functions to provide to JS side
export fn malloc(size: usize) [*]u8 {
    const allocator = std.heap.page_allocator;
    const dummy: [1]u8 = .{0};

    const memory = allocator.alloc(u8, size) catch &dummy;
    return @ptrCast(@constCast(memory));
}

export fn free(ptr: [*]u8, size: usize) void {
    const allocator = std.heap.page_allocator;
    const slice = ptr[0..size];
    allocator.free(slice);
}

export fn helloWorld() u32 {
    return makeStr(@constCast("Hello, World!"));
}

export fn greet() u32 {
    const allocator = std.heap.page_allocator;
    const name = getStr(0);
    const len = std.mem.len(name);
    var dummy: [1]u8 = .{0};
    var out = allocator.alloc(u8, len + 9) catch &dummy;
    _ = std.fmt.bufPrint(out, "Hello, {s}!", .{name}) catch &dummy;
    return makeStr(out.ptr);
}
