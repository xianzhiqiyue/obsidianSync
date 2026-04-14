export type SyncMode = "bidirectional" | "pull_only" | "mirror_remote";
export type ConflictStrategy = "merge" | "conflict_copy";

export interface AttachmentTypeSettings {
  image: boolean;
  audio: boolean;
  video: boolean;
  pdf: boolean;
  unsupported: boolean;
}

export interface ConfigSyncSettings {
  app: boolean;
  appearance: boolean;
  appearanceData: boolean;
  hotkey: boolean;
  corePlugin: boolean;
  corePluginData: boolean;
  communityPlugin: boolean;
  communityPluginData: boolean;
}

export interface DeviceSyncSettings {
  mode: SyncMode;
  conflictStrategy: ConflictStrategy;
  attachmentTypes: AttachmentTypeSettings;
  excludedFolders: string[];
  configSync: ConfigSyncSettings;
  configDir: string;
}

export interface SyncPathDecision {
  sync: boolean;
  reason?: string;
}

export const DEFAULT_ATTACHMENT_TYPE_SETTINGS: AttachmentTypeSettings = {
  image: true,
  audio: true,
  video: true,
  pdf: true,
  unsupported: true
};

export const DEFAULT_CONFIG_SYNC_SETTINGS: ConfigSyncSettings = {
  app: false,
  appearance: false,
  appearanceData: false,
  hotkey: false,
  corePlugin: false,
  corePluginData: false,
  communityPlugin: false,
  communityPluginData: false
};

export const DEFAULT_DEVICE_SYNC_SETTINGS: DeviceSyncSettings = {
  mode: "bidirectional",
  conflictStrategy: "merge",
  attachmentTypes: DEFAULT_ATTACHMENT_TYPE_SETTINGS,
  excludedFolders: [],
  configSync: DEFAULT_CONFIG_SYNC_SETTINGS,
  configDir: ".obsidian"
};

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "webm"]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"]);

export function normalizeDeviceSyncSettings(input: Partial<DeviceSyncSettings> | undefined): DeviceSyncSettings {
  return {
    ...DEFAULT_DEVICE_SYNC_SETTINGS,
    ...(input ?? {}),
    attachmentTypes: {
      ...DEFAULT_ATTACHMENT_TYPE_SETTINGS,
      ...(input?.attachmentTypes ?? {})
    },
    configSync: {
      ...DEFAULT_CONFIG_SYNC_SETTINGS,
      ...(input?.configSync ?? {})
    },
    excludedFolders: normalizeExcludedFolders(input?.excludedFolders ?? DEFAULT_DEVICE_SYNC_SETTINGS.excludedFolders),
    configDir: normalizeConfigDir(input?.configDir ?? DEFAULT_DEVICE_SYNC_SETTINGS.configDir)
  };
}

export function shouldSyncPath(path: string, settings: DeviceSyncSettings): SyncPathDecision {
  const normalizedPath = normalizePath(path);
  const excludedFolder = settings.excludedFolders.find((folder) => pathIsInsideFolder(normalizedPath, folder));
  if (excludedFolder) {
    return { sync: false, reason: `excluded folder: ${excludedFolder}` };
  }

  const configDir = normalizeConfigDir(settings.configDir);
  if (pathIsInsideFolder(normalizedPath, configDir)) {
    return shouldSyncConfigPath(normalizedPath, configDir, settings.configSync);
  }

  const attachmentType = classifyAttachmentType(normalizedPath);
  if (!attachmentType) {
    return { sync: true };
  }

  return settings.attachmentTypes[attachmentType]
    ? { sync: true }
    : { sync: false, reason: `attachment type disabled: ${attachmentType}` };
}

function shouldSyncConfigPath(path: string, configDir: string, configSync: ConfigSyncSettings): SyncPathDecision {
  const relative = path.slice(configDir.length + 1);
  const category = classifyConfigCategory(relative);
  if (!category) {
    return { sync: false, reason: "config category unsupported" };
  }

  return configSync[category]
    ? { sync: true }
    : { sync: false, reason: `config category disabled: ${category}` };
}

function classifyConfigCategory(relativePath: string): keyof ConfigSyncSettings | null {
  if (relativePath === "app.json") return "app";
  if (relativePath === "appearance.json" || relativePath === "themes.json") return "appearance";
  if (relativePath.startsWith("themes/") || relativePath.startsWith("snippets/")) return "appearanceData";
  if (relativePath === "hotkeys.json") return "hotkey";
  if (relativePath === "core-plugins.json") return "corePlugin";
  if (relativePath.startsWith("core-plugins/")) return "corePluginData";
  if (relativePath === "community-plugins.json") return "communityPlugin";
  if (relativePath.startsWith("plugins/")) return "communityPluginData";
  return null;
}

function classifyAttachmentType(path: string): keyof AttachmentTypeSettings | null {
  const extension = extensionOf(path);
  if (!extension || extension === "md" || extension === "canvas" || extension === "json") {
    return null;
  }
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (extension === "pdf") return "pdf";
  return "unsupported";
}

function extensionOf(path: string): string | null {
  const basename = path.split("/").pop() ?? path;
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) {
    return null;
  }
  return basename.slice(dotIndex + 1).toLowerCase();
}

function normalizePath(path: string): string {
  return path.replace(/\\+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeConfigDir(configDir: string): string {
  return normalizePath(configDir || DEFAULT_DEVICE_SYNC_SETTINGS.configDir);
}

function normalizeExcludedFolders(folders: string[]): string[] {
  return folders.map(normalizePath).filter((folder) => folder.length > 0);
}

function pathIsInsideFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}
