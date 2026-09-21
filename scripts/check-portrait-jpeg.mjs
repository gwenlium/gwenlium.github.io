import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
// Exercise the uploader's actual metadata parser without starting its browser/FFmpeg runtime.
const source = fs.readFileSync('src/scripts/admin-media.ts', 'utf8').replace(/^import .*;\n/gm, '') + '\nexport { inspectRaster };';
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = { exports: {}, Blob, File, AbortController, DOMException };
vm.runInNewContext(code, sandbox);
const jpeg = await sharp({ create: { width: 320, height: 480, channels: 3, background: '#b8c8a4' } }).jpeg().toBuffer();
const mpf = Buffer.from([0xff, 0xe2, 0, 6, 77, 80, 70, 0]);
const portrait = Buffer.concat([jpeg.subarray(0, 2), mpf, jpeg.subarray(2)]);
const result = sandbox.exports.inspectRaster(new Uint8Array(portrait));
assert.equal(result.width, 320);
assert.equal(result.height, 480);
assert.equal(result.mime, 'image/jpeg');
assert.throws(() => sandbox.exports.inspectRaster(new Uint8Array([0xff, 0xd8, 0xff, 0xe2, 0, 20, 77, 80, 70, 0])));
console.log('Camera JPEG with MPF metadata accepted; truncated JPEG still rejected.');
