h3:
	git clone git@github.com:uber/h3
	cd h3 && git checkout v4.1.0 && cmake . -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS=-fPIC

h3.wasm: h3.zig h3
	zig build-lib h3.zig -target wasm32-freestanding-musl -dynamic -O ReleaseSmall -rdynamic -lc -I./h3/src/h3lib/include ./h3/src/h3lib/lib/*.c

hello: h3.wasm
	node hello.js

clean:
	git clean -ffdx
