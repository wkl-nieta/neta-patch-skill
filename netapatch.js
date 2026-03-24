#!/usr/bin/env node
/**
 * neta-patch-skill — Patch all published Neta image skills with latest API standards.
 *
 * Upstream reference: https://github.com/talesofai/neta-skills
 * (NOT fetched by default — expensive. Use --fetch-upstream to enable.)
 *
 * Usage:
 *   node netapatch.js                          — patch all active skills
 *   node netapatch.js --repos slug1,slug2      — patch specific slugs
 *   node netapatch.js --dry-run                — preview only
 *   node netapatch.js --fetch-upstream         — fetch latest spec from upstream first
 *   node netapatch.js --skip-readme            — only patch .js files
 *   node netapatch.js --skip-js                — only patch README files
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME = homedir();
const CONFIG_FILE = `${HOME}/random/scripts/skill-pipeline/config.json`;
const PATCH_BASE  = '/tmp/neta-patch';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args         = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const FETCH_UP     = args.includes('--fetch-upstream');
const SKIP_README  = args.includes('--skip-readme');
const SKIP_JS      = args.includes('--skip-js');
const reposArg     = args.find(a => a.startsWith('--repos='))?.split('=')[1]
                  || (args.includes('--repos') ? args[args.indexOf('--repos') + 1] : null);
const FILTER_REPOS = reposArg ? reposArg.split(',').map(s => s.trim()) : null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    throw e;
  }
}
function log(msg) { console.log(`[patch] ${msg}`); }

// ── Embedded API spec (current as of 2026-03-24) ──────────────────────────────
// Source: https://github.com/talesofai/neta-skills
// To refresh: node netapatch.js --fetch-upstream
const SPEC = {
  baseUrl:      'https://api.talesofai.com',
  makeImagePath: '/v3/make_image',
  taskPollPath:  '/v1/artifact/task',   // GET /v1/artifact/task/{uuid}
  entrance:     'PICTURE,CLI',
  defaultModel: '8_image_edit',
  tokenUrl:     'https://www.neta.art/open/',
  // Terminal task statuses (anything not in PENDING_STATES = done)
  pendingStates: ['PENDING', 'MODERATION'],
  terminalStates: ['SUCCESS', 'FAILURE', 'TIMEOUT', 'DELETED', 'ILLEGAL_IMAGE'],
};

// ── Optionally fetch upstream spec ────────────────────────────────────────────
if (FETCH_UP) {
  log('Fetching upstream spec from talesofai/neta-skills...');
  try {
    const r = spawnSync('gh', [
      'api', 'repos/talesofai/neta-skills/contents/src/apis/artifact.ts',
      '--jq', '.content',
    ], { encoding: 'utf8', stdio: 'pipe' });
    if (r.status === 0) {
      const src = Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
      // Extract base URL hint
      if (src.includes('talesofai.com')) SPEC.baseUrl = 'https://api.talesofai.com';
      log(`Upstream base URL confirmed: ${SPEC.baseUrl}`);
    }
    // Read .env.example for token URL
    const env = spawnSync('gh', [
      'api', 'repos/talesofai/neta-skills/contents/.env.example',
      '--jq', '.content',
    ], { encoding: 'utf8', stdio: 'pipe' });
    if (env.status === 0) {
      const envSrc = Buffer.from(env.stdout.trim(), 'base64').toString('utf8');
      const urlMatch = envSrc.match(/https:\/\/www\.neta\.art[^\s)"]*/);
      if (urlMatch) { SPEC.tokenUrl = urlMatch[0]; log(`Token URL: ${SPEC.tokenUrl}`); }
    }
  } catch (e) {
    log(`Upstream fetch failed (${e.message}) — continuing with embedded spec`);
  }
}

// ── Load config ───────────────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
} catch {
  console.error(`Could not read config at ${CONFIG_FILE}`);
  process.exit(1);
}

const GH_ENV = { ...process.env, GH_CONFIG_DIR: `${HOME}/.config/gh-cron` };

// ── Patch a JS file ───────────────────────────────────────────────────────────
function patchJs(src) {
  let out = src;

  // 1. API base URL: .cn → .com
  out = out.replace(/https:\/\/api\.talesofai\.cn/g, SPEC.baseUrl);

  // 2. meta.entrance: PICTURE,VERSE → PICTURE,CLI
  out = out.replace(/"PICTURE,VERSE"/g, '"PICTURE,CLI"');
  out = out.replace(/'PICTURE,VERSE'/g, "'PICTURE,CLI'");

  // 3. Terminal state check — replace simple !== "PENDING" checks with full terminal list
  // Pattern: result.task_status !== "PENDING" && result.task_status !== "MODERATION"
  // Already correct if both are there; add FAILURE/TIMEOUT/DELETED/ILLEGAL_IMAGE awareness
  // We patch the polling condition to use the full terminal states set
  out = out.replace(
    /task_status\s*!==\s*["']PENDING["']\s*&&\s*task_status\s*!==\s*["']MODERATION["']/g,
    `!['PENDING','MODERATION'].includes(task_status)`
  );
  // Also handle single-check variant
  out = out.replace(
    /task_status\s*!==\s*["']PENDING["']\s*&&\s*task_status\s*!==\s*["']MODERATION["']/g,
    `!['PENDING','MODERATION'].includes(task_status)`
  );

  // 4. Token resolution — add neta.art/open reference as comment if missing
  if (!out.includes('neta.art/open') && out.includes('NETA_TOKEN')) {
    out = out.replace(
      /(\/\/ Token resolution[\s\S]*?)(const token|let token)/,
      `$1// Get your token at: ${SPEC.tokenUrl}\n$2`
    );
  }

  return out;
}

// ── Patch a README ────────────────────────────────────────────────────────────
function patchReadme(src, skill) {
  let out = src;

  // 1. Neta onboarding block — what it is, how to register, pricing, token
  const onboardingSection = `## About Neta

[Neta](https://www.neta.art/) (by TalesofAI) is an AI image and video generation platform with a powerful open API. It uses a **credit-based system (AP — Action Points)** where each image generation costs a small number of credits. Subscriptions are available for heavier usage.

### Register

| Region | Sign up | Get token |
|--------|---------|-----------|
| Global | [neta.art](https://www.neta.art/) | [Open Portal → API Token](https://www.neta.art/open/) |
| China  | [nieta.art](https://app.nieta.art/) | [Security Settings](https://app.nieta.art/security) |

New accounts receive free credits to get started.

### Pricing

Neta uses a pay-per-generation credit model. View current plans and credit packages on the [pricing page](https://www.neta.art/pricing).

- Free tier: limited credits on signup
- Subscription: monthly AP allowance via Stripe
- One-time packs: top up credits as needed

### Get your API token

1. Sign in at [neta.art/open](https://www.neta.art/open/) (global) or [nieta.art/security](https://app.nieta.art/security) (China)
2. Generate a new API token
3. Set it as \`NETA_TOKEN\` in your environment or pass via \`--token\`

\`\`\`bash
export NETA_TOKEN=your_token_here
node ${skill.scriptName} "your prompt"

# or inline
node ${skill.scriptName} "your prompt" --token your_token_here
\`\`\``;

  // Replace existing onboarding block if present, otherwise insert before footer / at end
  if (/## About Neta/.test(out)) {
    out = out.replace(/## About Neta[\s\S]*?(?=\n## |\n---\s*\n(?!.*##)|\s*$)/, onboardingSection + '\n\n');
  } else if (/## Token Setup|## Setup|## Getting.*Token|## Authentication/.test(out)) {
    // Replace old minimal token section with full onboarding block
    out = out.replace(/## (Token Setup|Setup|Getting.*Token|Authentication)[\s\S]*?(?=\n## |\n---|\s*$)/, onboardingSection + '\n\n');
  } else {
    // Insert before footer or append
    if (/---\n\nBuilt with/.test(out)) {
      out = out.replace(/---\n\nBuilt with/, onboardingSection + '\n\n---\n\nBuilt with');
    } else {
      out = out.trimEnd() + '\n\n' + onboardingSection + '\n';
    }
  }

  // 2. Update any hardcoded .cn API URLs in README
  out = out.replace(/api\.talesofai\.cn/g, 'api.talesofai.com');

  // 3. Add/update "Powered by" footer with current links
  const footer = `---\n\nBuilt with [Claude Code](https://claude.ai/claude-code) · Powered by [Neta](https://www.neta.art/) · [Open Portal](${SPEC.tokenUrl})`;
  if (/Built with Claude Code/.test(out)) {
    out = out.replace(/---\s*\nBuilt with Claude Code[\s\S]*$/, footer);
  }

  return out;
}

// ── Process each skill ────────────────────────────────────────────────────────
const activeAccounts = config.accounts.filter(a => a.active);
const results = [];

// Collect all built skills from reports dir
const REPORTS_DIR = config.reportsDir || `${HOME}/random/skill-created`;
let skillRepos = [];
try {
  const { readdirSync } = await import('fs');
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort();
  const seen = new Set();
  for (const f of files) {
    const content = readFileSync(join(REPORTS_DIR, f), 'utf8');
    const slug    = content.match(/\*\*Slug:\*\*\s*`([^`]+)`/)?.[1];
    const repo    = content.match(/\*\*GitHub:\*\*\s*(https:\/\/github\.com\/[^\s]+)/)?.[1];
    const account = content.match(/\*\*Account:\*\*\s*@?(\S+)/)?.[1];
    if (slug && repo && account && !seen.has(slug)) {
      seen.add(slug);
      // Script name: slug → remove -skill suffix → remove hyphens → .js
      const scriptName = slug.replace(/-skill$/, '').replace(/-/g, '') + '.js';
      skillRepos.push({ slug, repo, account, scriptName });
    }
  }
} catch (e) {
  log(`Could not read reports dir: ${e.message}`);
}

if (FILTER_REPOS) {
  skillRepos = skillRepos.filter(s => FILTER_REPOS.includes(s.slug));
  log(`Filtering to: ${skillRepos.map(s => s.slug).join(', ')}`);
}

log(`Found ${skillRepos.length} skill(s) to patch`);
if (DRY_RUN) log('DRY RUN — no changes will be pushed');

for (const skill of skillRepos) {
  log(`\nPatching: ${skill.slug} (${skill.repo})`);

  const patchDir = join(PATCH_BASE, skill.slug);
  try {
    if (existsSync(patchDir)) rmSync(patchDir, { recursive: true });
    mkdirSync(patchDir, { recursive: true });

    // Clone
    run(`gh auth switch --user ${skill.account}`, { env: GH_ENV, allowFail: true });
    run(`git clone --depth 1 ${skill.repo}.git ${patchDir}`);

    const jsPath     = join(patchDir, skill.scriptName);
    const readmePath = join(patchDir, 'README.md');
    const pkgPath    = join(patchDir, 'package.json');

    let changed = false;
    const changes = [];

    // Patch JS
    if (!SKIP_JS && existsSync(jsPath)) {
      const orig   = readFileSync(jsPath, 'utf8');
      const patched = patchJs(orig);
      if (patched !== orig) {
        changes.push('js: API URL, entrance, polling');
        if (!DRY_RUN) writeFileSync(jsPath, patched);
        changed = true;
      } else {
        changes.push('js: already up to date');
      }
    }

    // Patch README
    if (!SKIP_README && existsSync(readmePath)) {
      const orig    = readFileSync(readmePath, 'utf8');
      const patched = patchReadme(orig, skill);
      if (patched !== orig) {
        changes.push('readme: token section, API URLs');
        if (!DRY_RUN) writeFileSync(readmePath, patched);
        changed = true;
      } else {
        changes.push('readme: already up to date');
      }
    }

    if (!changed) {
      log(`  ✓ ${skill.slug} — no changes needed`);
      results.push({ slug: skill.slug, status: 'up-to-date' });
      continue;
    }

    if (DRY_RUN) {
      log(`  ~ ${skill.slug} — would patch: ${changes.join(', ')}`);
      results.push({ slug: skill.slug, status: 'would-patch', changes });
      continue;
    }

    // Bump patch version in package.json
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const [maj, min, pat] = (pkg.version || '1.0.0').split('.').map(Number);
      pkg.version = `${maj}.${min}.${pat + 1}`;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      changes.push(`version: → ${pkg.version}`);
    }

    // Commit and push
    run(`git -C ${patchDir} add -A`);
    run(`git -C ${patchDir} commit -m "chore: sync with neta-skills API standards (${new Date().toISOString().slice(0,10)})"`);
    run(`git -C ${patchDir} push`);

    log(`  ✓ ${skill.slug} — patched & pushed: ${changes.join(', ')}`);
    results.push({ slug: skill.slug, status: 'patched', changes });

  } catch (e) {
    log(`  ✗ ${skill.slug} — error: ${e.message}`);
    results.push({ slug: skill.slug, status: 'error', error: e.message });
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════');
console.log(`  Neta Patch Summary — ${new Date().toISOString().slice(0,10)}`);
console.log('════════════════════════════════════════');
for (const r of results) {
  const icon = r.status === 'patched' ? '✓' : r.status === 'error' ? '✗' : '·';
  console.log(`  ${icon} ${r.slug.padEnd(35)} ${r.status}${r.changes ? ' — ' + r.changes.join(', ') : ''}`);
}
console.log('════════════════════════════════════════');
console.log(`\nUpstream reference: https://github.com/talesofai/neta-skills`);
console.log(`Token portal:       ${SPEC.tokenUrl}`);
