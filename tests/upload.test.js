import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpload } from '../services/uploads.js';
import { uploadError, uploadType, MB } from '../public/upload-formats.js';

const boundary = 'test-boundary-123';
const type = `multipart/form-data; boundary="${boundary}"`;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
function multipart(files) {
  return Buffer.concat([...files.flatMap(([name, bytes]) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="footage"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from('\r\n')
  ]), Buffer.from(`--${boundary}--\r\n`)]);
}
test('shared validation accepts every supported format, case-insensitively', () => {
  for (const name of ['road.PNG', 'road.jpg', 'road.JPEG', 'inspection.pdf', 'flight.mp4', 'flight.MOV']) {
    assert.ok(uploadType(name));
    assert.equal(uploadError({ name, size: 10 }), '');
  }
  assert.match(uploadError({ name: 'road.gif', size: 10 }), /Supported formats/);
  assert.match(uploadError({ name: 'road.png', size: 0 }), /nonempty/);
});
test('format-specific size limits are enforced', () => {
  for (const [name, limit] of [['x.png', 25], ['x.jpeg', 25], ['x.pdf', 50], ['x.mp4', 250]]) {
    assert.equal(uploadError({ name, size: limit * MB }), '');
    assert.match(uploadError({ name, size: limit * MB + 1 }), /exceeds/);
  }
});
test('multipart parser preserves binary and boundary-like payload bytes', () => {
  const bytes = Buffer.concat([png, Buffer.from(`\r\n--${boundary}-not-a-boundary`), Buffer.from([0, 255])]);
  const file = parseUpload(multipart([['road.PNG', bytes]]), type);
  assert.equal(file.kind, 'image');
  assert.equal(file.size, bytes.length);
  assert.deepEqual(file.bytes, bytes);
});
test('JPEG, PDF and MP4 signatures are accepted', () => {
  for (const [name, bytes, kind] of [
    ['x.jpeg', Buffer.from([255, 216, 255, 224, 0]), 'image'],
    ['x.pdf', Buffer.from('%PDF-1.7\nfixture'), 'pdf'],
    ['x.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000')]), 'video']
  ]) assert.equal(parseUpload(multipart([[name, bytes]]), type).kind, kind);
});
test('wrong contents, unsupported extensions, empty/missing files and multiple files fail clearly', () => {
  for (const files of [[['x.png', Buffer.from('not an image')]], [['x.exe', png]], [['x.png', Buffer.alloc(0)]], [], [['a.png', png], ['b.png', png]]]) {
    assert.throws(() => parseUpload(multipart(files), type), (error) => error.statusCode >= 400);
  }
  assert.throws(() => parseUpload(multipart([['x.png', png]]), 'application/json'), /multipart/);
  assert.throws(() => parseUpload(multipart([['x.png', png]]).subarray(0, 130), type), /Incomplete|headers/);
});
test('filenames cannot escape the upload directory', () => {
  assert.equal(parseUpload(multipart([['C:\\fakepath\\road.png', png]]), type).filename, 'road.png');
});
