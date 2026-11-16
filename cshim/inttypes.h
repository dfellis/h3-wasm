/* Minimal inttypes.h shim for wasm32-freestanding builds (wasm32: 64-bit = long long). */
#ifndef SHIM_INTTYPES_H
#define SHIM_INTTYPES_H

#include <stdint.h>

#define PRId8 "hhd"
#define PRIi8 "hhi"
#define PRIu8 "hhu"
#define PRIx8 "hhx"
#define PRIX8 "hhX"
#define PRId16 "hd"
#define PRIi16 "hi"
#define PRIu16 "hu"
#define PRIx16 "hx"
#define PRIX16 "hX"
#define PRId32 "d"
#define PRIi32 "i"
#define PRIu32 "u"
#define PRIx32 "x"
#define PRIX32 "X"
#define PRId64 "lld"
#define PRIi64 "lli"
#define PRIu64 "llu"
#define PRIx64 "llx"
#define PRIX64 "llX"
#define SCNd8 "hhd"
#define SCNi8 "hhi"
#define SCNu8 "hhu"
#define SCNx8 "hhx"
#define SCNd16 "hd"
#define SCNi16 "hi"
#define SCNu16 "hu"
#define SCNx16 "hx"
#define SCNd32 "d"
#define SCNi32 "i"
#define SCNu32 "u"
#define SCNx32 "x"
#define SCNd64 "lld"
#define SCNi64 "lli"
#define SCNu64 "llu"
#define SCNx64 "llx"

#endif
