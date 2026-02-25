export const SUPPORTED_PLATFORMS = [
  "macos",
  "windows",
  "android",
  "ios",
  "linux",
  "unknown"
] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];
