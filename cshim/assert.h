/* Minimal assert.h shim for wasm32-freestanding builds. */
#ifndef SHIM_ASSERT_H
#define SHIM_ASSERT_H
#ifdef NDEBUG
#define assert(x) ((void)0)
#else
void _zig_assert_fail(const char *expr, const char *file, int line);
#define assert(x) ((x) ? (void)0 : _zig_assert_fail(#x, __FILE__, __LINE__))
#endif
#endif
