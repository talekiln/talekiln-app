#!/usr/bin/env bash
# CI 用：起一个一次性的 S3 兼容服务给 packages/local/test/backup.live.test.js。
# 优先真 MinIO（quay.io 镜像 → dl.min.io 二进制），都拉不到时退到 SeaweedFS 的 S3 网关（GitHub Release，鉴权代码源自 MinIO）。
# 账号口令只用于本次一次性进程，不是任何真实环境的凭据。
set -euo pipefail
PORT="${S3_PORT:-9000}"
USER_="${S3_USER:-ci}"
PASS_="${S3_PASS:-ci-throwaway-minio}"
WORK="${RUNNER_TEMP:-/tmp}/s3-server"
mkdir -p "$WORK/data"

wait_http() { # $1=url
  for i in $(seq 1 30); do
    if curl -fsS "$1" >/dev/null 2>&1; then echo "s3 server up after $i tries"; return 0; fi
    sleep 2
  done
  return 1
}

try_minio_docker() {
  for IMAGE in quay.io/minio/minio:latest minio/minio:latest; do
    if docker pull "$IMAGE" >/dev/null 2>&1; then
      docker run -d --name minio -p "$PORT:9000" -e MINIO_ROOT_USER="$USER_" -e MINIO_ROOT_PASSWORD="$PASS_" "$IMAGE" server /data >/dev/null
      wait_http "http://127.0.0.1:$PORT/minio/health/live" && { echo "S3_SERVER=minio-docker ($IMAGE)"; return 0; }
      docker rm -f minio >/dev/null 2>&1 || true
    fi
  done
  return 1
}

try_minio_binary() {
  curl -fsSL --retry 2 -o "$WORK/minio" https://dl.min.io/server/minio/release/linux-amd64/minio || return 1
  chmod +x "$WORK/minio"
  MINIO_ROOT_USER="$USER_" MINIO_ROOT_PASSWORD="$PASS_" nohup "$WORK/minio" server "$WORK/data" --address ":$PORT" >"$WORK/minio.log" 2>&1 &
  wait_http "http://127.0.0.1:$PORT/minio/health/live" && { echo "S3_SERVER=minio-binary"; return 0; }
  return 1
}

try_seaweedfs() {
  local ver="${SEAWEEDFS_VERSION:-3.80}"
  curl -fsSL --retry 2 -o "$WORK/weed.tgz" "https://github.com/seaweedfs/seaweedfs/releases/download/$ver/linux_amd64.tar.gz" || return 1
  tar -xzf "$WORK/weed.tgz" -C "$WORK"
  cat >"$WORK/s3.json" <<JSON
{"identities":[{"name":"$USER_","credentials":[{"accessKey":"$USER_","secretKey":"$PASS_"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
  nohup "$WORK/weed" server -ip=127.0.0.1 -dir="$WORK/data" -filer -s3 -s3.port="$PORT" -s3.config="$WORK/s3.json" >"$WORK/weed.log" 2>&1 &
  # SeaweedFS 没有 /minio/health/live；S3 根路径匿名访问会回 403，端口通了即可
  for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then echo "s3 server up after $i tries"; echo "S3_SERVER=seaweedfs-$ver"; return 0; fi
    sleep 2
  done
  return 1
}

try_minio_docker || try_minio_binary || try_seaweedfs || { echo "no S3 server could be started"; exit 1; }
