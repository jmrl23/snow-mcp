# GHCR Pull Path Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document the published `ghcr.io/jmrl23/snow-mcp` image in `README.md` and `USAGE.md` so the recommended path becomes `docker run ghcr.io/jmrl23/snow-mcp:latest` rather than a local clone+build. Local build stays as a secondary option.

**Architecture:** Three independent content insertions (one in README, two in USAGE) on a single feature branch, merged via PR. No code, no workflow, no GitHub-side state changes (no release, no tag, no repo metadata). Each insertion is performed via a Python heredoc that locates an anchor line, splices in pre-formatted text, and refuses to run twice — the same pattern used in the previous PR.

**Tech Stack:** Markdown only. Validation via `yarn format:check` (Prettier) and a manual `docker run --rm -i ghcr.io/jmrl23/snow-mcp:latest` smoke test.

**Spec:** [`docs/superpowers/specs/2026-05-27-share-container-docs-design.md`](../specs/2026-05-27-share-container-docs-design.md)

**Branch:** `docs/ghcr-pull-path` (single branch; all tasks land here, PR'd back to `main`).

---

## Branch: `docs/ghcr-pull-path`

### Task 1: Create branch + README Quick-Start tip

**Files:**

- Modify: `README.md` — insert a blockquote tip after the existing `yarn build && yarn start` block in §2 Quick start (around line 67), before the `Alternatively, supply env vars via your MCP client's env: block` paragraph.

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull --ff-only && git checkout -b docs/ghcr-pull-path
```

- [ ] **Step 2: Confirm the anchor text exists exactly once**

```bash
grep -c "^Alternatively, supply env vars via your MCP client's \`env:\` block" README.md
```

Expected: prints `1`. If it prints `0`, the file has drifted and the script in Step 3 will refuse to run — stop and investigate. If it prints anything else, multiple matches exist and the splice would be ambiguous — also stop.

- [ ] **Step 3: Insert the tip block via Python heredoc**

Run this verbatim from the repo root:

````bash
python3 - <<'PY'
import pathlib, sys

readme = pathlib.Path("README.md")
src = readme.read_text()

anchor = "Alternatively, supply env vars via your MCP client's `env:` block (see"
if anchor not in src:
    sys.exit(f"anchor not found: {anchor!r}")
if "Just want to try it?" in src:
    sys.exit("tip already present — refusing to insert twice")

tip = (
    "> **Just want to try it?** A pre-built multi-arch image is published to GHCR\n"
    "> on every `main` push — skip the install/build entirely:\n"
    ">\n"
    "> ```bash\n"
    "> docker run --rm \\\n"
    ">   -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \\\n"
    ">   -e SNOW_USER=integration.user \\\n"
    ">   -e SNOW_PASSWORD=replace-me \\\n"
    ">   -p 17880:17880 \\\n"
    ">   ghcr.io/jmrl23/snow-mcp:latest\n"
    "> ```\n"
    ">\n"
    "> See [Container image (GHCR)](#container-image-ghcr) for tag matrix and platforms.\n"
    "\n"
)

readme.write_text(src.replace(anchor, tip + anchor, 1))
print("inserted")
PY
````

Expected: prints `inserted`. If it prints either error message, STOP and report it as BLOCKED.

- [ ] **Step 4: Verify the tip rendered at the right spot**

```bash
grep -n -B1 "^Alternatively, supply env vars" README.md | head -6
```

Expected: the line immediately before `Alternatively` is blank, and 2–3 lines above that is `> See [Container image (GHCR)](#container-image-ghcr) for tag matrix and platforms.`. The tip block as a whole spans ~12 lines starting with `> **Just want to try it?**`.

- [ ] **Step 5: Verify the anchor target exists**

```bash
grep -c "^### Container image (GHCR)$" README.md
```

Expected: prints `1`. (Already established by the previous PR; this confirms the cross-link won't rot.)

- [ ] **Step 6: Prettier format check**

```bash
yarn format:check README.md
```

Expected: exits 0 with `All matched files use Prettier code style!`. If Prettier reformats, run `yarn format` and re-add.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs(readme): add Quick-Start tip pointing at pre-built GHCR image"
```

### Task 2: USAGE.md — add GHCR variants under Claude Code and Claude Desktop

**Files:**

- Modify: `USAGE.md` — insert a "Using the GHCR image instead" block after the closing ``` ` `` `of each existing`command: node`JSON example in §4. Two insertions total: one in`### Claude Code (CLI)`and one in`### Claude Desktop`. The `### Cursor / other stdio MCP clients` subsection gets a one-line note in Task 4 (handled below) — keeping the JSON examples to Code and Desktop matches the file's current structure.

The two insertions use different example env vars on purpose: the existing Claude Code example uses `SNOW_OAUTH_TOKEN`; the existing Claude Desktop example uses `SNOW_USER`/`SNOW_PASSWORD`. The Docker variants follow the same auth choice in each section so a reader who copies one block doesn't accidentally mix auth styles.

- [ ] **Step 1: Confirm both anchor strings exist exactly once**

```bash
grep -c '^Restart Claude Code\. Tools appear under the' USAGE.md
grep -c "^### Cursor / other stdio MCP clients$" USAGE.md
```

Expected: each prints `1`. The first marks the end of the Claude Code JSON+follow-up paragraph (we'll insert AFTER it). The second marks the START of the Cursor subsection (we'll insert BEFORE it for the Claude Desktop block).

- [ ] **Step 2: Insert both blocks via Python heredoc**

Run this verbatim from the repo root:

````bash
python3 - <<'PY'
import pathlib, sys

usage = pathlib.Path("USAGE.md")
src = usage.read_text()

if "Using the GHCR image instead" in src:
    sys.exit("section already present — refusing to insert twice")

# --- Claude Code (CLI) GHCR variant ---
code_anchor = "> Prefer pinning to `dist/main.js` after `yarn build` for predictable\n> startup. Use `yarn dev` only when iterating on the server itself.\n"
if code_anchor not in src:
    sys.exit("Claude Code anchor (pinning tip) not found")

code_extra = (
    "\n"
    "---\n"
    "\n"
    "**Using the GHCR image instead** — skip the local clone + `yarn build`\n"
    "by pointing at the published image:\n"
    "\n"
    "```json\n"
    "{\n"
    '  "mcpServers": {\n'
    '    "snow-mcp": {\n'
    '      "command": "docker",\n'
    '      "args": [\n'
    '        "run", "--rm", "-i",\n'
    '        "-e", "SNOW_INSTANCE_URL",\n'
    '        "-e", "SNOW_OAUTH_TOKEN",\n'
    '        "-e", "MCP_TRANSPORT",\n'
    '        "ghcr.io/jmrl23/snow-mcp:latest"\n'
    "      ],\n"
    '      "env": {\n'
    '        "SNOW_INSTANCE_URL": "https://your-instance.service-now.com",\n'
    '        "SNOW_OAUTH_TOKEN": "eyJraWQiOiI...",\n'
    '        "MCP_TRANSPORT": "stdio"\n'
    "      }\n"
    "    }\n"
    "  }\n"
    "}\n"
    "```\n"
    "\n"
    "`-i` keeps the container's stdin open for the MCP client's JSON-RPC\n"
    "stream. `MCP_TRANSPORT=stdio` overrides the image's default of `http`.\n"
    "Forwarding env vars by name (`-e SNOW_OAUTH_TOKEN`, no `=value`) keeps\n"
    "secrets out of the args array, which `ps` and journald may log.\n"
)
src = src.replace(code_anchor, code_anchor + code_extra, 1)

# --- Claude Desktop GHCR variant ---
desktop_anchor = "### Cursor / other stdio MCP clients\n"
if src.count(desktop_anchor) != 1:
    sys.exit("Claude Desktop / Cursor boundary anchor not found exactly once")

desktop_extra = (
    "---\n"
    "\n"
    "**Using the GHCR image instead** — same shape, but `command: docker`\n"
    "with `args` forwarding env vars into a container:\n"
    "\n"
    "```json\n"
    "{\n"
    '  "mcpServers": {\n'
    '    "snow-mcp": {\n'
    '      "command": "docker",\n'
    '      "args": [\n'
    '        "run", "--rm", "-i",\n'
    '        "-e", "SNOW_INSTANCE_URL",\n'
    '        "-e", "SNOW_USER",\n'
    '        "-e", "SNOW_PASSWORD",\n'
    '        "-e", "MCP_TRANSPORT",\n'
    '        "ghcr.io/jmrl23/snow-mcp:latest"\n'
    "      ],\n"
    '      "env": {\n'
    '        "SNOW_INSTANCE_URL": "https://your-instance.service-now.com",\n'
    '        "SNOW_USER": "integration.user",\n'
    '        "SNOW_PASSWORD": "replace-me",\n'
    '        "MCP_TRANSPORT": "stdio"\n'
    "      }\n"
    "    }\n"
    "  }\n"
    "}\n"
    "```\n"
    "\n"
    "`-i` keeps the container's stdin open. `MCP_TRANSPORT=stdio` is\n"
    "required because the image's default transport is `http`.\n"
    "\n"
)
src = src.replace(desktop_anchor, desktop_extra + desktop_anchor, 1)

usage.write_text(src)
print("inserted")
PY
````

Expected: prints `inserted`. Any error → STOP and report BLOCKED.

- [ ] **Step 3: Verify both blocks landed in the right places**

```bash
grep -c "Using the GHCR image instead" USAGE.md
```

Expected: prints `2`.

```bash
grep -n -A1 "^### " USAGE.md | sed -n '/Wiring/,/Tool reference/p'
```

Expected: between `## 4. Wiring into an MCP client` and `## 5. Tool reference`, the headings appear in this order: `### Claude Code (CLI)`, `### Claude Desktop`, `### Cursor / other stdio MCP clients`, `### Verifying the connection`, `### Running in Docker`. (Restructure of Docker subsections happens in Task 3 and may add an `#### …` subheading; that's fine — only the `###` order matters here.)

- [ ] **Step 4: Prettier format check**

```bash
yarn format:check USAGE.md
```

Expected: exits 0. If Prettier reformats, run `yarn format` and re-add.

- [ ] **Step 5: Commit**

```bash
git add USAGE.md
git commit -m "docs(usage): add Docker/GHCR variants for Claude Code and Claude Desktop"
```

### Task 3: USAGE.md — add Cursor GHCR note and restructure §4.x "Running in Docker"

**Files:**

- Modify: `USAGE.md` — two atomic edits in one task:
  1. Append a one-line cross-reference to the Cursor subsection.
  2. Replace the current `### Running in Docker` body (the multi-stage Dockerfile description + single `docker build` example) with two `####` subsections: "Pull the pre-built image (recommended)" and "Build locally", preserving the existing tail paragraph that cross-links to README's Docker section.

- [ ] **Step 1: Confirm the two anchor regions exist exactly once each**

```bash
grep -c 'pass them via the client.s .env. block, shell exports, or any other' USAGE.md
grep -c '^docker build -t snow-mcp:local \.$' USAGE.md
```

Expected: each prints `1`. The first locates the Cursor subsection's existing paragraph (we'll append AFTER it). The second locates the unique `docker build` line in the current "Running in Docker" section (we'll splice the whole code block + surrounding prose).

- [ ] **Step 2: Apply both edits via Python heredoc**

Run this verbatim from the repo root:

````bash
python3 - <<'PY'
import pathlib, sys

usage = pathlib.Path("USAGE.md")
src = usage.read_text()

# Edit A: Cursor cross-reference.
cursor_anchor = (
    "Use the same `command` + `args` + `env` triplet. The server reads\n"
    "credentials only from `process.env`; pass them via the client's `env`\n"
    "block, shell exports, or any other mechanism that populates the process\n"
    "environment.\n"
)
if cursor_anchor not in src:
    sys.exit("Cursor paragraph anchor not found")
if "For the Docker variant, copy the Claude Desktop" in src:
    sys.exit("Cursor note already present — refusing to insert twice")

cursor_note = (
    "\n"
    "For the Docker variant, copy the Claude Desktop GHCR JSON above and\n"
    "adjust the auth env vars to whichever form your setup uses.\n"
)
src = src.replace(cursor_anchor, cursor_anchor + cursor_note, 1)

# Edit B: Restructure "Running in Docker".
old_docker = (
    "### Running in Docker\n"
    "\n"
    "The repo ships a multi-stage Dockerfile with a distroless runtime\n"
    "stage. The container defaults to the HTTP transport on port `17880`.\n"
    "Pass credentials via `-e` flags:\n"
    "\n"
    "```bash\n"
    "docker build -t snow-mcp:local .\n"
    "docker run --rm \\\n"
    "  -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \\\n"
    "  -e SNOW_USER=integration.user \\\n"
    "  -e SNOW_PASSWORD=replace-me \\\n"
    "  -p 17880:17880 \\\n"
    "  snow-mcp:local\n"
    "```\n"
    "\n"
    "See the [Docker](README.md#docker) section in the README for compose and\n"
    "port-override examples.\n"
)
if old_docker not in src:
    sys.exit("'Running in Docker' anchor block not found — file may have drifted")

new_docker = (
    "### Running in Docker\n"
    "\n"
    "Two paths: pull the pre-built multi-arch image from GHCR (faster, no\n"
    "local Node toolchain needed), or build from the included Dockerfile\n"
    "(useful if you're hacking on the source).\n"
    "\n"
    "Either way the container defaults to the HTTP transport on port\n"
    "`17880`. Pass credentials via `-e` flags.\n"
    "\n"
    "#### Pull the pre-built image (recommended)\n"
    "\n"
    "```bash\n"
    "docker run --rm \\\n"
    "  -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \\\n"
    "  -e SNOW_USER=integration.user \\\n"
    "  -e SNOW_PASSWORD=replace-me \\\n"
    "  -p 17880:17880 \\\n"
    "  ghcr.io/jmrl23/snow-mcp:latest\n"
    "```\n"
    "\n"
    "Supports `linux/amd64` and `linux/arm64`. See the README's\n"
    "[Container image (GHCR)](README.md#container-image-ghcr) section for\n"
    "the full tag matrix (`latest`, `main`, `sha-<short>`, semver patterns).\n"
    "\n"
    "#### Build locally\n"
    "\n"
    "Useful when you've modified the source and want a `:local` image\n"
    "without pushing anywhere:\n"
    "\n"
    "```bash\n"
    "docker build -t snow-mcp:local .\n"
    "docker run --rm \\\n"
    "  -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \\\n"
    "  -e SNOW_USER=integration.user \\\n"
    "  -e SNOW_PASSWORD=replace-me \\\n"
    "  -p 17880:17880 \\\n"
    "  snow-mcp:local\n"
    "```\n"
    "\n"
    "See the [Docker](README.md#docker) section in the README for compose\n"
    "and port-override examples.\n"
)
src = src.replace(old_docker, new_docker, 1)

usage.write_text(src)
print("inserted")
PY
````

Expected: prints `inserted`. Any error → STOP and report BLOCKED.

- [ ] **Step 3: Confirm structure**

```bash
grep -n "^#### " USAGE.md
```

Expected: prints exactly two lines under §4.x:

```
<lineN>:#### Pull the pre-built image (recommended)
<lineM>:#### Build locally
```

(Where `lineN < lineM` and both fall between `### Running in Docker` and `## 5. Tool reference`.)

```bash
grep -c "For the Docker variant, copy the Claude Desktop" USAGE.md
```

Expected: prints `1`.

- [ ] **Step 4: Prettier format check**

```bash
yarn format:check USAGE.md
```

Expected: exits 0. If Prettier reformats, run `yarn format` and re-add.

- [ ] **Step 5: Commit**

```bash
git add USAGE.md
git commit -m "docs(usage): split Running-in-Docker into pull + build paths, cross-link Cursor"
```

### Task 4: Smoke-test the GHCR image with the documented config

**Files:** none (verification only — no source changes).

The two USAGE.md JSON blocks claim that `docker run --rm -i -e ... ghcr.io/jmrl23/snow-mcp:latest` with `MCP_TRANSPORT=stdio` starts cleanly. This task verifies that claim before opening the PR. We don't have ServiceNow credentials for a full read, but we can confirm the process starts, picks up the env, and either waits for stdio input or fails with a deterministic config error on stderr (never a crash on startup).

- [ ] **Step 1: Pull the published image**

```bash
docker pull ghcr.io/jmrl23/snow-mcp:latest
```

Expected: pull succeeds (image is public). If you get `denied: requested resource not accessible`, the GHCR package visibility may have regressed — check `https://github.com/jmrl23/snow-mcp/pkgs/container/snow-mcp` and skip this task with a note in the report.

- [ ] **Step 2: Smoke-test with fake but well-formed env**

```bash
timeout 3 docker run --rm -i \
  -e SNOW_INSTANCE_URL=https://example.service-now.com \
  -e SNOW_USER=test-user \
  -e SNOW_PASSWORD=test-pass \
  -e MCP_TRANSPORT=stdio \
  ghcr.io/jmrl23/snow-mcp:latest </dev/null 2>&1 | head -20
echo "---exit=$?---"
```

Expected outcomes (either is OK):

- Exit code `124` (the `timeout 3` SIGTERM): the process started cleanly, awaited stdio JSON-RPC input, and was killed by the timeout. This is the "happy path" — the image accepts our env and runs.
- Exit code `1` with a clear `[ConfigError]` or similar diagnostic on stderr describing what's missing/wrong. Acceptable if the message names a specific missing-or-invalid env var.

Unacceptable: any unhandled exception, `MODULE_NOT_FOUND`, missing-file error, segfault, or "no such file or directory: /nodejs/bin/node". Treat any of these as a smoke-test failure and report BLOCKED.

- [ ] **Step 3: Also smoke-test the HTTP-default path** (sanity check that the documented `docker run -p 17880:17880 ...` from the README tip works)

```bash
docker run --rm -d --name snow-mcp-smoke \
  -e SNOW_INSTANCE_URL=https://example.service-now.com \
  -e SNOW_USER=test-user \
  -e SNOW_PASSWORD=test-pass \
  -p 17880:17880 \
  ghcr.io/jmrl23/snow-mcp:latest
sleep 2
docker logs snow-mcp-smoke 2>&1 | head -10
docker stop snow-mcp-smoke >/dev/null 2>&1
```

Expected: `docker logs` shows the server listening on `0.0.0.0:17880` (or a `[ConfigError]`-class diagnostic naming a specific bad env var). The container is then stopped. If `docker logs` shows a crash (stack trace, MODULE_NOT_FOUND, ENOENT), report BLOCKED.

- [ ] **Step 4: No commit needed.**

This task verifies, it doesn't change anything. If both smoke tests pass, the next task pushes and opens the PR. If either fails, fix the documented config first, re-run smoke tests, then proceed.

### Task 5: Open PR and merge

**Files:** none (CI-driven verification + merge).

- [ ] **Step 1: Push the branch**

```bash
git push -u origin docs/ghcr-pull-path
```

Expected: branch pushed; gh prints the "Create a pull request" link.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "docs: document GHCR pull path in README and USAGE" --body "$(cat <<'EOF'
## Summary

- README §2 Quick start: blockquote tip pointing first-time readers at `docker run ghcr.io/jmrl23/snow-mcp:latest`, cross-linking to the existing GHCR section.
- USAGE.md §4 Wiring into an MCP client: Docker-based `command: docker` JSON variants added under Claude Code and Claude Desktop; Cursor subsection cross-references the Claude Desktop variant.
- USAGE.md §4.x Running in Docker: split into "Pull the pre-built image (recommended)" and "Build locally" subsections. The existing `docker build` content is preserved under the second subheading.

All inserts use the same Python-heredoc splice pattern as the previous PR (anchor-based, idempotent, no surrounding content rewrites).

## Smoke test

Before pushing, both documented `docker run` invocations were exercised against `ghcr.io/jmrl23/snow-mcp:latest` with fake credentials:

- stdio variant (`MCP_TRANSPORT=stdio` + `-i`) — process started, awaited stdio, killed by timeout (expected).
- http variant (default `-p 17880:17880`) — container listened on `0.0.0.0:17880` (or emitted a deterministic config-error if smoke-test env was incomplete).

No crashes, no `MODULE_NOT_FOUND`, no missing-file errors.

## Test plan

- [ ] `ci / typecheck + lint + test` passes
- [ ] `docker / build + size + publish` (PR build) passes
- [ ] No image was pushed to GHCR during the PR build (no push step runs on `pull_request`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

Expected: prints the PR URL.

- [ ] **Step 3: Watch the PR checks**

```bash
gh pr checks --watch 2>&1 | tail -10
```

Expected: both `ci / check` and `docker / build + size + publish` end as `pass`. If `docker` fails, the docs PR didn't change any workflow-relevant input, so the failure is almost certainly transient (GHA cache eviction, registry hiccup) — re-run the failed job once before investigating.

- [ ] **Step 4: Merge**

The user authorized "do what's needed and push to main", so merge directly:

```bash
gh pr merge --merge --delete-branch
```

Expected: exits 0; branch deleted on remote.

- [ ] **Step 5: Confirm main has the merge commit**

```bash
git checkout main && git pull --ff-only && git log --oneline -3
```

Expected: top commit is `Merge pull request #<N> from jmrl23/docs/ghcr-pull-path`; the prior two commits include the README and USAGE changes from this branch.

---

## Notes on running this plan with subagent-driven-development

- **Tasks 1–3** are pure content edits with deterministic Python-heredoc splices — ideal for subagent dispatch with the standard two-stage review (spec compliance, then code quality). Each task's subagent receives the full plan text for that task; the heredoc IS the source of truth for the inserted bytes.
- **Task 4 (smoke test)** is a verification task with no commit — straightforward to dispatch as a subagent, but the controller can also run it inline since the commands are short. Either path is fine.
- **Task 5 (PR + merge)** is controller-handled inline. It involves watching CI output and making the final merge call.

## Recovery: anchor drift

If any Step 1 anchor-count check returns `0` or `>1`:

- `0` → the surrounding text has drifted from what this plan expects. STOP. Read the relevant section of `README.md` or `USAGE.md` and adjust the anchor string in the heredoc to match, **without changing the inserted content**.
- `>1` → the anchor isn't unique enough. Extend the anchor string with the line before or after so it becomes unique, then re-run.

Never alter the inserted content to "make the splice fit"; only the anchor selector should change.

## Recovery: Prettier reformats

`yarn format:check` may fail if Prettier wants to realign tables or normalize whitespace introduced by the heredoc. Standard fix:

```bash
yarn format README.md USAGE.md
git add README.md USAGE.md
```

Then re-run `yarn format:check` to confirm clean state. Inspect `git diff --cached` to make sure Prettier only touched whitespace/alignment of the new content — if it edits anything in the existing prose, stop and investigate.
