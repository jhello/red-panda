(function (root) {
  'use strict';

  // Must be divisible by 3 so each chunk encodes cleanly to base64 without mid-stream padding.
  const DEFAULT_CHUNK_BYTES = 384 * 1024;
  const STORAGE_WARN_RATIO = 0.8;

  const BACKUP_IMPORTERS = {
    1: async (data) => ({
      journeys: data.journeys,
      memories: data.memories,
      settings: data.settings || [],
    }),
  };

  function formatBytes(value) {
    const num = Math.max(0, Number(value) || 0);
    if (num < 1024) return `${num} B`;
    if (num < 1048576) return `${(num / 1024).toFixed(1)} KB`;
    if (num < 1073741824) return `${(num / 1048576).toFixed(1)} MB`;
    return `${(num / 1073741824).toFixed(2)} GB`;
  }

  function byteSize(value) {
    return new TextEncoder().encode(
      JSON.stringify(value, (_key, item) => (typeof Blob !== 'undefined' && item instanceof Blob ? undefined : item))
        .replace(/,"(?:blob|url|data)":(?:null|"[^"]*")/g, ''),
    ).length;
  }

  function formatBackupFilename(clock = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      `${clock.getFullYear()}${pad(clock.getMonth() + 1)}${pad(clock.getDate())}` +
      `${pad(clock.getHours())}${pad(clock.getMinutes())}${pad(clock.getSeconds())}`;
    return `red-panda-backup-${stamp}.rpd`;
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined' && typeof window === 'undefined') {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    }
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return btoa(binary);
  }

  function base64ToUint8Array(base64) {
    if (!base64) return new Uint8Array(0);
    if (typeof Buffer !== 'undefined' && typeof window === 'undefined') {
      const buf = Buffer.from(base64, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function arrayBufferToBase64Chunks(buffer, chunkBytes = DEFAULT_CHUNK_BYTES) {
    const aligned = Math.max(3, Math.floor(chunkBytes / 3) * 3);
    const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const chunks = [];
    for (let offset = 0; offset < view.length; offset += aligned) {
      chunks.push(bytesToBase64(view.subarray(offset, Math.min(offset + aligned, view.length))));
    }
    return chunks;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      if (typeof FileReader !== 'undefined') {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
        return;
      }
      blob.arrayBuffer().then((buf) => resolve(bytesToBase64(new Uint8Array(buf)))).catch(reject);
    });
  }

  function stableValue(value) {
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return { blobSize: value.size, blobType: value.type };
    }
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .filter((k) => !['blob', 'data', 'url'].includes(k))
          .sort()
          .map((k) => [k, stableValue(value[k])]),
      );
    }
    return value;
  }

  async function blobFingerprint(blob) {
    if (!blob) return '';
    const bytes = await blob.arrayBuffer();
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    const view = new Uint8Array(bytes);
    for (const b of view) hash = Math.imul(hash ^ b, 16777619);
    return `${(hash >>> 0).toString(16)}:${blob.size}:${blob.type}`;
  }

  async function backupRecordSignature(record, includeMedia = false) {
    const base = { ...record };
    if (record.blob) {
      base.blobFingerprint = await blobFingerprint(record.blob);
      delete base.blob;
    }
    if (includeMedia) {
      base.media = await Promise.all(
        (record.media || []).map(async (item) => ({
          ...item,
          blobFingerprint: await blobFingerprint(item.blob),
          blob: undefined,
          data: undefined,
          url: undefined,
        })),
      );
    }
    return JSON.stringify(stableValue(base));
  }

  async function compareBackupRecords(incoming, existing, includeMedia = false) {
    const oldById = new Map(existing.map((x) => [String(x.id), x]));
    const result = { old: existing.length, added: 0, identical: 0, updated: 0, records: [] };
    for (const item of incoming) {
      const old = oldById.get(String(item.id));
      if (!old) {
        result.added += 1;
        result.records.push(item);
        continue;
      }
      const [a, b] = await Promise.all([
        backupRecordSignature(item, includeMedia),
        backupRecordSignature(old, includeMedia),
      ]);
      if (a === b) result.identical += 1;
      else {
        result.updated += 1;
        result.records.push(item);
      }
    }
    return result;
  }

  const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

  function isSafeRecordId(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
    if (typeof value !== 'string') return false;
    return SAFE_ID_RE.test(value);
  }

  function nextRecordId() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
  }

  /**
   * Imported IDs end up in HTML attributes and navigation hashes. Replace any
   * unsafe value with a freshly generated ID and remap memory references.
   */
  function sanitizeBackupData(data) {
    const remapped = new Map();
    const usedIds = new Set(
      [...(data.journeys || []), ...(data.memories || [])]
        .map((item) => String(item?.id))
        .filter(Boolean),
    );
    const freshId = () => {
      let id;
      do {
        id = nextRecordId();
      } while (usedIds.has(String(id)));
      usedIds.add(String(id));
      return id;
    };

    const journeys = (data.journeys || []).map((journey) => {
      const item = { ...journey };
      if (!isSafeRecordId(item.id)) {
        const next = freshId();
        remapped.set(String(item.id), next);
        item.id = next;
      }
      return item;
    });
    const memories = (data.memories || []).map((memory) => {
      const item = { ...memory };
      if (!isSafeRecordId(item.id)) item.id = freshId();
      if (item.journeyId !== null && item.journeyId !== undefined && remapped.has(String(item.journeyId))) {
        item.journeyId = remapped.get(String(item.journeyId));
      }
      return item;
    });
    return { ...data, journeys, memories };
  }

  async function parseBackupEnvelope(data) {
    if (!data || typeof data !== 'object' || data.format !== 'red-panda-backup') {
      return { ok: false, errorCode: 'notBackup' };
    }
    // schemaVersion is the current explicit format field; `version` remains
    // accepted for backups written by the first released format.
    const schemaVersion = Number(data.schemaVersion ?? data.version);
    const adapt = BACKUP_IMPORTERS[schemaVersion];
    if (!adapt) return { ok: false, errorCode: 'unsupportedVersion', version: schemaVersion };
    const normalized = await adapt(data);
    if (
      !Array.isArray(normalized.journeys) ||
      !Array.isArray(normalized.memories) ||
      !Array.isArray(normalized.settings)
    ) {
      return { ok: false, errorCode: 'incomplete' };
    }
    return { ok: true, schemaVersion, data: sanitizeBackupData(normalized) };
  }

  async function estimateDeviceStorage(nav = typeof navigator !== 'undefined' ? navigator : null) {
    if (!nav?.storage?.estimate) return null;
    try {
      const { usage = 0, quota = 0 } = await nav.storage.estimate();
      if (!Number.isFinite(quota) || quota <= 0) return null;
      const ratio = Math.min(1, Math.max(0, usage / quota));
      return {
        usage,
        quota,
        ratio,
        percent: Math.round(ratio * 100),
        high: ratio >= STORAGE_WARN_RATIO,
      };
    } catch {
      return null;
    }
  }

  /**
   * Save a backup Blob through Android's native bridge. Uses chunked streaming
   * when supported by the host APK so large media backups do not hit WebView
   * IPC memory limits, and falls back to single-call saveBackup on older APKs.
   */
  /** Machine-readable backup failure codes; the UI localizes them with t(). */
  function backupError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  async function saveBackupViaAndroid(androidBridge, filename, fileBlob, onProgress = null) {
    const canChunk =
      typeof androidBridge?.beginBackup === 'function' &&
      typeof androidBridge?.appendBackupChunk === 'function' &&
      typeof androidBridge?.finishBackup === 'function';

    return new Promise((resolve, reject) => {
      const done = (ok, message) => {
        if (typeof window !== 'undefined') window.__backupSaveResult = null;
        if (ok) resolve(message);
        else reject(backupError(message || 'saveFailed'));
      };
      if (typeof window !== 'undefined') window.__backupSaveResult = done;

      (async () => {
        if (canChunk) {
          const started = androidBridge.beginBackup(filename);
          if (!started) throw backupError('streamStartFailed');
          const buf = await fileBlob.arrayBuffer();
          const chunks = arrayBufferToBase64Chunks(buf);
          for (let i = 0; i < chunks.length; i++) {
            const ok = androidBridge.appendBackupChunk(chunks[i]);
            if (!ok) throw backupError('chunkWriteFailed');
            if (onProgress) onProgress(Math.round(((i + 1) / Math.max(1, chunks.length)) * 100));
          }
          androidBridge.finishBackup();
          return;
        }
        const base64 = await blobToBase64(fileBlob);
        androidBridge.saveBackup(filename, base64);
      })().catch((error) => {
        if (typeof androidBridge?.cancelBackup === 'function') {
          try { androidBridge.cancelBackup(); } catch {}
        }
        done(false, error?.code || error?.message || 'saveFailed');
      });
    });
  }

  const api = {
    DEFAULT_CHUNK_BYTES,
    STORAGE_WARN_RATIO,
    BACKUP_IMPORTERS,
    formatBytes,
    byteSize,
    formatBackupFilename,
    bytesToBase64,
    base64ToUint8Array,
    arrayBufferToBase64Chunks,
    blobToBase64,
    stableValue,
    blobFingerprint,
    backupRecordSignature,
    compareBackupRecords,
    parseBackupEnvelope,
    estimateDeviceStorage,
    backupError,
    saveBackupViaAndroid,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RedPandaBackup = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
