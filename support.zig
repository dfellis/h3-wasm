//! libc substitutes for the wasm32-freestanding h3 build (non-variadic part).
//! All functions are exported under plain C names so the compiled C code
//! from h3 resolves them at link time. The variadic printf family lives in
//! cvar.c so the varargs ABI is handled entirely by LLVM's C frontend.
//!
//! Note: wasm32-freestanding has no `callconv(.C)`; the default `export`
//! calling convention is the wasm ABI, which is what zig cc's C code uses.
const std = @import("std");

// ---------------------------------------------------------------------------
// Memory allocation
// ---------------------------------------------------------------------------

/// Tracks the size of every live allocation so realloc can copy correctly.
const UsizeHash = struct {
    pub fn hash(_: @This(), key: usize) u64 {
        var h: u64 = key;
        h ^= h >> 33;
        h *= 0xff51afd7ed558ccd;
        h ^= h >> 29;
        h *= 0xc4ceb9fe1a85ec53;
        h ^= h >> 32;
        return h;
    }
    pub fn eql(_: @This(), a: usize, b: usize) bool {
        return a == b;
    }
};
const AllocMap = std.HashMapUnmanaged(usize, usize, UsizeHash, 4);
var alloc_map: AllocMap = .empty;
const hash_ctx = UsizeHash{};

fn track(ptr: usize, size: usize) void {
    // Duplicates are impossible: free() removes entries and the page
    // allocator only hands out unique addresses for live allocations.
    _ = alloc_map.putContext(std.heap.page_allocator, ptr, size, hash_ctx) catch {};
}

export fn malloc(size: usize) ?*anyopaque {
    const n = if (size == 0) 1 else size;
    const mem = std.heap.page_allocator.alloc(u8, n) catch return null;
    track(@intFromPtr(mem.ptr), n);
    return @ptrCast(mem.ptr);
}

export fn calloc(count: usize, size: usize) ?*anyopaque {
    const n = count * size;
    const mem = std.heap.page_allocator.alloc(u8, if (n == 0) 1 else n) catch return null;
    @memset(mem, 0);
    track(@intFromPtr(mem.ptr), if (n == 0) 1 else n);
    return @ptrCast(mem.ptr);
}

export fn realloc(ptr: ?*anyopaque, size: usize) ?*anyopaque {
    const n = if (size == 0) 1 else size;
    if (ptr == null) return malloc(n);
    const p = ptr.?;
    const old_size = alloc_map.getContext(@intFromPtr(p), hash_ctx) orelse 1;
    const mem = std.heap.page_allocator.alloc(u8, n) catch return null;
    const copy = @min(old_size, n);
    @memcpy(mem[0..copy], @as([*]const u8, @ptrCast(p))[0..copy]);
    _ = alloc_map.removeContext(@intFromPtr(p), hash_ctx);
    track(@intFromPtr(mem.ptr), n);
    return @ptrCast(mem.ptr);
}

export fn free(ptr: ?*anyopaque) void {
    if (ptr == null) return;
    const p = @as([*]u8, @ptrCast(ptr.?));
    const size = alloc_map.getContext(@intFromPtr(p), hash_ctx) orelse 0;
    if (size > 0) std.heap.page_allocator.free(p[0..size]);
    _ = alloc_map.removeContext(@intFromPtr(p), hash_ctx);
}

export fn abort() noreturn {
    // Traps the wasm module.
    unreachable;
}

export fn qsort(
    base: ?*anyopaque,
    nmemb: usize,
    size: usize,
    compar: *const fn (?*const anyopaque, ?*const anyopaque) callconv(.{ .wasm_mvp = .{} }) c_int,
) void {
    if (nmemb < 2 or base == null) return;
    const bytes = @as([*]u8, @ptrCast(base.?))[0..nmemb * size];
    const Ctx = struct {
        bytes: []u8,
        size: usize,
        compar: *const fn (?*const anyopaque, ?*const anyopaque) callconv(.{ .wasm_mvp = .{} }) c_int,
        pub fn lessThan(ctx: @This(), a: usize, b: usize) bool {
            const pa = ctx.bytes.ptr + a * ctx.size;
            const pb = ctx.bytes.ptr + b * ctx.size;
            return ctx.compar(pa, pb) < 0;
        }
        pub fn swap(ctx: @This(), a: usize, b: usize) void {
            const s = ctx.size;
            const a0 = ctx.bytes.ptr + a * s;
            const b0 = ctx.bytes.ptr + b * s;
            var i: usize = 0;
            while (i < s) : (i += 1) {
                const t = a0[i];
                a0[i] = b0[i];
                b0[i] = t;
            }
        }
    };
    std.sort.pdqContext(0, nmemb, Ctx{ .bytes = bytes, .size = size, .compar = compar });
}

// ---------------------------------------------------------------------------
// String / memory functions
// ---------------------------------------------------------------------------

export fn memcpy(dest: ?*anyopaque, src: ?*const anyopaque, n: usize) ?*anyopaque {
    if (dest == null or src == null) return null;
    if (n == 0) return dest;
    const d = @as([*]u8, @ptrCast(dest.?));
    const s = @as([*]const u8, @ptrCast(src.?));
    @memcpy(d[0..n], s[0..n]);
    return dest;
}

export fn memmove(dest: ?*anyopaque, src: ?*const anyopaque, n: usize) ?*anyopaque {
    if (dest == null or src == null) return null;
    if (n == 0) return dest;
    const d = @as([*]u8, @ptrCast(dest.?));
    const s = @as([*]const u8, @ptrCast(src.?));
    @memmove(d[0..n], s[0..n]);
    return dest;
}

export fn memset(s: ?*anyopaque, c: c_int, n: usize) ?*anyopaque {
    if (s == null) return null;
    const b = @as([*]u8, @ptrCast(s.?));
    @memset(b[0..n], @intCast(c));
    return s;
}

export fn memcmp(a: ?*const anyopaque, b: ?*const anyopaque, n: usize) c_int {
    if (a == null or b == null) return 0;
    const x = @as([*]const u8, @ptrCast(a.?));
    const y = @as([*]const u8, @ptrCast(b.?));
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (x[i] != y[i]) return @as(c_int, @intCast(x[i])) - @as(c_int, @intCast(y[i]));
    }
    return 0;
}

export fn strlen(s: ?*const u8) usize {
    const bytes = @as([*]const u8, @ptrCast(s orelse return 0));
    var i: usize = 0;
    while (bytes[i] != 0) : (i += 1) {}
    return i;
}

export fn strcmp(a: ?*const u8, b: ?*const u8) c_int {
    if (a == null or b == null) return 0;
    const sa = @as([*]const u8, @ptrCast(a.?));
    const sb = @as([*]const u8, @ptrCast(b.?));
    var i: usize = 0;
    while (sa[i] != 0 and sb[i] != 0) : (i += 1) {
        if (sa[i] != sb[i]) return @as(c_int, @intCast(sa[i])) - @as(c_int, @intCast(sb[i]));
    }
    return @as(c_int, @intCast(sa[i])) - @as(c_int, @intCast(sb[i]));
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export fn _zig_assert_fail(expr: [*c]const u8, file: [*c]const u8, line: c_int) noreturn {
    _ = expr;
    _ = file;
    _ = line;
    abort();
}
