# Neta Skills Patcher

Keeps all published Neta image generation skills in sync with the latest upstream [neta-skills](https://github.com/talesofai/neta-skills) API standards.

## What it patches

| Change | Detail |
|--------|--------|
| API base URL | `api.talesofai.cn` → `api.talesofai.com` |
| `meta.entrance` | `PICTURE,VERSE` → `PICTURE,CLI` |
| Polling terminal states | Adds `FAILURE`, `TIMEOUT`, `DELETED`, `ILLEGAL_IMAGE` |
| Token setup section | Links to [Neta Open Portal](https://www.neta.art/open/) |
| README API references | Updates all `.cn` URLs to `.com` |
| Patch version | Auto-increments `x.y.z → x.y.(z+1)` |

> **Note:** The upstream URL is **not fetched by default** (it's an API call). The spec is embedded in the script and updated with each release. Use `--fetch-upstream` only when you suspect new upstream changes.

## Install

```bash
npx skills add wkl-nieta/neta-patch-skill
```

## Usage

```bash
# Patch all active skills from pipeline config
node netapatch.js

# Patch specific skills only
node netapatch.js --repos waifu-generator-skill,chibi-gen-skill

# Preview changes without pushing
node netapatch.js --dry-run

# Fetch latest spec from talesofai/neta-skills before patching
node netapatch.js --fetch-upstream

# Only patch .js files (skip README)
node netapatch.js --skip-readme

# Only patch README files (skip .js)
node netapatch.js --skip-js
```

## Token Setup

Get your Neta API token from the [Neta Open Portal](https://www.neta.art/open/).

This tool uses GitHub CLI (`gh`) for repo access — make sure `GH_CONFIG_DIR` points to your multi-account gh config.

## Upstream reference

- Repo: https://github.com/talesofai/neta-skills
- Token portal: https://www.neta.art/open/
- API base: `https://api.talesofai.com`

---

Built with [Claude Code](https://claude.ai/claude-code) · Powered by [Neta](https://www.neta.art/) · [API Docs](https://www.neta.art/open/)
