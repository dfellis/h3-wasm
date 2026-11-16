/* Minimal stdio.h shim for wasm32-freestanding builds. */
#ifndef SHIM_STDIO_H
#define SHIM_STDIO_H

#include <stddef.h>

int sprintf(char *str, const char *fmt, ...);
int snprintf(char *str, size_t size, const char *fmt, ...);
int sscanf(const char *str, const char *fmt, ...);
int printf(const char *fmt, ...);

#endif
