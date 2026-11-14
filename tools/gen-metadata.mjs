// Extracts build-time metadata from h3.wasm and writes build/metadata.js:
//   - memory/table import constraints (so the JS layer can instantiate with
//     matching limits)
//   - dataEnd: one past the end of the highest active data segment. The wasm
//     dylib's data segment starts at address 0, so the JS-owned memory region
//     (bump-allocated user data) must start at dataEnd and never use address 0.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, '..', 'h3.wasm');
const bytes = new Uint8Array(readFileSync(wasmPath));

function readU32(pos) {
  return (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0;
}

function readULEB(pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

function readName(pos) {
  const [len, p] = readULEB(pos);
  const name = Buffer.from(bytes.subarray(p, p + len)).toString('utf8');
  return [name, p + len];
}

function readSLEB(pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (byte & 0x40) result -= 1 << shift; // sign-extend
      break;
    }
    shift += 7;
  }
  return [result, pos];
}

/// Evaluate a data-segment offset init expression. The dylib emits
/// `global.get <imported base> [i32.const C i32.add]*`; in our
/// instantiation the imported base globals are 0, so we evaluate with
/// global.get = 0.
function evalOffsetExpr(p) {
  const stack = [];
  for (;;) {
    const op = bytes[p++];
    if (op === 0x0b) break; // end
    if (op === 0x41) {
      const [val, q] = readSLEB(p);
      p = q;
      stack.push(val);
    } else if (op === 0x23) {
      const [, q] = readULEB(p);
      p = q;
      stack.push(0); // imported base global, always 0 here
    } else if (op === 0x6a) { // i32.add
      const b = stack.pop();
      stack.push(stack.pop() + b);
    } else {
      throw new Error(`unsupported opcode 0x${op.toString(16)} in data offset expr`);
    }
  }
  if (stack.length !== 1) throw new Error('malformed data offset expr');
  return [stack[0], p];
}

// --- validate header ---------------------------------------------------------
if (bytes.length < 8 || readU32(0) !== 0x6d736100) throw new Error('not a wasm file');
const version = readU32(4);
if (version !== 1) throw new Error(`unsupported wasm version ${version}`);

// --- walk sections -----------------------------------------------------------
let memoryImport = null; // {min, max}
let tableImport = null;
let dataEnd = 0;
let dataSegments = 0;
let funcImports = 0;

let pos = 8;
while (pos < bytes.length) {
  const id = bytes[pos++];
  const [size, bodyStart] = readULEB(pos);
  const bodyEnd = bodyStart + size;

  if (id === 2) {
    // import section
    const [count, q] = readULEB(bodyStart);
    let p = q;
    for (let i = 0; i < count; i++) {
      const [module, q1] = readName(p);
      const [field, q2] = readName(q1);
      const kind = bytes[q2];
      if (kind === 0) {
        funcImports++;
        const [, q3] = readULEB(q2 + 1);
        p = q3;
      } else if (kind === 1 || kind === 2) {
        // Zig 0.16 dylib: table descriptors are [reftype, limits], memory is [limits]
        const [reftype, q3] = kind === 1 ? readULEB(q2 + 1) : [0, q2 + 1];
        const flags = bytes[q3];
        const [min, q4] = readULEB(q3 + 1);
        let max = null;
        if (flags & 1) {
          [max] = readULEB(q4);
        }
        p = q4;
        if (flags & 1) p = readULEB(q4)[1];
        if (kind === 1 && module === 'env' && field === '__indirect_function_table') {
          tableImport = { min, max, reftype };
        } else if (kind === 2 && module === 'env' && field === 'memory') {
          memoryImport = { min, max };
        }
      } else if (kind === 3) {
        // Zig 0.16 dylib: global imports are [valtype, mut] with NO init expr
        const [, q3] = readULEB(q2 + 1); // valtype
        p = q3 + 1; // mut byte
      } else {
        throw new Error(`unsupported import kind ${kind}`);
      }
    }
  } else if (id === 11) {
    // data section (dylib layout: 9=element, 10=code, 11=data)
    const [count, q] = readULEB(bodyStart);
    let p = q;
    for (let i = 0; i < count; i++) {
      const kind = bytes[p++];
      if (kind !== 0) throw new Error(`unsupported data segment kind ${kind}`);
      const [offset, q1] = evalOffsetExpr(p);
      const [size, q2] = readULEB(q1);
      dataEnd = Math.max(dataEnd, offset + size);
      dataSegments++;
      p = q2 + size;
    }
  }
  pos = bodyEnd;
}

if (!memoryImport) throw new Error('no env.memory import found');
if (!tableImport) throw new Error('no env.__indirect_function_table import found');

const out = `// Generated by tools/gen-metadata.mjs from h3.wasm - do not edit.
export const memoryMin = ${memoryImport.min};
export const memoryMax = ${memoryImport.max === null ? 'null' : memoryImport.max};
export const tableMin = ${tableImport.min};
export const tableMax = ${tableImport.max === null ? 'null' : tableImport.max};
export const tableReftype = 0x${tableImport.reftype.toString(16)}; // 0x70=funcref, 0x6f=externref, 0x71=anyref
export const dataEnd = ${dataEnd};
export const dataSegments = ${dataSegments};
export const funcImports = ${funcImports};
`;
mkdirSync(join(__dirname, '..', 'build'), { recursive: true });
writeFileSync(join(__dirname, '..', 'build', 'metadata.js'), out);
console.log(
  `metadata: memory=[${memoryImport.min}, ${memoryImport.max ?? 'unbounded'}] ` +
    `table=[${tableImport.min}, ${tableImport.max ?? 'unbounded'}] ` +
    `dataEnd=${dataEnd} (${dataSegments} segments) funcImports=${funcImports}`
);
