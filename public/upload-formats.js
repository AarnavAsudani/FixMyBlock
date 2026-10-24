export const MB = 1024 * 1024;
export const MAX_PDF_PAGES = 50;
export const UPLOAD_TYPES = {
  '.mp4': { kind: 'video', maxBytes: 250 * MB },
  '.mov': { kind: 'video', maxBytes: 250 * MB },
  '.png': { kind: 'image', maxBytes: 25 * MB },
  '.jpg': { kind: 'image', maxBytes: 25 * MB },
  '.jpeg': { kind: 'image', maxBytes: 25 * MB },
  '.pdf': { kind: 'pdf', maxBytes: 50 * MB }
};

export function uploadType(filename = '') {
  return UPLOAD_TYPES[filename.slice(filename.lastIndexOf('.')).toLowerCase()] || null;
}

export function uploadError(file) {
  if (!file?.name || !file.size) return 'Choose a nonempty PNG, JPG/JPEG, PDF, MP4, or MOV file.';
  const type = uploadType(file.name);
  if (!type) return 'Supported formats: PNG, JPG/JPEG, PDF, MP4, and MOV.';
  if (file.size > type.maxBytes) return `This ${type.kind === 'pdf' ? 'PDF' : type.kind} exceeds the ${type.maxBytes / MB} MB limit.`;
  return '';
}
