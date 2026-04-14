import DiffMatchPatch from "diff-match-patch";

export interface TextMergeResult {
  merged: string;
  clean: boolean;
}

export function mergeMarkdownText(base: string, local: string, remote: string): TextMergeResult {
  if (local === remote) {
    return { merged: local, clean: true };
  }
  if (local === base) {
    return { merged: remote, clean: true };
  }
  if (remote === base) {
    return { merged: local, clean: true };
  }

  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 1;
  const patches = dmp.patch_make(base, local);
  const [merged, applied] = dmp.patch_apply(patches, remote) as [string, boolean[]];
  return {
    merged,
    clean: applied.every(Boolean)
  };
}
