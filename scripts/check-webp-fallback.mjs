import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';

// Run the bundled WASM encoder, not a native FFmpeg or a mock WebP encoder.
const runtime = vm.createContext({
  self: { location: { href: 'https://gwenlium.dev/ffmpeg-core.js' } },
  WebAssembly, Uint8Array, performance, setTimeout, clearTimeout, atob,
});
vm.runInContext(fs.readFileSync('node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js', 'utf8'), runtime);
const core = await runtime.createFFmpegCore({ wasmBinary: fs.readFileSync('node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm') });
let workers = 0;
let stopped = 0;
let conversions = 0;
const writes = [];
class Transcoder {
  constructor() { workers++; }
  async load() {}
  async writeFile(name, data) { writes.push(name); core.FS.writeFile(name, data); }
  async readFile(name) { return core.FS.readFile(name); }
  async deleteFile(name) { core.FS.unlink(name); }
  async exec(args) { conversions++; core.reset(); return core.exec(...args); }
  terminate() { stopped++; }
}
class FileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(result => { this.result = result; this.onload(); });
  }
}
const source = fs.readFileSync('src/scripts/editor/prepare-media.ts', 'utf8').replace(/^import .*;\n/gm, '') + '\nexport { encodeWebp };';
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = {
  exports: {}, Blob, File, FileReader, ArrayBuffer, Uint8Array, DataView,
  AbortController, DOMException, URL, setTimeout, clearTimeout, WebAssembly,
  Worker: class {}, FFmpeg: Transcoder, location: new URL('https://gwenlium.dev/write/'),
  classWorkerURL: '/worker.js', coreURL: '/core.js', wasmURL: '/core.wasm',
};
vm.runInNewContext(code, sandbox);
const options = { creator: 'Test creator', start: 0, duration: 30 };
const size = { width: 63, height: 47 }; // Odd edges and transparency must survive the fallback.
const png = await sharp({ create: { ...size, channels: 4, background: '#64a4c480' } }).png().toBuffer();
const nativeWebp = await sharp(png).withIccProfile('srgb').webp().toBuffer();

// Native WebP needs no worker and still has browser-added metadata removed.
const native = await sandbox.exports.encodeWebp({ toBlob(callback, type) {
  assert.equal(type, 'image/webp');
  callback(new Blob([nativeWebp], { type }));
} }, options);
assert.equal(workers, 0);
assert.equal((await sharp(Buffer.from(await native.arrayBuffer())).metadata()).icc, undefined);

// Safari returns PNG when WebP is unsupported. Also cover browsers returning null.
for (const unsupported of ['png', 'null']) {
  const requests = [];
  const output = await sandbox.exports.encodeWebp({ toBlob(callback, type) {
    requests.push(type);
    callback(type === 'image/webp' && unsupported === 'null' ? null : new Blob([png], { type: 'image/png' }));
  } }, options);
  assert.deepEqual(requests, ['image/webp', 'image/png']);
  assert.equal(output.type, 'image/webp');
  const metadata = await sharp(Buffer.from(await output.arrayBuffer())).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, size.width);
  assert.equal(metadata.height, size.height);
  assert.equal(metadata.hasAlpha, true);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(stopped, workers);
  assert.throws(() => core.FS.stat('canvas.png'));
  assert.throws(() => core.FS.stat('canvas.webp'));
}
assert.deepEqual(writes, ['canvas.png', 'canvas.png']);

// Posters share their existing worker; cancellation must never start a conversion.
const existing = new Transcoder();
const before = workers;
const canvas = { toBlob(callback) { callback(new Blob([png], { type: 'image/png' })); } };
await sandbox.exports.encodeWebp(canvas, options, existing);
assert.equal(workers, before);
const controller = new AbortController();
controller.abort();
const conversionsBeforeAbort = conversions;
await assert.rejects(sandbox.exports.encodeWebp(canvas, { ...options, signal: controller.signal }), { name: 'AbortError' });
assert.equal(workers, before);
assert.equal(conversions, conversionsBeforeAbort);

// A failed conversion releases its worker and generated temporary files.
class BrokenTranscoder extends Transcoder {
  async exec() { return 1; }
}
sandbox.FFmpeg = BrokenTranscoder;
await assert.rejects(sandbox.exports.encodeWebp(canvas, options), /could not be converted safely/);
assert.equal(stopped, workers - 1); // The caller still owns `existing`.
assert.throws(() => core.FS.stat('canvas.png'));
console.log('WebP preparation passes native encoding, Safari PNG/null fallback with bundled WASM, transparency, metadata removal, worker reuse, cancellation and cleanup.');
