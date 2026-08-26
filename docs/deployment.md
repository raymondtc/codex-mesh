# Docker deployment

## Release channels

- `develop` is the integration branch. Every push publishes `ghcr.io/raymondtc/codex-mesh:dev` and an immutable `dev-sha-<commit>` tag.
- `main` contains stable code. Merges to `main` run CI but do not publish a mutable image.
- An annotated `vMAJOR.MINOR.PATCH` tag on `main` publishes the version, major/minor aliases, `stable`, and `latest`.
- Prerelease tags such as `v1.2.0-rc.1` publish only their exact semantic version and never move `stable` or `latest`.

Changes should enter `develop` through a pull request, soak on the `dev` image, and then be merged from `develop` to `main`. Stable releases are cut from `main`. Protect both branches and require the `CI / verify` check; require reviews on `main`.

## Pull a published image

Copy `deploy/compose.yml` and create `.env` beside the repository root or pass it explicitly:

```bash
cp .env.example .env
docker login ghcr.io                    # only needed while the package is private
docker compose --env-file .env -f deploy/compose.yml pull
docker compose --env-file .env -f deploy/compose.yml up -d
docker compose --env-file .env -f deploy/compose.yml ps
```

Development is the default. Pin an immutable development build when diagnosing a deployment:

```bash
CODEX_MESH_IMAGE=ghcr.io/raymondtc/codex-mesh:dev-sha-abcdef0 docker compose --env-file .env -f deploy/compose.yml up -d
```

For stable deployments set one of:

```dotenv
CODEX_MESH_IMAGE=ghcr.io/raymondtc/codex-mesh:stable
# Prefer an immutable release in production:
# CODEX_MESH_IMAGE=ghcr.io/raymondtc/codex-mesh:1.2.3
```

An upgrade is `docker compose pull && docker compose up -d`. Database migrations run at startup. Keep the `codex-mesh-data` volume and back it up before stable upgrades.

## Build locally

```bash
docker build -t codex-mesh:local .
docker compose --env-file .env -f deploy/compose.yml -f deploy/compose.build.yml up -d --build
```

The HTTP service is bound to `127.0.0.1:${CODEX_MESH_PORT:-18787}` and should be placed behind an HTTPS reverse proxy. The optional reverse SSH relay listens on `${CODEX_MESH_RELAY_PORT:-2222}`; it is SSH, not HTTP, and therefore cannot share an ordinary HTTPS virtual host on port 443 without a TCP protocol multiplexer.

Generate deployment secrets once:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # SSH_KEY_ENCRYPTION_KEY
ssh-keygen -t ed25519 -N '' -f ./relay_host_ed25519
sudo chown 1000:1000 ./relay_host_ed25519 # runtime image's non-root node user
chmod 600 ./relay_host_ed25519
```

Set `BETTER_AUTH_URL` and `TRUSTED_ORIGINS` to the public HTTPS origin. When enabling the relay, set `RELAY_ENABLED=1`, `RELAY_PUBLIC_HOST`, and `RELAY_HOST_KEY_FILE` to the persistent private host-key path.

The Relay key bind mount must be readable by UID/GID `1000:1000`, used by the image's non-root `node` account. Keep it mode `0600`; do not make the private key world-readable.

## Stable release

After CI passes on `main`:

```bash
git switch main
git pull --ff-only
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

GitHub Actions builds Linux AMD64 and ARM64 images, attaches OCI metadata, provenance and an SBOM, then pushes them to GHCR using the repository-scoped `GITHUB_TOKEN`.
