---
name: neta-patch-skill
description: Patch all published Neta image skills with the latest API standards — base URL, polling logic, token setup, and README info. Run after upstream neta-skills updates.
tools: Bash
---

# Neta Skills Patcher

Applies API standard updates across all published Neta image generation skills. Keeps skill repos in sync when the upstream [neta-skills](https://github.com/talesofai/neta-skills) API changes.

## When to use

Use when:
- Neta API base URL, endpoint paths, or request format has changed
- Token acquisition flow has been updated
- Polling logic needs new terminal states
- README billing/registration info is outdated

## Quick start

```bash
# Patch all active skills (uses embedded spec — no upstream fetch)
node netapatch.js

# Patch specific skills only
node netapatch.js --repos waifu-generator-skill,chibi-gen-skill

# Preview changes without pushing
node netapatch.js --dry-run

# Fetch latest spec from upstream before patching (slower, costs API call)
node netapatch.js --fetch-upstream
```

## Options

| Flag | Description |
|------|-------------|
| `--repos slug1,slug2` | Only patch these slugs (comma-separated) |
| `--dry-run` | Show what would change, don't push |
| `--fetch-upstream` | Fetch latest API spec from talesofai/neta-skills before patching |
| `--skip-readme` | Only patch .js files, skip README updates |
| `--skip-js` | Only patch README files, skip .js updates |

## Install

```bash
npx skills add wkl-nieta/neta-patch-skill
```
