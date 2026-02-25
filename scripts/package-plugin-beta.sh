#!/usr/bin/env bash
set -euo pipefail

RELEASES_DIR="${RELEASES_DIR:-releases}"
RELEASE_TAG="${RELEASE_TAG:-beta-$(date -u +%Y%m%dT%H%M%SZ)}"
PLUGIN_DIST_DIR="${PLUGIN_DIST_DIR:-apps/obsidian-plugin/dist}"
SKIP_BUILD="${SKIP_BUILD:-0}"

if [ "$SKIP_BUILD" != "1" ]; then
  npm run --workspace @obsidian-sync/plugin build
fi

if [ ! -f "$PLUGIN_DIST_DIR/manifest.json" ]; then
  echo "manifest not found: $PLUGIN_DIST_DIR/manifest.json" >&2
  exit 1
fi
if [ ! -f "$PLUGIN_DIST_DIR/main.js" ]; then
  echo "main.js not found: $PLUGIN_DIST_DIR/main.js" >&2
  exit 1
fi
if [ ! -f "$PLUGIN_DIST_DIR/styles.css" ]; then
  echo "styles.css not found: $PLUGIN_DIST_DIR/styles.css" >&2
  exit 1
fi

plugin_id="$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.id||"");' "$PLUGIN_DIST_DIR/manifest.json")"
plugin_version="$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.version||"");' "$PLUGIN_DIST_DIR/manifest.json")"

if [ -z "$plugin_id" ] || [ -z "$plugin_version" ]; then
  echo "invalid manifest: missing id/version" >&2
  exit 1
fi

release_root="$RELEASES_DIR/$RELEASE_TAG"
plugin_release_dir="$release_root/plugin"
plugin_bundle_dir="$plugin_release_dir/$plugin_id"
zip_file="$plugin_release_dir/${plugin_id}-${plugin_version}-${RELEASE_TAG}.zip"
sha_file="${zip_file}.sha256"
meta_file="$release_root/release-meta.json"

mkdir -p "$plugin_bundle_dir"
cp "$PLUGIN_DIST_DIR/main.js" "$plugin_bundle_dir/main.js"
cp "$PLUGIN_DIST_DIR/manifest.json" "$plugin_bundle_dir/manifest.json"
cp "$PLUGIN_DIST_DIR/styles.css" "$plugin_bundle_dir/styles.css"

if command -v zip >/dev/null 2>&1; then
  (cd "$plugin_bundle_dir" && zip -q -r "$PWD/../$(basename "$zip_file")" main.js manifest.json styles.css)
elif command -v ditto >/dev/null 2>&1; then
  # macOS fallback; package the three files at zip root.
  tmp_zip_dir="$plugin_release_dir/.zip-tmp-$plugin_id"
  rm -rf "$tmp_zip_dir"
  mkdir -p "$tmp_zip_dir"
  cp "$plugin_bundle_dir/main.js" "$tmp_zip_dir/main.js"
  cp "$plugin_bundle_dir/manifest.json" "$tmp_zip_dir/manifest.json"
  cp "$plugin_bundle_dir/styles.css" "$tmp_zip_dir/styles.css"
  ditto -c -k "$tmp_zip_dir" "$zip_file"
  rm -rf "$tmp_zip_dir"
else
  echo "zip/ditto not found; cannot create zip artifact" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$zip_file" > "$sha_file"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$zip_file" > "$sha_file"
else
  echo "shasum/sha256sum not found; skip checksum" >&2
fi

cat > "$meta_file" <<JSON
{
  "releaseTag": "$RELEASE_TAG",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "plugin": {
    "id": "$plugin_id",
    "version": "$plugin_version",
    "distDir": "$PLUGIN_DIST_DIR",
    "bundleDir": "$plugin_bundle_dir",
    "zip": "$zip_file",
    "sha256": "$sha_file"
  }
}
JSON

echo "BETA_RELEASE_TAG=$RELEASE_TAG"
echo "BETA_PLUGIN_ID=$plugin_id"
echo "BETA_PLUGIN_VERSION=$plugin_version"
echo "BETA_PLUGIN_BUNDLE_DIR=$plugin_bundle_dir"
echo "BETA_PLUGIN_ZIP=$zip_file"
echo "BETA_RELEASE_META=$meta_file"
