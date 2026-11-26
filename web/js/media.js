(function (root) {
  'use strict';

  const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
  const DEFAULT_MAX_EDGE = 1920;
  const DEFAULT_QUALITY = 0.82;
  const MIN_COMPRESS_BYTES = 180 * 1024;

  function shouldCompressImage(file, options = {}) {
    if (!file || typeof file !== 'object') return false;
    const type = String(file.type || '').toLowerCase();
    if (!COMPRESSIBLE_TYPES.has(type)) return false;
    const minBytes = options.minBytes ?? MIN_COMPRESS_BYTES;
    if (Number(file.size || 0) < minBytes) return false;
    return true;
  }

  function computeScaledDimensions(width, height, maxEdge = DEFAULT_MAX_EDGE) {
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    const limit = Math.max(1, Math.round(Number(maxEdge) || DEFAULT_MAX_EDGE));
    const longest = Math.max(w, h);
    if (longest <= limit) return { width: w, height: h, scaled: false };
    const ratio = limit / longest;
    return {
      width: Math.max(1, Math.round(w * ratio)),
      height: Math.max(1, Math.round(h * ratio)),
      scaled: true,
    };
  }

  function loadImageElement(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (error) => {
        URL.revokeObjectURL(url);
        reject(error);
      };
      img.src = url;
    });
  }

  /**
   * Compress a photo in the browser/WebView before storing in IndexedDB.
   * Always falls back to the original file if compression is unsupported or
   * produces a larger result.
   */
  async function compressImageBlob(file, options = {}) {
    if (!shouldCompressImage(file, options)) {
      return { blob: file, compressed: false, originalSize: file?.size || 0, finalSize: file?.size || 0 };
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      return { blob: file, compressed: false, originalSize: file.size, finalSize: file.size };
    }

    const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
    const quality = options.quality ?? DEFAULT_QUALITY;
    let source = null;
    let closeSource = null;

    try {
      let width = 0;
      let height = 0;
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file);
        source = bitmap;
        width = bitmap.width;
        height = bitmap.height;
        closeSource = () => bitmap.close?.();
      } else {
        const img = await loadImageElement(file);
        source = img;
        width = img.naturalWidth || img.width;
        height = img.naturalHeight || img.height;
      }

      const target = computeScaledDimensions(width, height, maxEdge);
      const canvas = document.createElement('canvas');
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { blob: file, compressed: false, originalSize: file.size, finalSize: file.size };
      }
      ctx.drawImage(source, 0, 0, target.width, target.height);

      // Keep PNG transparency when the source is PNG and not scaled down heavily;
      // otherwise encode as JPEG for substantial size reduction.
      const preferredMime = String(file.type).toLowerCase() === 'image/webp' ? 'image/webp' : 'image/jpeg';
      const compressed = await new Promise((resolve) => canvas.toBlob(resolve, preferredMime, quality));
      if (!compressed || !compressed.size || compressed.size >= file.size) {
        return { blob: file, compressed: false, originalSize: file.size, finalSize: file.size };
      }
      return {
        blob: compressed,
        compressed: true,
        originalSize: file.size,
        finalSize: compressed.size,
      };
    } catch {
      return { blob: file, compressed: false, originalSize: file.size, finalSize: file.size };
    } finally {
      if (closeSource) closeSource();
    }
  }

  const api = {
    COMPRESSIBLE_TYPES,
    DEFAULT_MAX_EDGE,
    DEFAULT_QUALITY,
    MIN_COMPRESS_BYTES,
    shouldCompressImage,
    computeScaledDimensions,
    compressImageBlob,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RedPandaMedia = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
