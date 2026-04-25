const LEGACY_CONFLICT_COPY_MARKER = ".conflict-";
const OFFICIAL_CONFLICT_COPY_PATTERN = / \(Conflicted copy .+ \d{12}\)(?=\.[^./]+$|$)/;

export function isConflictCopyPath(path: string): boolean {
  return path.includes(LEGACY_CONFLICT_COPY_MARKER) || OFFICIAL_CONFLICT_COPY_PATTERN.test(path);
}

export function buildConflictCopyPath(path: string, deviceName: string, now = new Date()): string {
  const sanitizedDeviceName = sanitizeDeviceName(deviceName);
  const timestamp = formatConflictTimestamp(now);
  const slashIndex = path.lastIndexOf("/");
  const folder = slashIndex >= 0 ? `${path.slice(0, slashIndex + 1)}` : "";
  const basename = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${folder}${basename} (Conflicted copy ${sanitizedDeviceName} ${timestamp})`;
  }

  return `${folder}${basename.slice(0, dotIndex)} (Conflicted copy ${sanitizedDeviceName} ${timestamp})${basename.slice(dotIndex)}`;
}

function sanitizeDeviceName(deviceName: string): string {
  const sanitized = deviceName.replace(/[\\/:*?"<>|]/g, "-").trim();
  return sanitized.length > 0 ? sanitized : "device";
}

function formatConflictTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join("");
}
