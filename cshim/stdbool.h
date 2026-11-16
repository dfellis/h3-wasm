/* Minimal stdbool.h shim for wasm32-freestanding builds. */
#ifndef SHIM_STDBOOL_H
#define SHIM_STDBOOL_H
#ifndef __bool_true_false_are_defined
#define __bool_true_false_are_defined 1
#endif
#define bool _Bool
#define true 1
#define false 0
#endif
