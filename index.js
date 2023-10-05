const crypto = require('crypto');
const fs = require('fs');
const mod = new WebAssembly.Module(fs.readFileSync('h3.wasm'))
// "Scratch" object for the binding API
const scratch = new Map();
const inst = new WebAssembly.Instance(mod, {
  env: {
    // Not that this matters in JS-land, but this logic is not threadsafe ;)
    makeArr: () => { 
      const id = crypto.randomInt(0, 2 ** 31);
      scratch.set(id, []);
      return id;
    },
    makeObj: () => {
      const id = crypto.randomInt(0, 2 ** 31);
      scratch.set(id, {});
      return id;
    },
    makeErr: (code) => {
      const id = crypto.randomInt(0, 2 ** 31);
      const err = new Error();
      err.code = code;
      scratch.set(id, err);
      return id;
    },
    makeInt32: (val) => {
      const id = crypto.randomInt(0, 2 ** 31);
      scratch.set(id, val);
      return id;
    },
    makeStr: (val) => {
      const id = crypto.randomInt(0, 2 ** 31);
      const arr = new Uint8Array(inst.exports.memory.buffer);
      const chars = [];
      for (let i = val; i < arr.length; i++) {
        if (arr[i] === 0) break;
        chars.push(String.fromCharCode(arr[i]));
      }
      str = chars.join('');
      scratch.set(id, str);
      return id;
    },
    makeBool: (val) => {
      const id = crypto.randomInt(0, 2 ** 31);
      scratch.set(id, !!val);
      return id;
    },
    getInt32: (id) => {
      const val = scratch.get(id);
      const addr = inst.exports.alloc(4);
      const arr = new Uint32Array(inst.exports.memory.buffer);
      arr.set([val], addr / 4);
      return addr;
    },
    getDouble: (id) => {
      const val = scratch.get(id);
      const addr = inst.exports.alloc(8);
      const arr = new Float64Array(inst.exports.memory.buffer);
      arr.set([val], addr / 8);
      return addr;
    },
    getStr: (id) => {
      const val = scratch.get(id);
      const len = val.length + 1;
      const addr = inst.exports.alloc(len);
      const arr = new Uint8Array(inst.exports.memory.buffer);
      arr.set(val.split('').map(c => c.charCodeAt(0)), addr);
      return addr;
    },
    appendInt32: (id, val) => {
      const arr = scratch.get(id);
      // I could add an `instanceof` check here, but it would slow things down and it should be
      // trivial to verify correctness in the test suite, so I'm not including these for now.
      arr.push(val);
    },
    appendDouble: (id, val) => {
      const arr = scratch.get(id);
      // I could add an `instanceof` check here, but it would slow things down and it should be
      // trivial to verify correctness in the test suite, so I'm not including these for now.
      arr.push(val);
    },
    appendStr: (id, val) => {
      const array = scratch.get(id);
      const arr = new Uint8Array(inst.exports.memory.buffer);
      const chars = [];
      for (let i = val; i < arr.length; i++) {
        if (arr[i] === 0) break;
        chars.push(String.fromCharCode(arr[i]));
      }
      str = chars.join('');
      array.push(str);
    },
    appendBool: (id, val) => {
      const arr = scratch.get(id);
      arr.push(!!val);
    },
    appendObj: (arrId, valId) => {
      const arr = scratch.get(arrId);
      const val = scratch.get(valId);
      arr.push(val);
    },
    addInt32: (id, key, val) => {
      const obj = scratch.get(id);
      obj[key] = val;
    },
    addDouble: (id, key, val) => {
      const obj = scratch.get(id);
      obj[key] = val;
    },
    addStr: (id, key, val) => {
      const obj = scratch.get(id);
      const arr = new Uint8Array(inst.exports.memory.buffer);
      const chars = [];
      for (let i = val; i < arr.length; i++) {
        if (arr[i] === 0) break;
        chars.push(String.fromCharCode(arr[i]));
      }
      str = chars.join('');
      obj[key] = str;
    },
    addBool: (id, key, val) => {
      const obj = scratch.get(id);
      obj[key] = !!val;
    },
    addObj: (objId, key, valId) => {
      const obj = scratch.get(objId);
      const val = scratch.get(valId);
      obj[key] = val;
    },
    consoleLog: (val) => {
      const arr = new Uint8Array(inst.exports.memory.buffer);
      const chars = [];
      for (let i = val; i < arr.length; i++) {
        if (arr[i] === 0) break;
        chars.push(String.fromCharCode(arr[i]));
      }
      str = chars.join('');
      console.log(str);
    },
  }
});

module.exports = {
  ...Object.fromEntries(
    Object.entries(inst.exports)
      .filter(([name, fn]) => fn instanceof Function && name.startsWith('bind__'))
      .map(([name, fn]) => {
        // Assuming *all* binding functions return a scratch ID
        return [name.substring(6), (...args) => {
          Object.values(args).forEach((v, i) => scratch.set(i, v));
          const id = fn();
          const val = scratch.get(id);
          scratch.clear();
          return val;
        }];
      })
  ),
      UNITS: {
    m: 'm',
    km: 'km',
    rads: 'rads',
    m2: 'm2',
    km2: 'km2',
    rads2: 'rads2',
  },
}
