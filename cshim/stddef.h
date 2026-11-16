/* Minimal stddef.h shim for wasm32-freestanding builds. */
#ifndef SHIM_STDDEF_H
#define SHIM_STDDEF_H
/* Must be `unsigned long` (not `unsigned int`): zig cc's built-in
   declarations of malloc/calloc/realloc/snprintf use `unsigned long`, and
   a redeclaration with a different type is an error. */
typedef unsigned long size_t;
#define NULL ((void *)0)
#define offsetof(type, member) __builtin_offsetof(type, member)
#endif
