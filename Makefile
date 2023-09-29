h3.wasm: h3.zig
	zig build-lib h3.zig -target wasm32-freestanding-none -dynamic -O ReleaseSmall -rdynamic

hello: h3.wasm
	node hello.js

clean:
	git clean -ffdx
