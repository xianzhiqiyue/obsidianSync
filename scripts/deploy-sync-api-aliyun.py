#!/usr/bin/env python3
import argparse
import os
import shlex
import sys
import tarfile
import tempfile
import time
from pathlib import Path


DEFAULT_SKILL_DIRS = [
    Path.home() / ".agents" / "skills" / "server-manager",
    Path.home() / ".codex" / "skills" / "server-manager",
]

DEPLOY_INCLUDE_PATHS = [
    "package.json",
    "package-lock.json",
    "tsconfig.base.json",
    "apps/sync-api/package.json",
    "apps/sync-api/tsconfig.json",
    "apps/sync-api/src",
    "apps/sync-api/migrations",
    "packages/shared/package.json",
    "packages/shared/tsconfig.json",
    "packages/shared/src",
]


def resolve_skill_dir() -> Path:
    raw = os.getenv("SKILL_DIR")
    if raw:
      candidate = Path(raw).expanduser()
      if (candidate / "main.py").exists():
          return candidate

    for candidate in DEFAULT_SKILL_DIRS:
        if (candidate / "main.py").exists():
            return candidate

    raise SystemExit("server-manager skill not found; set SKILL_DIR to the installed skill directory")


def build_archive(repo_root: Path) -> Path:
    for rel in DEPLOY_INCLUDE_PATHS:
        if not (repo_root / rel).exists():
            raise SystemExit(f"required path missing: {rel}")

    temp_dir = Path(tempfile.mkdtemp(prefix="obsidian-sync-deploy-"))
    archive_path = temp_dir / f"sync-api-deploy-{int(time.time())}.tar.gz"
    with tarfile.open(archive_path, "w:gz") as tar:
        for rel in DEPLOY_INCLUDE_PATHS:
            tar.add(repo_root / rel, arcname=rel)
    return archive_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Deploy sync-api to the configured 阿里云 server")
    parser.add_argument("--server", default="阿里云")
    parser.add_argument("--remote-dir", default="/home/admin/obsidianSync")
    parser.add_argument("--remote-user", default="admin")
    parser.add_argument("--health-url", default="http://127.0.0.1:3000/api/v1/health")
    parser.add_argument("--ready-url", default="http://127.0.0.1:3000/api/v1/ready")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    skill_dir = resolve_skill_dir()
    sys.path.insert(0, str(skill_dir))
    from src.ssh_client import SSHClient  # type: ignore

    client = SSHClient(args.server)
    archive_path = build_archive(repo_root)
    remote_archive = f"/tmp/{archive_path.name}"

    print(f"Packaging deploy archive: {archive_path}")
    ok, output = client.copy_files(str(archive_path), remote_archive)
    if not ok:
        print(output)
        return 1

    remote_dir = shlex.quote(args.remote_dir)
    remote_user = shlex.quote(args.remote_user)
    remote_archive_q = shlex.quote(remote_archive)
    health_url = shlex.quote(args.health_url)
    ready_url = shlex.quote(args.ready_url)

    remote_cmd = f"""
set -euo pipefail
REMOTE_DIR={remote_dir}
REMOTE_ARCHIVE={remote_archive_q}
RUN_DIR="$REMOTE_DIR/run"
LOG_DIR="$REMOTE_DIR/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"
chown -R {remote_user}:{remote_user} "$REMOTE_DIR"
su - {remote_user} -c 'mkdir -p "$HOME"/obsidianSync'
su - {remote_user} -c 'tar xzf {remote_archive_q} -C {remote_dir}'
su - {remote_user} -c 'cd {remote_dir} && npm install && npm run --workspace @obsidian-sync/shared build && npm run --workspace @obsidian-sync/sync-api build'
if [ -f "$RUN_DIR/sync-api.pid" ]; then
  PID="$(cat "$RUN_DIR/sync-api.pid" || true)"
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
  fi
fi
for _ in $(seq 1 15); do
  if ! ss -ltn | grep -q ':3000 '; then
    break
  fi
  sleep 1
done
if ss -ltn | grep -q ':3000 '; then
  PIDS="$(ss -ltnp | awk -F'pid=' '/:3000 /{{split($2,a,","); print a[1]}}' | sort -u | tr '\n' ' ')"
  if [ -n "$PIDS" ]; then
    echo "stopping stale sync-api listener pids: $PIDS"
    kill $PIDS 2>/dev/null || true
  fi
fi
for _ in $(seq 1 10); do
  if ! ss -ltn | grep -q ':3000 '; then
    break
  fi
  sleep 1
done
if ss -ltn | grep -q ':3000 '; then
  echo "port 3000 is still busy after stale listener stop attempt" >&2
  ss -ltnp | grep ':3000 ' >&2 || true
  exit 1
fi
su - {remote_user} -c 'cd {remote_dir}/apps/sync-api && setsid /usr/bin/node dist/index.js >> {remote_dir}/logs/sync-api.log 2>&1 < /dev/null &'
sleep 2
NODE_PID="$(ss -ltnp | awk -F'pid=' '/:3000 /{{split($2,a,","); print a[1]; exit}}')"
if [ -z "$NODE_PID" ]; then
  echo "sync-api did not start listening on port 3000" >&2
  tail -80 "$LOG_DIR/sync-api.log" >&2 || true
  exit 1
fi
echo "$NODE_PID" > "$RUN_DIR/sync-api.pid"
curl -fsS {health_url}
echo
curl -fsS {ready_url}
rm -f "$REMOTE_ARCHIVE"
"""
    ok, output = client.execute_raw(remote_cmd)
    print(output)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
