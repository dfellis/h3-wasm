# Builds h3.wasm: H3 v4.5.0 C library + Zig binding exports, targeting
# wasm32-freestanding with a hand-written C shim (no libc).
#
# Two stages:
#   1. build/support.a - Zig support module (malloc/calloc/realloc/free,
#      qsort, mem*/string helpers, _zig_assert_fail) compiled as a static
#      archive. It is a separate Zig module because exported functions in
#      files merely transitively imported by the root module get DCE'd.
#   2. h3.wasm - the final shared object: support.a + h3 C sources +
#      C varargs (cvar.c) + mathcompat.c (round/lround/fmin/fmax), with
#      h3.zig as the Zig root providing the bind__* wasm exports. The C
#      transcendentals (sin/cos/atan2/...) are imported from the host env
#      namespace, where index.js provides the Math.* builtins - there is
#      no software libm in the build.
#
# NOTE: `zig build` (build.zig) is intentionally not used: the 0.16 build
# system turns the (harmless) LLD dylib stderr warning into a hard error via
# the error-bundle path (std/Build/Step.zig), while the identical CLI
# `zig build-lib` invocation exits 0 with the same output.
#
# build/metadata.js is generated from the linked wasm (data segment extent +
# import constraints) and is imported by index.js at runtime.

ZIG ?= zig
NODE ?= node

# -fPIC is required for dynamic linking; -dynamic produces the wasm shared
# object (dylib) shape JS can instantiate with imported memory/table/globals.
ZIGFLAGS = -target wasm32-freestanding -mcpu baseline -OReleaseSmall -fPIC

H3_C_SRCS := $(wildcard h3/src/h3lib/lib/*.c)

.PHONY: all clean test

all: h3.wasm build/metadata.js

build:
	mkdir -p build

build/support.a: support.zig Makefile | build
	$(ZIG) build-lib support.zig $(ZIGFLAGS) -static -femit-bin=build/support.a --name support

h3.wasm: build/support.a h3.zig $(H3_C_SRCS) mathcompat.c cvar.c $(wildcard cshim/*) Makefile
	# NOTE: Zig 0.16 CLI quirk: per-module options (-target/-mcpu/-O/...)
	# must come BEFORE -Mroot=; options after -Mroot= are silently dropped
	# and the build defaults to the native target (symptom: "not an ELF
	# file" when the wasm archive is fed to the ELF linker).
	-@rm -f h3.wasm
	$(ZIG) build-lib $(ZIGFLAGS) -dynamic build/support.a mathcompat.c cvar.c $(H3_C_SRCS) \
		-Mroot=h3.zig \
		-I cshim -I h3/src/h3lib/include \
		-femit-bin=h3.wasm --name h3

build/metadata.js: h3.wasm tools/gen-metadata.mjs
	$(NODE) tools/gen-metadata.mjs

test: all
	$(NODE) --test 'test/*.test.js'

clean:
	rm -rf h3.wasm build .zig-cache
