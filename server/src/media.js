import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 单张照片 / 视频的上限，默认 25 MB。 */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/3gpp': '3gp',
};

const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.3gp': 'video/3gpp',
};

/** 上传目录：data/uploads/<用户 id>/<随机名>.<扩展名>。 */
export function uploadsDir(dataDir) {
  return path.join(dataDir, 'uploads');
}

/** 照片 / 视频都收，其它类型一律拒绝。 */
export function mediaKindFor(mime) {
  const text = String(mime ?? '').toLowerCase();
  if (text.startsWith('video/')) return 'video';
  if (text.startsWith('image/')) return 'image';
  return '';
}

export function extensionFor(mime) {
  return MIME_EXT[String(mime ?? '').toLowerCase()] ?? '';
}

/** 磁盘上的文件名：访问密钥 + 扩展名。 */
export function mediaFileName(accessKey, mime) {
  const ext = extensionFor(mime);
  return ext ? `${accessKey}.${ext}` : String(accessKey ?? '');
}

/** 生成一个不可猜测的访问密钥，媒体链接只靠它就能取到文件。 */
export function newAccessKey() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 把一段二进制写进上传目录，返回文件名（就是访问密钥加扩展名）。
 */
export function saveMediaFile(dataDir, userId, buffer, mime) {
  const ext = extensionFor(mime);
  const key = newAccessKey();
  const name = ext ? `${key}.${ext}` : key;
  const dir = path.join(uploadsDir(dataDir), String(userId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);
  return { name, key, ext };
}

/** 拼出磁盘上的路径，并挡住任何越界的文件名。 */
export function mediaFilePath(dataDir, userId, fileName) {
  const dir = path.join(uploadsDir(dataDir), String(userId));
  const resolved = path.resolve(dir, path.basename(String(fileName ?? '')));
  const base = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return null;
  return resolved;
}

export function removeMediaFile(dataDir, userId, fileName) {
  const filePath = mediaFilePath(dataDir, userId, fileName);
  if (!filePath) return false;
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function mimeForFile(fileName, fallback = 'application/octet-stream') {
  return EXT_MIME[path.extname(String(fileName ?? '')).toLowerCase()] ?? fallback;
}
