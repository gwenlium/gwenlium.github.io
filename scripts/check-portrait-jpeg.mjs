import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
// Exercise the uploader's actual metadata parser without starting its browser/FFmpeg runtime.
const source = fs.readFileSync('src/scripts/editor/prepare-media.ts', 'utf8').replace(/^import .*;\n/gm, '') + '\nexport { inspectRaster, stripWebpMetadata };';
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
// Camera-sized MPF JPEG: the user's 8192 x 5464 photo exceeds the former 40 MP cap.
const large = Buffer.from(portrait);
const frame = large.indexOf(Buffer.from([0xff, 0xc0]));
assert(frame > 0);
large.writeUInt16BE(5464, frame + 5);
large.writeUInt16BE(8192, frame + 7);
assert.equal(sandbox.exports.inspectRaster(new Uint8Array(large)).width, 8192);
large.writeUInt16BE(16384, frame + 5);
large.writeUInt16BE(16384, frame + 7);
assert.throws(() => sandbox.exports.inspectRaster(new Uint8Array(large)));
console.log('Camera MPF JPEGs accepted through 80 MP; oversized and truncated inputs still rejected.');
// Chromium Canvas can add an sRGB ICC profile. Prepared files must remain
// decodable, pixel-identical and metadata-free before owner publication.
const profiled = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#b8c8a4' } }).withIccProfile('srgb').webp().toBuffer();
assert.ok((await sharp(profiled).metadata()).icc);
const stripped = Buffer.from(sandbox.exports.stripWebpMetadata(new Uint8Array(profiled)));
const metadata = await sharp(stripped).metadata();
assert.equal(metadata.icc, undefined);
assert.equal(metadata.width, 64);
assert.equal(metadata.height, 48);
assert.deepEqual(await sharp(stripped).raw().toBuffer(), await sharp(profiled).raw().toBuffer());
console.log('Prepared WebP copies preserve pixels while removing redundant browser metadata.');
