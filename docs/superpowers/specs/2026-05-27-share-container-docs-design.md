# Announce the GHCR Container and Update Documentation

**Status:** Approved
**Date:** 2026-05-27
**Scope:** Document the now-public `ghcr.io/jmrl23/snow-mcp` image in the project's existing docs, set the GitHub repo's discoverability metadata, and cut a `v1.1.0` GitHub Release that announces the image. No runtime code changes; no workflow changes.

## Goals

- Make the GHCR image the first thing a casual reader encounters in the README, so the "just want to try it" path doesn't require cloning + building.
- Show MCP-client users (Claude Code / Claude Desktop / Cursor) how to wire the published image into their client config without a local Node toolchain.
- Restructure USAGE.md's existing "Running in Docker" subsection so the pull-from-GHCR path stands alongside the build-from-source path, with the build path kept for hackers.
- Surface the project on GitHub Topics / repo metadata so it's discoverable via search.
- Cut a `v1.1.0` git tag and GitHub Release that publishes the versioned image tags (`:1.1.0`, `:1.1`, `:latest`, plus the literal `:v1.1.0` from `type=ref,event=tag`) and links to the package page.

## Non-Goals

- No external announcements (blog, Reddit, social) — explicitly opted out.
- No bump to `package.json` (stays at `1.1.0`).
- No new workflow files.
- No design-spec / implementation-plan reconciliation for the prior PR (separate follow-up).
- No screenshots or visual marketing.
- No changes to the `Dockerfile`, `docker-compose.yml`, or `.dockerignore`.

## File and Surface Changes

| Surface                                   | Change                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `README.md`                               | Insert a Quick-Start tip block (~6 lines) just after the existing `yarn start` block in §2 Quick start, pointing at `ghcr.io/jmrl23/snow-mcp:latest` and linking to the existing `### Container image (GHCR)` subsection.                                                |
| `USAGE.md` (§4 Wiring into an MCP client) | Add a "Using the GHCR image instead" snippet under each of the three subsections (Claude Code, Claude Desktop, Cursor) showing `command: docker` with `args: ["run", "--rm", "-i", "-e", "SNOW_INSTANCE_URL", ..., "ghcr.io/jmrl23/snow-mcp:latest"]` for stdio clients. |
| `USAGE.md` (§4.x Running in Docker)       | Restructure into two subsections: `### Pull the pre-built image (recommended)` and `### Build locally`. The pull subsection cross-links to README's tag table rather than duplicating it.                                                                                |
| `gh repo edit`                            | Set repo description, homepage URL (the GHCR package page), and topics.                                                                                                                                                                                                  |
| Git tag `v1.1.0`                          | New annotated tag on `main`, pushed to origin. Triggers `docker.yml` to publish versioned image tags.                                                                                                                                                                    |
| GitHub Release `v1.1.0`                   | Created via `gh release create` with hand-written notes.                                                                                                                                                                                                                 |

No other files are touched. No `.github/workflows/*` changes.

## README.md Detail

Locate the existing Quick start block in §2 of `README.md` (around line 64–80). After the closing fence of the `yarn build && yarn start` block, insert:

````markdown
> **Just want to try it?** A pre-built multi-arch image is published to GHCR
> on every `main` push and every `v*` tag — skip the install/build entirely:
>
> ```bash
> docker run --rm \
>   -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \
>   -e SNOW_USER=integration.user \
>   -e SNOW_PASSWORD=replace-me \
>   -p 17880:17880 \
>   ghcr.io/jmrl23/snow-mcp:latest
> ```
>
> See [Container image (GHCR)](#container-image-ghcr) for tag matrix and platforms.
````

No other line in `README.md` changes. The link anchor `#container-image-ghcr` already exists (created by the previous PR's `### Container image (GHCR)` heading).

## USAGE.md Detail

### Client wiring (§4 Wiring into an MCP client)

In each of the three subsections — **Claude Code (CLI)** (line ~176), **Claude Desktop** (line ~202), and **Cursor / other stdio MCP clients** (line ~223) — append a "Using the GHCR image instead" snippet directly after the existing `command: node` example, separated by a `---` rule.

The exact snippet differs per client by format (CLI flag vs JSON config), but the substance is the same: run the published image over stdio. For Claude Desktop, the JSON looks like:

```json
{
  "mcpServers": {
    "snow-mcp": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "SNOW_INSTANCE_URL",
        "-e",
        "SNOW_USER",
        "-e",
        "SNOW_PASSWORD",
        "ghcr.io/jmrl23/snow-mcp:latest"
      ],
      "env": {
        "SNOW_INSTANCE_URL": "https://your-instance.service-now.com",
        "SNOW_USER": "integration.user",
        "SNOW_PASSWORD": "replace-me",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

Key details that must appear in every variant:

- `-i` (or equivalently `--interactive`) on `docker run` is required for stdio MCP clients — without it the container has no stdin to talk to.
- `MCP_TRANSPORT=stdio` must be explicit; the published image's default is `http` (per the Dockerfile's `ENV MCP_TRANSPORT=http`).
- Use the value-less `-e VAR` form (forwarding from `env:`) rather than `-e VAR=secret` to keep credentials out of the args array (which `ps` and journald may log).

For Claude Code (CLI subcommand syntax) and Cursor (similar JSON to Desktop), translate the same idea to each client's idiom.

### Running in Docker (§4.x)

The current §4.x reads (rendered with 4-space indentation here to avoid nested-fence escaping):

    ### Running in Docker

    A reference Dockerfile is included; see [Docker](README.md#docker) for the build
    stage. The container defaults to the HTTP transport on port `17880`.

    ```bash
    docker build -t snow-mcp:local .
    docker run --rm \
      -e SNOW_INSTANCE_URL=... \
      ...
      snow-mcp:local
    ```

    See the [Docker](README.md#docker) section in the README for compose and
    ... (the existing tail)

Restructure as (again, 4-space-indented for display):

    ### Running in Docker

    Two paths: pull the pre-built multi-arch image from GHCR (faster), or build
    from the included Dockerfile (if you've forked the source).

    #### Pull the pre-built image (recommended)

    ```bash
    docker run --rm \
      -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \
      -e SNOW_USER=integration.user \
      -e SNOW_PASSWORD=replace-me \
      -p 17880:17880 \
      ghcr.io/jmrl23/snow-mcp:latest
    ```

    Supports `linux/amd64` and `linux/arm64`. See the README's
    [Container image (GHCR)](README.md#container-image-ghcr) section for the
    full tag matrix.

    #### Build locally

    ```bash
    docker build -t snow-mcp:local .
    docker run --rm \
      -e SNOW_INSTANCE_URL=... \
      ...
      snow-mcp:local
    ```

    See the [Docker](README.md#docker) section in the README for compose and
    ... (existing tail preserved verbatim).

The `...` placeholders in the new "Build locally" subsection are replaced with the exact lines that already exist in §4.x today — we are not rewriting that content. The implementation plan will pin the exact byte content via a Python heredoc, as in the prior PR.

## Repo Metadata Detail

Run (one-shot) on a machine authenticated with `gh`:

```bash
gh repo edit jmrl23/snow-mcp \
  --description "Read-only MCP server exposing ServiceNow to MCP clients (stdio + HTTP transports, multi-arch container on GHCR)" \
  --homepage "https://github.com/jmrl23/snow-mcp/pkgs/container/snow-mcp" \
  --add-topic mcp \
  --add-topic model-context-protocol \
  --add-topic servicenow \
  --add-topic ghcr \
  --add-topic docker \
  --add-topic typescript
```

Reversible per-field via `gh repo edit --description ""` or `--remove-topic <name>`.

## Release v1.1.0 Detail

### Tag and push

```bash
git checkout main && git pull --ff-only
git tag -a v1.1.0 -m "v1.1.0 — first tagged release; multi-arch container on GHCR"
git push origin v1.1.0
```

### Wait for the workflow

The tag push triggers `.github/workflows/docker.yml`. Watch with:

```bash
RUN_ID=$(gh run list --workflow=docker.yml --event=push --limit=1 --json databaseId -q '.[0].databaseId')
gh run watch --exit-status "$RUN_ID"
```

Expected outcome: image `ghcr.io/jmrl23/snow-mcp` gains tags `1.1.0`, `1.1`, `latest`, `v1.1.0`, and `sha-<short>` (per `docker/metadata-action` defaults).

### Create the release

```bash
gh release create v1.1.0 \
  --title "v1.1.0 — multi-arch container on GHCR" \
  --notes-file /tmp/release-notes.md
```

Release notes content (~300 words) covers:

1. One-paragraph intro of what snow-mcp does.
2. What's new in 1.1: OAuth client_credentials + Streamable HTTP transport + schema cache + the multi-arch container (this is the first tagged release, so the notes summarize everything since project inception).
3. Quick-start: `docker pull ghcr.io/jmrl23/snow-mcp:1.1.0` and a one-line `docker run` example.
4. Supported tags and platforms (linked to the README section, not duplicated).
5. Link to USAGE.md for MCP client wiring.
6. Link to the GHCR package page.

Release notes file is hand-written, not auto-generated. Drafted before tag push so it can be reviewed; written to `/tmp/release-notes.md` for `gh release create` and not committed to the repo (release content lives on GitHub).

## Branching

All file changes go on a feature branch `docs/announce-container` off `main`, merged via PR. The repo description / topics / tag / release happen **after** the PR merges, in order:

1. Open PR with README + USAGE changes.
2. CI runs (`ci.yml` + `docker.yml` PR build) — both must pass.
3. Merge.
4. `gh repo edit` for metadata.
5. Tag `v1.1.0`, push, wait for docker.yml.
6. `gh release create`.

Step 5 depends on step 3 (tag must point at a `main` commit). Step 6 depends on step 5 (release references the tag).

## Testing Plan

- README/USAGE changes are content-only — verification is:
  - `yarn format:check README.md USAGE.md` exits 0.
  - Manual read-through to confirm anchors resolve and code blocks render.
  - The new Docker-based MCP client config in USAGE.md is **smoke-tested before opening the PR** (not gated on the tag/release): run `docker run --rm -i -e ... ghcr.io/jmrl23/snow-mcp:latest` with `MCP_TRANSPORT=stdio` and confirm the process reads/writes JSON-RPC on stdio without crashing. With no ServiceNow creds available, at minimum confirm the process starts and emits a deterministic config-error message on stderr rather than crashing on startup.
- Repo metadata: `gh repo view jmrl23/snow-mcp --json description,homepageUrl,repositoryTopics` shows the new values.
- Tag publish: after pushing `v1.1.0`, `gh run watch` exits 0 and `gh api /users/jmrl23/packages/container/snow-mcp/versions --jq '.[].metadata.container.tags[]'` (with `read:packages` scope) lists `1.1.0`, `1.1`, `latest`, `v1.1.0`, `sha-<short>`.
- Release: `gh release view v1.1.0` shows the notes and links to the assets section.

## Risks and Mitigations

| Risk                                                                                                                                              | Mitigation                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Tag push triggers `docker.yml` which fails; the GitHub Release would then reference a non-existent image tag.                                     | Push the tag first, watch the workflow, only then `gh release create`. The release step is gated on the workflow's success.       |
| GHCR-based MCP client config has subtle issues (missing `-i`, wrong env-var passthrough, default transport mismatch).                             | Smoke-test the exact `docker run` invocation before merging. Document the `-i` and `MCP_TRANSPORT=stdio` requirement prominently. |
| Topics list reflects my opinion, not yours.                                                                                                       | Topics enumerated above in the spec; user can reject any during plan review. Reversible via `gh repo edit --remove-topic`.        |
| README Quick-Start tip duplicates the "Container image (GHCR)" section.                                                                           | Tip is a single `docker run` line; full tag matrix lives only in the existing GHCR section. Cross-link rather than duplicate.     |
| `v1.1.0` tag name is already implied by `package.json` but never tagged. If a v1.0.0 tag is later created retroactively, git history won't match. | Out of scope. Just don't create a v1.0.0 tag retroactively.                                                                       |
| Release notes file at `/tmp/release-notes.md` is ephemeral.                                                                                       | Acceptable — release content is the source of truth on GitHub. If we ever regenerate, the content can be re-derived from git log. |

## Out of Scope (deliberately deferred)

- External announcement copy (Reddit, dev.to, blog).
- README badges (build status, GHCR pulls, license) — could be a follow-up.
- Adding a CHANGELOG.md — Release notes are the source of truth for now.
- Pinning `docker/*` actions to SHAs — open from the previous PR.
- Spec/plan reconciliation for the previous PR — open.
