import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { uploadError, uploadType, MB } from '../public/upload-formats.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function checkHeader(bytes, kind) {
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const pdf = bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  const video = bytes.length > 12 && ['ftyp', 'moov', 'mdat', 'wide'].includes(bytes.toString('ascii', 4, 8));
  if (!(kind === 'image' ? png || jpeg : kind === 'pdf' ? pdf : video)) {
    throw fail('The file contents do not match a supported image, PDF, or video. Please export it in a supported format.');
  }
}

export function parseUpload(raw, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!match) throw fail('Select a file and submit it as multipart/form-data.', 415);
  const boundary = Buffer.from('--' + (match[1] || match[2]));
  const delimiter = Buffer.from('\r\n--' + (match[1] || match[2]));
  let cursor = raw.indexOf(boundary);
  const files = [];
  while (cursor !== -1) {
    cursor += boundary.length;
    if (raw.toString('ascii', cursor, cursor + 2) === '--') break;
    if (raw.toString('ascii', cursor, cursor + 2) !== '\r\n') throw fail('Malformed file upload. Please try again.');
    const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1 || headerEnd - cursor > 16384) throw fail('Invalid upload headers.');
    const header = raw.toString('utf8', cursor + 2, headerEnd);
    const dataStart = headerEnd + 4;
    let dataEnd = raw.indexOf(delimiter, dataStart);
    while (dataEnd !== -1 && !['--', '\r\n'].includes(raw.toString('ascii', dataEnd + delimiter.length, dataEnd + delimiter.length + 2))) {
      dataEnd = raw.indexOf(delimiter, dataEnd + delimiter.length);
    }
    if (dataEnd === -1) throw fail('Incomplete file upload. Please try again.');
    const filename = header.match(/filename="([^"]*)"|filename=([^;\r\n]+)/i);
    const field = header.match(/(?:^|;)\s*name="?([^";\r\n]+)"?/im);
    if (filename && ['footage', 'file'].includes(field?.[1])) {
      const originalName = basename((filename[1] ?? filename[2]).replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '');
      const bytes = raw.subarray(dataStart, dataEnd);
      const error = uploadError({ name: originalName, size: bytes.length });
      if (error) throw fail(error, bytes.length > (uploadType(originalName)?.maxBytes ?? Infinity) ? 413 : 415);
      const type = uploadType(originalName);
      checkHeader(bytes, type.kind);
      files.push({ filename: originalName, size: bytes.length, kind: type.kind, bytes });
    }
    cursor = dataEnd + 2;
  }
  if (files.length !== 1) throw fail('Please upload one file at a time.');
  return files[0];
}

export async function receiveUpload(req, directory) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 251 * MB) throw fail('The upload exceeds the maximum file size of 250 MB.', 413);
    chunks.push(chunk);
  }
  const { bytes, ...file } = parseUpload(Buffer.concat(chunks), req.headers['content-type'] || '');
  const storedName = `${randomUUID()}${extname(file.filename).toLowerCase()}`;
  const path = join(directory, storedName);
  await writeFile(path, bytes);
  return { ...file, storedName, path };
}
