#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE=/opt/codex-mesh/runtime/compose.yml
ENV_FILE=/opt/codex-mesh/.env
IMAGE_REPOSITORY=ghcr.io/raymondtc/codex-mesh
CONTAINER=codex-mesh-server-1
LOCK_FILE=/run/lock/codex-mesh-dev-deploy.lock

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another Codex Mesh deployment is already running" >&2
  exit 1
fi

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

wait_for_health() {
  local attempts=${1:-60}
  local state
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || true)
    case "$state" in
      healthy) return 0 ;;
      unhealthy|exited|dead) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

previous_image=$(docker image inspect "${IMAGE_REPOSITORY}:dev" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)
echo "Pulling ${IMAGE_REPOSITORY}:dev"
compose pull server
compose up -d --remove-orphans server

if wait_for_health 60; then
  deployed_image=$(docker inspect --format '{{.Image}}' "$CONTAINER")
  echo "Codex Mesh development deployment is healthy: $deployed_image"
  exit 0
fi

echo "Deployment failed health checks" >&2
docker logs --tail 200 "$CONTAINER" >&2 || true

if [[ "$previous_image" =~ ^${IMAGE_REPOSITORY}@sha256:[0-9a-f]{64}$ ]]; then
  echo "Rolling back to ${previous_image}" >&2
  CODEX_MESH_IMAGE="$previous_image" compose up -d --remove-orphans server
  if wait_for_health 60; then
    echo "Rollback succeeded" >&2
  else
    echo "Rollback also failed" >&2
  fi
else
  echo "No previous image digest was available for rollback" >&2
fi
exit 1
