import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeviceSyncSettings, shouldSyncPath } from "./sync-settings";

test("shouldSyncPath skips excluded folders", () => {
  const settings = normalizeDeviceSyncSettings({ excludedFolders: ["private"] });
  assert.deepEqual(shouldSyncPath("private/a.md", settings), {
    sync: false,
    reason: "excluded folder: private"
  });
  assert.equal(shouldSyncPath("public/a.md", settings).sync, true);
});

test("shouldSyncPath respects attachment type toggles", () => {
  const settings = normalizeDeviceSyncSettings({
    attachmentTypes: { image: false, audio: true, video: true, pdf: false, unsupported: false }
  });
  assert.equal(shouldSyncPath("media/a.png", settings).sync, false);
  assert.equal(shouldSyncPath("media/a.pdf", settings).sync, false);
  assert.equal(shouldSyncPath("media/a.mp3", settings).sync, true);
  assert.equal(shouldSyncPath("notes/a.md", settings).sync, true);
});

test("shouldSyncPath keeps config sync disabled by default", () => {
  const settings = normalizeDeviceSyncSettings(undefined);
  assert.equal(shouldSyncPath(".obsidian/app.json", settings).sync, false);
  assert.equal(shouldSyncPath(".obsidian/plugins/demo/data.json", settings).sync, false);
});

test("shouldSyncPath allows selected config categories", () => {
  const settings = normalizeDeviceSyncSettings({
    configSync: {
      app: true,
      appearance: false,
      appearanceData: false,
      hotkey: false,
      corePlugin: false,
      corePluginData: false,
      communityPlugin: false,
      communityPluginData: true
    }
  });
  assert.equal(shouldSyncPath(".obsidian/app.json", settings).sync, true);
  assert.equal(shouldSyncPath(".obsidian/plugins/demo/data.json", settings).sync, true);
  assert.equal(shouldSyncPath(".obsidian/appearance.json", settings).sync, false);
});
