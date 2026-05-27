# Document the GHCR Container Across Existing Docs

**Status:** Approved
**Date:** 2026-05-27
**Scope:** Document the published `ghcr.io/jmrl23/snow-mcp` image in `README.md` and `USAGE.md` everywhere a local `docker build` is currently the only path shown. The local-build path stays as a secondary option for source-hackers; the GHCR pull becomes the recommended path. No runtime code changes, no workflow changes, no GitHub Release, no repo metadata edits, no git tags.

## Goals

- Make the GHCR image the first thing a casual reader encounters in the README, so the "just want to try it" path doesn't require cloning + building.
- Show MCP-client users (Claude Code / Claude Desktop / Cursor) how to wire the published image into their client config without a local Node toolchain.
- Restructure USAGE.md's existing "Running in Docker" subsection so the pull-from-GHCR path stands alongside the build-from-source path, with the build path kept for source-hackers.

## Non-Goals

- No external announcements (blog, Reddit, social).
- No GitHub Release.
- No git tag (`v1.1.0` or otherwise).
- No `gh repo edit` for description / homepage / topics.
- No bump to `package.json`.
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

No other files are touched. No `.github/workflows/*` changes. No GitHub-side state changes (no release, no tag, no repo metadata).

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

## Branching

All file changes go on a feature branch `docs/ghcr-pull-path` off `main`, merged via PR:

1. Open PR with README + USAGE changes.
2. CI runs (`ci.yml` + `docker.yml` PR build) — both must pass.
3. Merge.

That's it. No post-merge actions.

## Testing Plan

README/USAGE changes are content-only — verification is:

- `yarn format:check README.md USAGE.md` exits 0.
- Manual read-through to confirm anchors resolve and code blocks render.
- The new Docker-based MCP client config in USAGE.md is **smoke-tested before opening the PR**: run `docker run --rm -i -e ... ghcr.io/jmrl23/snow-mcp:latest` with `MCP_TRANSPORT=stdio` and confirm the process reads/writes JSON-RPC on stdio without crashing. With no ServiceNow creds available, at minimum confirm the process starts and emits a deterministic config-error message on stderr rather than crashing on startup.

## Risks and Mitigations

| Risk                                                                                                                  | Mitigation                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHCR-based MCP client config has subtle issues (missing `-i`, wrong env-var passthrough, default transport mismatch). | Smoke-test the exact `docker run` invocation before merging. Document the `-i` and `MCP_TRANSPORT=stdio` requirement prominently.                   |
| README Quick-Start tip duplicates the "Container image (GHCR)" section.                                               | Tip is a single `docker run` line; full tag matrix lives only in the existing GHCR section. Cross-link rather than duplicate.                       |
| Restructuring §4.x in USAGE.md breaks internal anchors elsewhere in the doc.                                          | `grep -n "#running-in-docker"` in repo before editing; preserve the top-level `### Running in Docker` heading (only subsections beneath it change). |

## Out of Scope (deliberately deferred)

- GitHub Release for `v1.1.0` — not part of "share".
- Git tag and repo metadata edits — not part of "share".
- External announcement copy (Reddit, dev.to, blog).
- README badges (build status, GHCR pulls, license) — could be a follow-up.
- Adding a CHANGELOG.md.
- Pinning `docker/*` actions to SHAs — open from the previous PR.
- Spec/plan reconciliation for the previous PR — open.
