/* Minimal stdlib.h shim for wasm32-freestanding builds. */
#ifndef SHIM_STDLIB_H
#define SHIM_STDLIB_H

#include <stddef.h>

void *malloc(size_t size);
void *calloc(size_t count, size_t size);
void *realloc(void *ptr, size_t size);
void free(void *ptr);
void qsort(void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *));
void abort(void);
int abs(int j);

#endif
