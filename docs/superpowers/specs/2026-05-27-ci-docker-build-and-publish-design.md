# CI Docker Build, Size Validator, and GHCR Publish

**Status:** Approved
**Date:** 2026-05-27
**Scope:** Add a CI workflow that builds the existing `Dockerfile`, validates per-platform image size against a fixed budget, and publishes multi-arch images to GitHub Container Registry (GHCR). No changes to the `Dockerfile`, `.dockerignore`, or `docker-compose.yml`.

## Goals

- Build the Docker image on every PR to catch Dockerfile/dependency breakage before merge.
- Publish multi-arch (`linux/amd64` + `linux/arm64`) images to `ghcr.io/jmrl23/snow-mcp` on pushes to `main` and on version tags (`v*`).
- Fail the build if either platform's image exceeds **250MB uncompressed** so regressions surface as a PR check.
- Make the published image visible on the GitHub repo's "Packages" sidebar via OCI labels.

## Non-Goals

- No image scanning (Trivy/Grype) — possible follow-up.
- No SBOM / build attestations — possible follow-up.
- No image signing (cosign) — possible follow-up.
- No changes to the `Dockerfile`, `.dockerignore`, or `docker-compose.yml`.
- No automatic git tag / release creation.
- No replacement or modification of the existing `ci.yml` (lint/typecheck/test). The new workflow is separate and runs alongside it.

## Triggers

```
on:
  push:
    branches: [main]
    tags:     ['v*']
  pull_request:
```

Behavior matrix:

| Event               | Build | Push to GHCR | Tags produced                                    |
| ------------------- | :---: | :----------: | ------------------------------------------------ |
| `pull_request`      |  yes  |    **no**    | none (build is verification only)                |
| `push` to `main`    |  yes  |     yes      | `main`, `sha-<short>`, `latest` (default branch) |
| `push` tag `v1.2.3` |  yes  |     yes      | `1.2.3`, `1.2`, `1`, `latest`, `sha-<short>`     |

PRs from forks do not have access to `GITHUB_TOKEN` with `packages: write`, so the login + push steps are guarded by `if: github.event_name != 'pull_request'` and silently skipped on PRs (the build + size check still runs).

## Workflow Structure

File: `.github/workflows/docker.yml`

Single job `docker` on `ubuntu-latest` with these steps in order:

1. **Checkout** — `actions/checkout@v4`.
2. **QEMU setup** — `docker/setup-qemu-action@v3` (needed for arm64 emulation on amd64 runner).
3. **Buildx setup** — `docker/setup-buildx-action@v3`.
4. **Compute metadata** — `docker/metadata-action@v5`:
   - `images: ghcr.io/${{ github.repository }}` (resolves to `ghcr.io/jmrl23/snow-mcp`).
   - Default tag set: `latest` on default branch, branch name, PR ref, `sha-<short>`, and semver from git tags (`{{version}}`, `{{major}}.{{minor}}`, `{{major}}`).
   - Labels: `metadata-action` emits the standard OCI label set, including `org.opencontainers.image.source` (links the package to the repo), `revision`, and `created`. A `labels:` input to the action adds `org.opencontainers.image.description=Read-only MCP server exposing a ServiceNow instance to MCP clients` and `org.opencontainers.image.licenses=MIT`.
5. **Login to GHCR** — `docker/login-action@v3` with `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`. Guarded by `if: github.event_name != 'pull_request'`.
6. **Build (and push)** — `docker/build-push-action@v6`:
   - `context: .`
   - `platforms: linux/amd64,linux/arm64`
   - `push: ${{ github.event_name != 'pull_request' }}`
   - `tags: ${{ steps.meta.outputs.tags }}`
   - `labels: ${{ steps.meta.outputs.labels }}`
   - `cache-from: type=gha`
   - `cache-to: type=gha,mode=max`
   - `provenance: false` (avoids extra unrelated layers in the index; can revisit when adding attestations).
   - `metadata-file: /tmp/docker-meta.json` so the next step can read the resulting image digest.
7. **Validate per-platform size** — inline bash step (see "Size Validator" below). Reads `/tmp/docker-meta.json` for the image reference, queries each platform's manifest via `docker buildx imagetools inspect --raw`, sums `layers[].size`, prints both platforms to the job summary, and `exit 1` if either platform exceeds `MAX_IMAGE_SIZE_BYTES`.
8. **Write job summary** — small markdown block to `$GITHUB_STEP_SUMMARY` showing per-platform size in MB, tags published (or "none — PR build"), and the image digest. This step always runs (`if: always()`) so a size failure still produces the summary.

### Permissions

```
permissions:
  contents: read
  packages: write
```

`packages: write` is required at the job level for the GHCR push; it is unused on PRs from forks (which only get read scopes anyway).

### Concurrency

```
concurrency:
  group: docker-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Cancel superseded PR builds; never cancel a `main` or tag build (we want every published version's run to finish).

## Size Validator

Constants at the top of the job:

```
env:
  MAX_IMAGE_SIZE_BYTES: 262144000  # 250 MB (250 * 1024 * 1024)
```

Algorithm (run inline in bash):

1. Read the top-level image reference from `/tmp/docker-meta.json` (produced by `build-push-action`). On PRs (no push), buildx still writes the manifest digest to this file because the build output goes to the buildx cache.
2. Run `docker buildx imagetools inspect <ref> --raw | jq -r '.manifests[] | "\(.platform.os)/\(.platform.architecture) \(.digest)"'` to enumerate per-platform manifest digests.
3. For each `<os>/<arch> <digest>` pair: `docker buildx imagetools inspect <ref>@<digest> --raw | jq '[.layers[].size] | add'` gives total uncompressed layer bytes for that platform.
4. Print a line per platform: `linux/amd64: 198.3 MB` etc.
5. Compare each platform's size against `MAX_IMAGE_SIZE_BYTES`. If any exceeds, print which one and by how much, and `exit 1`.

**Why uncompressed layer sum?** It is what the registry reports and is the closest stable proxy for "how much disk does this consume after pull." Compressed sizes vary with registry compression settings and aren't queryable from `imagetools inspect`.

**Why a fixed threshold rather than a delta?** Simpler to implement, no baseline state needed, and 250MB has enough headroom over the current realistic ~200MB image that it only fails on meaningful regressions (new heavy dep, base image swap).

## Image Visibility on the GitHub Repo

GHCR packages default to **private** on first publish. To expose the image on the repo's Packages sidebar publicly:

1. After the first successful publish (after merging the PR that adds this workflow), navigate to:
   `https://github.com/jmrl23/snow-mcp/pkgs/container/snow-mcp`
2. **Package settings → Danger Zone → Change visibility → Public.**
3. **Package settings → Manage Actions access → Add Repository → snow-mcp → Role: Write.** (Usually already linked via the OCI `source` label, but confirm.)

This is a one-time manual step per package. The workflow itself cannot flip visibility because `GITHUB_TOKEN` lacks the required scope; doing it via API requires a user-scoped PAT, which is not appropriate to store in repo secrets for this purpose.

The `org.opencontainers.image.source` label (auto-emitted by `metadata-action`) is what tells GitHub to display the package on the repo page once visibility allows it.

## File Changes

| Path                           | Change                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/docker.yml` | **new** workflow file                                                                                                                                                                                                             |
| `README.md`                    | add a "Container image" subsection under the existing Docker section: `docker pull ghcr.io/jmrl23/snow-mcp:latest`, supported tags (`latest`, `main`, `vX.Y.Z`, `sha-*`), and supported platforms (`linux/amd64`, `linux/arm64`). |

No other files change. The existing `.github/workflows/ci.yml`, `Dockerfile`, `.dockerignore`, and `docker-compose.yml` are untouched.

## Testing Plan

The workflow itself has no unit tests (it is a CI configuration). Validation is empirical:

1. **PR build (this work's own PR):**
   - The `docker` job runs.
   - Build succeeds for both `linux/amd64` and `linux/arm64`.
   - Size validator prints both platforms to the job summary and passes.
   - No push step runs (login is skipped, build-push-action's `push: false`).
   - Verify in the Actions UI that no image was published.
2. **First push to `main` (after merge):**
   - The `docker` job runs and pushes.
   - `ghcr.io/jmrl23/snow-mcp:main`, `:latest`, and `:sha-<short>` exist.
   - The package appears in the repo's Packages sidebar (after the one-time visibility flip).
3. **Tag push (separate, manual, out-of-scope-but-documented):**
   - `git tag v1.2.0 && git push origin v1.2.0` produces `:1.2.0`, `:1.2`, `:1`, `:latest`, `:sha-<short>`.
4. **Size regression simulation (optional):**
   - Temporarily set `MAX_IMAGE_SIZE_BYTES` to a value below the current image (e.g., 100MB) on a throwaway branch and confirm the job fails with a clear message. Revert.

## Risks and Mitigations

| Risk                                                                                      | Mitigation                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QEMU arm64 emulation is slow (~5–10 min build per arch).                                  | Acceptable for now; can switch to a native arm64 runner or matrix split if it becomes a bottleneck.                                                                                                                                                                                               |
| GHA cache eviction makes cold builds slow.                                                | `cache-to: type=gha,mode=max` keeps all layers; first cold build after eviction will be slow but subsequent ones recover.                                                                                                                                                                         |
| Size budget is too tight and blocks routine dep upgrades.                                 | 250MB has ~50MB headroom over current ~200MB. If false alarms appear, the budget is a single env var in `docker.yml` and easy to raise via PR (forcing a deliberate review).                                                                                                                      |
| First-time GHCR push is private; nothing visible on repo page.                            | Documented one-time visibility flip in this spec and in the PR description.                                                                                                                                                                                                                       |
| PRs from forks cannot login to GHCR.                                                      | Login + push steps are guarded by `if: github.event_name != 'pull_request'`; build + validator still run, giving fork PRs the same Dockerfile-correctness signal as internal PRs.                                                                                                                 |
| `metadata-file` from `build-push-action` may not contain an image ref when `push: false`. | Verified: `build-push-action` writes the digest to the metadata file even on local-only builds because buildx records the manifest in its cache. If this proves incorrect during implementation, fall back to `outputs: type=image,push=false,push-by-digest=true` to force a manifest reference. |

## Follow-ups (deliberately deferred)

- Add Trivy/Grype vulnerability scan as a parallel step.
- Add SBOM (`sbom: true`) and build attestations (`provenance: mode=max`) once GHCR's index format is confirmed to play well with the multi-arch index.
- Add cosign signing once a signing key strategy is decided.
- Switch arm64 to a native runner if buildx + QEMU emulation becomes a wall-clock pain point.
