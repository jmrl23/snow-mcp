# CI Docker Build, Size Validator, and GHCR Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions workflow that builds the existing `Dockerfile` on every PR, validates per-platform image size against a 250MB uncompressed budget, publishes multi-arch images (`linux/amd64` + `linux/arm64`) to `ghcr.io/jmrl23/snow-mcp` on pushes to `main` and on `v*` tags, and surfaces the image on the GitHub repo's Packages sidebar.

**Architecture:** A single workflow file `.github/workflows/docker.yml` runs in parallel with the existing `ci.yml`. Two conditional `docker/build-push-action` steps share the same inputs: PR builds emit only an OCI tar, push events emit the OCI tar AND push to GHCR. The size validator step is inline bash that untars `/tmp/image.oci.tar`, walks `index.json` → per-platform manifest blobs, sums `layers[].size`, prints a job-summary table, and `exit 1` if any platform exceeds `MAX_IMAGE_SIZE_BYTES`. README gets a "Container image" subsection documenting the published tags.

**Tech Stack:** GitHub Actions, `docker/setup-qemu-action@v3`, `docker/setup-buildx-action@v3`, `docker/metadata-action@v5`, `docker/login-action@v3`, `docker/build-push-action@v6`, GitHub Container Registry (GHCR), inline bash + `jq` + `awk`.

**Spec:** [`docs/superpowers/specs/2026-05-27-ci-docker-build-and-publish-design.md`](../specs/2026-05-27-ci-docker-build-and-publish-design.md)

**Branch:** `feat/ci-docker` (single branch; all tasks land here, PR'd back to `main`).

---

## Branch: `feat/ci-docker`

### Task 1: Create branch and add `.github/workflows/docker.yml`

**Files:**

- Create: `.github/workflows/docker.yml`

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/ci-docker
```

- [ ] **Step 2: Create the workflow file**

Write `.github/workflows/docker.yml` with the following exact content:

````yaml
name: docker

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:

permissions:
  contents: read
  packages: write

concurrency:
  group: docker-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}
  # 250 MB uncompressed per platform (250 * 1024 * 1024).
  MAX_IMAGE_SIZE_BYTES: '262144000'
  OCI_TAR: /tmp/image.oci.tar

jobs:
  docker:
    name: build + size + publish
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Compute image metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          labels: |
            org.opencontainers.image.description=Read-only MCP server exposing a ServiceNow instance to MCP clients
            org.opencontainers.image.licenses=MIT

      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build (PR — OCI tar only, no push)
        if: github.event_name == 'pull_request'
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: false
          outputs: type=oci,dest=${{ env.OCI_TAR }}

      - name: Build and push (main / tag — OCI tar + registry)
        if: github.event_name != 'pull_request'
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: false
          outputs: |
            type=oci,dest=${{ env.OCI_TAR }}
            type=registry

      - name: Validate per-platform image size
        id: size
        run: |
          set -euo pipefail

          WORK=/tmp/oci
          rm -rf "$WORK" && mkdir "$WORK"
          tar -xf "$OCI_TAR" -C "$WORK"

          MAX="$MAX_IMAGE_SIZE_BYTES"
          BUDGET_MB=$(awk -v b="$MAX" 'BEGIN{ printf "%.0f", b/1024/1024 }')
          FAILED=0

          {
            echo "## Image size report"
            echo
            echo "| Platform | Uncompressed | Budget | Status |"
            echo "| --- | ---: | ---: | :---: |"
          } >> "$GITHUB_STEP_SUMMARY"

          # index.json lists per-platform manifests. Skip attestation/unknown entries.
          jq -r '
            .manifests[]
            | select(.platform.os == "linux" and .platform.architecture != "unknown")
            | "\(.platform.os)/\(.platform.architecture)\t\(.digest)"
          ' "$WORK/index.json" > /tmp/platforms.tsv

          if [ ! -s /tmp/platforms.tsv ]; then
            echo "::error::No linux/* platform manifests found in OCI archive"
            exit 1
          fi

          while IFS=$'\t' read -r PLATFORM DIGEST; do
            HEX="${DIGEST#sha256:}"
            BLOB="$WORK/blobs/sha256/$HEX"
            if [ ! -f "$BLOB" ]; then
              echo "::error::Manifest blob missing for $PLATFORM ($DIGEST)"
              exit 1
            fi
            BYTES=$(jq '[.layers[].size] | add' "$BLOB")
            MB=$(awk -v b="$BYTES" 'BEGIN{ printf "%.1f", b/1024/1024 }')
            if [ "$BYTES" -gt "$MAX" ]; then
              STATUS="FAIL"
              FAILED=1
            else
              STATUS="OK"
            fi
            echo "${PLATFORM}: ${MB} MB (budget ${BUDGET_MB} MB) ${STATUS}"
            echo "| \`${PLATFORM}\` | ${MB} MB | ${BUDGET_MB} MB | ${STATUS} |" >> "$GITHUB_STEP_SUMMARY"
          done < /tmp/platforms.tsv

          if [ "$FAILED" -ne 0 ]; then
            echo "::error::At least one platform exceeded the ${BUDGET_MB} MB budget"
            exit 1
          fi

      - name: Write tag summary
        if: always()
        env:
          META_TAGS: ${{ steps.meta.outputs.tags }}
          EVENT: ${{ github.event_name }}
        run: |
          set -euo pipefail
          {
            echo
            echo "## Tags"
            if [ "$EVENT" = "pull_request" ]; then
              echo "_PR build — no tags pushed._"
            else
              echo '```'
              printf '%s\n' "$META_TAGS"
              echo '```'
            fi
          } >> "$GITHUB_STEP_SUMMARY"
````

- [ ] **Step 3: Validate the YAML parses**

Run:

```bash
node -e "const fs=require('node:fs');const yaml=require('yaml');yaml.parse(fs.readFileSync('.github/workflows/docker.yml','utf8'));console.log('ok')"
```

Expected: prints `ok` and exits 0.

If `yaml` is not installed (the repo doesn't depend on it directly), use this `python3` fallback (Ubuntu/WSL ships with PyYAML out of the box, but if not present, install with `pip install --user pyyaml` first):

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/docker.yml')); print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 4: Run actionlint against the workflow**

actionlint is the de-facto GitHub Actions linter; running via Docker avoids any local install:

```bash
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color .github/workflows/docker.yml
```

Expected: exits 0 with no output. If actionlint reports an issue, fix the workflow before continuing — common false positives are shellcheck SC2086 inside `run:` blocks; those can be silenced by quoting variables (the workflow above already does so).

If Docker is unavailable in the environment, skip this step and rely on GitHub's own workflow validation when the branch is pushed.

- [ ] **Step 5: Verify the existing project still passes its checks**

Run:

```bash
yarn install --frozen-lockfile && yarn typecheck && yarn lint && yarn test
```

Expected: all four commands exit 0; the workflow change is config-only and must not break any existing check.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/docker.yml
git commit -m "ci(docker): add multi-arch build, size validator, and GHCR publish workflow"
```

### Task 2: Document the published image in `README.md`

**Files:**

- Modify: `README.md` — append a "Container image" subsection inside the existing `## Docker` section (after the `### Use a different port` subsection, before `### Updating tables of project layout`).

- [ ] **Step 1: Locate the insertion point**

Run:

```bash
grep -n "^### Updating tables of project layout" README.md
```

Expected: prints one line, something like `504:### Updating tables of project layout`. The new subsection goes immediately before this line.

- [ ] **Step 2: Insert the "Container image" subsection**

The snippet contains a triple-backtick code block, so embedding it inline in this plan would require nested fences (which Prettier collapses). Instead, run the following Bash script **verbatim** from the repo root — it constructs the snippet via a heredoc with a unique sentinel (no nested fences inside the plan), then inserts it before `### Updating tables of project layout`:

````bash
python3 - <<'PY'
import pathlib, sys

readme = pathlib.Path("README.md")
src = readme.read_text()

target = "### Updating tables of project layout"
if target not in src:
    sys.exit(f"target heading not found: {target!r}")

snippet = (
    "### Container image (GHCR)\n"
    "\n"
    "Pre-built multi-arch images are published to GitHub Container Registry\n"
    "on every push to `main` and on every `v*` git tag. Pull the latest:\n"
    "\n"
    "```bash\n"
    "docker pull ghcr.io/jmrl23/snow-mcp:latest\n"
    "```\n"
    "\n"
    "Supported tags:\n"
    "\n"
    "| Tag                      | When it's published                       |\n"
    "| ------------------------ | ----------------------------------------- |\n"
    "| `latest`                 | every push to the default branch and tags |\n"
    "| `main`                   | every push to `main`                      |\n"
    "| `vX.Y.Z` / `vX.Y` / `vX` | every `v*` git tag (semver)               |\n"
    "| `sha-<short>`            | every push (immutable per commit)         |\n"
    "\n"
    "Supported platforms: `linux/amd64`, `linux/arm64`.\n"
    "\n"
    "Run the published image the same way as the locally built one (replace\n"
    "`snow-mcp:local` with `ghcr.io/jmrl23/snow-mcp:latest` in any of the\n"
    "`docker run` examples above).\n"
    "\n"
)

if "### Container image (GHCR)" in src:
    sys.exit("section already present — refusing to insert twice")

readme.write_text(src.replace(target, snippet + target, 1))
print("inserted")
PY
````

Expected: prints `inserted`. If the script prints `target heading not found` or `section already present`, stop and investigate before re-running.

Why a Python heredoc rather than `sed`: the snippet contains pipe characters, backticks, and slashes that would require heavy escaping in `sed`; a Python heredoc is exact-content and idempotent (the duplicate-section check makes re-running safe).

- [ ] **Step 3: Confirm the section landed in the right place**

Run:

```bash
grep -n -A1 "^### " README.md | sed -n '/Docker/,/Testing/p'
```

Expected: the section list between `## Docker` and `## Testing` shows in order: `### Build`, `### Run`, `### Compose`, `### Use a different port`, `### Container image (GHCR)`, `### Updating tables of project layout`.

- [ ] **Step 4: Sanity-check markdown formatting**

Run:

```bash
yarn format:check README.md
```

Expected: exits 0. If Prettier reformats it, run `yarn format` and re-stage.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document published GHCR container image"
```

### Task 3: Open PR and verify the workflow on the PR build

**Files:** none (CI-driven verification).

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/ci-docker
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "ci(docker): build, size-validate, and publish multi-arch image to GHCR" --body "$(cat <<'EOF'
## Summary

- New workflow `.github/workflows/docker.yml` builds the existing Dockerfile for `linux/amd64` and `linux/arm64`.
- On PR events, only an OCI tar is produced (no push); the inline size validator parses it and fails the job if either platform exceeds 250 MB uncompressed.
- On push to `main` and on `v*` tags, the image is also pushed to `ghcr.io/${{ github.repository }}` with the standard `docker/metadata-action` tag set (`latest`, `main`, `sha-<short>`, semver).
- README gets a "Container image (GHCR)" subsection documenting supported tags and platforms.

## Post-merge follow-up (one-time)

After the first push to `main` publishes the image, flip the GHCR package
from private to public at:

  https://github.com/jmrl23/snow-mcp/pkgs/container/snow-mcp

(Package settings → Danger Zone → Change visibility → Public.)
The `org.opencontainers.image.source` OCI label is already emitted, so
the package will appear on the repo Packages sidebar once made public.

## Test plan

- [ ] PR run: both `ci` and `docker` workflows pass.
- [ ] `docker` job summary shows per-platform sizes for `linux/amd64` and `linux/arm64`, both under 250 MB.
- [ ] No image was pushed to GHCR during the PR run (verify in Actions logs: "Log in to GHCR" step is skipped; only the "Build (PR — …)" step ran).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: prints the PR URL.

- [ ] **Step 3: Watch the PR checks**

```bash
gh pr checks --watch
```

Expected: both `ci / check` and `docker / build + size + publish` end as `pass`. If `docker` fails, open the run, fix the root cause on the branch, push again, and re-watch.

- [ ] **Step 4: Spot-check the docker job summary**

Run:

```bash
gh run list --workflow=docker.yml --branch=feat/ci-docker --limit=1 --json databaseId -q '.[0].databaseId' | xargs -I{} gh run view {} --log | grep -E "linux/(amd64|arm64): " | head -5
```

Expected: two lines like:

```
linux/amd64: 198.3 MB (budget 250 MB) OK
linux/arm64: 199.1 MB (budget 250 MB) OK
```

Both must say `OK`; both must report a real number (not `0.0 MB`); both platforms must appear.

- [ ] **Step 5: Confirm no image was pushed on the PR run**

Open the GHCR package page in a browser:

```bash
gh browse -n -- /jmrl23/snow-mcp/pkgs/container/snow-mcp
```

Expected: returns a 404 (package doesn't exist yet) because nothing has been pushed. If the page exists with content, something pushed unexpectedly — open the PR run and investigate the "Build (PR — …)" vs "Build and push (main / tag — …)" step gating before merging.

### Task 4: Merge to `main` and verify the image is published

**Files:** none (post-merge verification + one-time manual step).

- [ ] **Step 1: Merge the PR**

The user explicitly authorized merging once CI passes. Use a regular merge commit to match the repo's existing pattern (recent merges are `Merge pull request #N from …`, not squashes):

```bash
gh pr merge feat/ci-docker --merge --delete-branch
```

Expected: exits 0; the branch is deleted on the remote.

- [ ] **Step 2: Watch the `main` push workflow**

```bash
gh run watch --exit-status $(gh run list --workflow=docker.yml --branch=main --limit=1 --json databaseId -q '.[0].databaseId')
```

Expected: exits 0. If this run fails (e.g., because the PR build couldn't catch a push-specific bug like a permissions misconfig), revert the merge commit with `git revert -m 1 <merge-sha>` rather than force-pushing.

- [ ] **Step 3: Verify the package exists**

```bash
gh api /users/jmrl23/packages/container/snow-mcp --jq '.name + " visibility=" + .visibility'
```

Expected: prints `snow-mcp visibility=private` (visibility is flipped manually in the next step).

- [ ] **Step 4: Verify the expected tags landed**

```bash
gh api /users/jmrl23/packages/container/snow-mcp/versions --jq '.[].metadata.container.tags[]' | sort -u
```

Expected: at minimum `latest`, `main`, and a `sha-<short>` tag. The exact short SHA matches the merge commit's first 7 chars (`git rev-parse --short HEAD` from local `main` after `git pull`).

- [ ] **Step 5: One-time visibility flip (manual UI)**

This step is **manual** and required exactly once per package:

1. Open: `https://github.com/jmrl23/snow-mcp/pkgs/container/snow-mcp`
2. Click **Package settings** (right sidebar).
3. Scroll to **Danger Zone** → **Change visibility** → choose **Public** → confirm with the package name.
4. Still on Package settings, scroll to **Manage Actions access**. If `snow-mcp` is not listed with `Write` role, click **Add Repository** → select `snow-mcp` → role `Write`. (This is usually pre-linked via the `org.opencontainers.image.source` label, but confirm.)

- [ ] **Step 6: Confirm the package is visible on the repo Packages sidebar**

Open `https://github.com/jmrl23/snow-mcp` and confirm the **Packages** section in the right sidebar lists `snow-mcp` with the matching version tags. (`gh repo view jmrl23/snow-mcp --web` is a convenience to open it.)

- [ ] **Step 7: Smoke-test the published image**

From a machine with Docker:

```bash
docker pull ghcr.io/jmrl23/snow-mcp:latest
docker image inspect ghcr.io/jmrl23/snow-mcp:latest --format '{{.Architecture}} {{.Os}} {{.Size}}'
```

Expected: the inspect line shows `amd64 linux <bytes>` (or `arm64 linux <bytes>` on Apple Silicon / Graviton), with `<bytes>` under `262144000` (250 MB). Pull succeeds without authentication after the visibility flip in Step 5.

---

## Notes on running this plan with subagent-driven-development

- **Tasks 1 and 2** are pure code/file edits — ideal for fresh subagents with the standard two-stage review (spec compliance, then code quality). Task 1's subagent gets the full YAML in this plan; Task 2's subagent gets the full markdown snippet.
- **Task 3** straddles automation (push, `gh pr create`, watch checks) and human judgment (was the size validator output correct? did anything push that shouldn't have?). The controller should run it inline rather than dispatching a subagent — it requires reading CI output and making a go/no-go call.
- **Task 4** includes a manual UI step (visibility flip). The controller runs the automatable parts (steps 1–4, 6 verification, 7 smoke test) and explicitly hands step 5 to the user. Do not attempt to flip visibility via `gh api` from the workflow's `GITHUB_TOKEN` — that token does not carry the `admin:packages` scope needed, and storing a user PAT for this is out of scope.

## Recovery: if the size validator misbehaves

If during Task 3 the size validator reports `0.0 MB` for either platform, or fails to find the manifest blob, the most likely cause is an unexpected `index.json` structure (e.g., buildx wrapped manifests in a nested index). Debug with:

```bash
# Add this temporarily near the top of the validator's run: block:
echo "=== index.json ===" && cat "$WORK/index.json" && echo "=== layout ===" && find "$WORK/blobs" -maxdepth 2 | head -50
```

Push to the PR branch, inspect the action logs to see the actual structure, then update the `jq` filter to walk the additional layer. Remove the debug echo before merging.
