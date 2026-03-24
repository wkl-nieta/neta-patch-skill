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
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
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
const SYNC_CLAWHUB = args.includes('--sync-clawhub'); // publish current version to ClawHub without patching
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
//
// NOTE on base URLs:
//   .cn  — works with ALL token types (nieta.art login + Open Platform tokens)
//   .com — only works with Open Platform tokens from neta.art/open
//   We keep .cn as default for broadest compatibility.
//   Users can override via NETA_API_URL env var.
const SPEC = {
  baseUrlCN:      'https://api.talesofai.cn',
  baseUrlCOM:     'https://api.talesofai.com',
  entrance:       'PICTURE,CLI',
  defaultModel:   '8_image_edit',
  tokenUrlGlobal: 'https://www.neta.art/open/',
  tokenUrlCN:     'https://app.nieta.art/security',
  pricingUrl:     'https://www.neta.art/pricing',
  pendingStates:  ['PENDING', 'MODERATION'],
  terminalStates: ['SUCCESS', 'FAILURE', 'TIMEOUT', 'DELETED', 'ILLEGAL_IMAGE'],
};

// ── Optionally fetch upstream spec ────────────────────────────────────────────
if (FETCH_UP) {
  log('Fetching upstream spec from talesofai/neta-skills...');
  try {
    const env = spawnSync('gh', [
      'api', 'repos/talesofai/neta-skills/contents/.env.example', '--jq', '.content',
    ], { encoding: 'utf8', stdio: 'pipe' });
    if (env.status === 0) {
      const envSrc = Buffer.from(env.stdout.trim(), 'base64').toString('utf8');
      log(`Upstream .env.example:\n${envSrc}`);
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

// Build a map of github → clawhubToken from config
const CLAWHUB_TOKENS = {};
for (const acct of (config.accounts || [])) {
  if (acct.github && acct.clawhubToken) {
    CLAWHUB_TOKENS[acct.github] = acct.clawhubToken;
  }
}

// ── Patch a JS file ───────────────────────────────────────────────────────────
function patchJs(src) {
  let out = src;

  // 1. Revert .com → .cn (or keep .cn). .com only works with Open Platform tokens.
  out = out.replace(/https:\/\/api\.talesofai\.com/g, SPEC.baseUrlCN);

  // 2. Add NETA_API_URL env override support for inline fetch URLs
  if (!out.includes('NETA_API_URL')) {
    out = out.replace(
      new RegExp(`"${SPEC.baseUrlCN}/v3/make_image"`, 'g'),
      '`${process.env.NETA_API_URL || \'' + SPEC.baseUrlCN + '\'}/v3/make_image`'
    );
    out = out.replace(
      new RegExp('`' + SPEC.baseUrlCN.replace(/\./g, '\\.') + '/v1/artifact/task/', 'g'),
      '`${process.env.NETA_API_URL || \'' + SPEC.baseUrlCN + '\'}/v1/artifact/task/'
    );
    // Single-quote variant
    out = out.replace(
      new RegExp(`'${SPEC.baseUrlCN}/v3/make_image'`, 'g'),
      '`${process.env.NETA_API_URL || \'' + SPEC.baseUrlCN + '\'}/v3/make_image`'
    );
  }

  // 3. meta.entrance: PICTURE,VERSE → PICTURE,CLI
  out = out.replace(/"PICTURE,VERSE"/g, '"PICTURE,CLI"');
  out = out.replace(/'PICTURE,VERSE'/g, "'PICTURE,CLI'");

  // 4. Polling terminal state check — collapse to array includes
  out = out.replace(
    /task_status\s*!==\s*["']PENDING["']\s*&&\s*task_status\s*!==\s*["']MODERATION["']/g,
    `!['PENDING','MODERATION'].includes(task_status)`
  );

  // 5. Better no-token error message
  out = out.replace(
    /console\.error\("Error: NETA_TOKEN not found[^"]*"\);/g,
    `console.error('\\n✗ NETA_TOKEN not found.');
  console.error('  Global: sign up at https://www.neta.art/ → get token at https://www.neta.art/open/');
  console.error('  China:  sign up at https://app.nieta.art/ → get token at https://app.nieta.art/security');
  console.error('  Then:   export NETA_TOKEN=your_token_here');`
  );

  // 6. Better 401/403 error on submit
  out = out.replace(
    /console\.error\(`Error submitting job: \$\{submitRes\.status\}[^`]*`\);\s*\n\s*process\.exit\(1\);/g,
    `if (submitRes.status === 401 || submitRes.status === 403) {
    console.error('\\n✗ Authentication failed (' + submitRes.status + ') — your NETA_TOKEN is missing or invalid.');
    console.error('  Global: https://www.neta.art/open/');
    console.error('  China:  https://app.nieta.art/security');
  } else {
    console.error('Error submitting job: ' + submitRes.status + ' ' + submitRes.statusText);
  }
  process.exit(1);`
  );

  // 7. Handle terminal failure states explicitly in poll loop
  out = out.replace(
    /if \(status === "PENDING" \|\| status === "MODERATION"\) \{\s*continue;\s*\}/g,
    `if (['PENDING', 'MODERATION'].includes(status)) { continue; }
  if (['FAILURE', 'TIMEOUT', 'DELETED', 'ILLEGAL_IMAGE'].includes(status)) {
    console.error('Error: generation failed with status ' + status + (pollData.err_msg ? ' — ' + pollData.err_msg : ''));
    process.exit(1);
  }`
  );

  return out;
}

// ── Patch a README ────────────────────────────────────────────────────────────
function patchReadme(src, skill) {
  let out = src;

  const onboardingSection = [
    '## About Neta',
    '',
    '[Neta](https://www.neta.art/) (by TalesofAI) is an AI image and video generation platform with a powerful open API. It uses a **credit-based system (AP — Action Points)** where each image generation costs a small number of credits. Subscriptions are available for heavier usage.',
    '',
    '### Register & Get Token',
    '',
    '| Region | Sign up | Get API token |',
    '|--------|---------|---------------|',
    '| Global | [neta.art](https://www.neta.art/) | [neta.art/open](https://www.neta.art/open/) |',
    '| China  | [nieta.art](https://app.nieta.art/) | [nieta.art/security](https://app.nieta.art/security) |',
    '',
    'New accounts receive free credits to get started. No credit card required to try.',
    '',
    '### Pricing',
    '',
    `Neta uses a pay-per-generation credit model. View current plans on the [pricing page](${SPEC.pricingUrl}).`,
    '',
    '- **Free tier:** limited credits on signup — enough to test',
    '- **Subscription:** monthly AP allowance via Stripe',
    '- **Credit packs:** one-time top-up as needed',
    '',
    '### Set up your token',
    '',
    '```bash',
    '# Step 1 — get your token:',
    '#   Global: https://www.neta.art/open/',
    '#   China:  https://app.nieta.art/security',
    '',
    '# Step 2 — set it',
    'export NETA_TOKEN=your_token_here',
    '',
    '# Step 3 — run',
    `node ${skill.scriptName} "your prompt"`,
    '```',
    '',
    'Or pass it inline:',
    '```bash',
    `node ${skill.scriptName} "your prompt" --token your_token_here`,
    '```',
    '',
    '> **API endpoint:** defaults to `api.talesofai.cn` (works with all token types).  ',
    '> Override with `NETA_API_URL=https://api.talesofai.com` if using a global Open Platform token.',
  ].join('\n');

  // Replace existing onboarding block or old token section
  if (/## About Neta/.test(out)) {
    out = out.replace(/## About Neta[\s\S]*?(?=\n## |\n---\s*\n(?!.*##)|\s*$)/, onboardingSection + '\n\n');
  } else if (/## Token Setup|## Token setup|## Setup|## Getting.*Token|## Authentication/.test(out)) {
    out = out.replace(/## (Token Setup|Token setup|Setup|Getting.*Token|Authentication)[\s\S]*?(?=\n## |\n---|\s*$)/, onboardingSection + '\n\n');
  } else {
    if (/---\n\nBuilt with/.test(out)) {
      out = out.replace(/---\n\nBuilt with/, onboardingSection + '\n\n---\n\nBuilt with');
    } else {
      out = out.trimEnd() + '\n\n' + onboardingSection + '\n';
    }
  }

  // Fix any .cn → .com mistakes in README text
  out = out.replace(/api\.talesofai\.com(?!\/pricing)/g, 'api.talesofai.cn');

  // Update footer
  const footer = `---\n\nBuilt with [Claude Code](https://claude.ai/claude-code) · Powered by [Neta](https://www.neta.art/) · [Open Portal](${SPEC.tokenUrlGlobal})`;
  if (/Built with Claude Code/.test(out)) {
    out = out.replace(/---\s*\nBuilt with Claude Code[\s\S]*$/, footer);
  }

  return out;
}

// ── Process each skill ────────────────────────────────────────────────────────
const results = [];
const REPORTS_DIR = config.reportsDir || `${HOME}/random/skill-created`;
let skillRepos = [];

try {
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort();
  const seen = new Set();
  for (const f of files) {
    const content = readFileSync(join(REPORTS_DIR, f), 'utf8');
    const slug    = content.match(/\*\*Slug:\*\*\s*`([^`]+)`/)?.[1];
    const repo    = content.match(/\*\*GitHub:\*\*\s*(https:\/\/github\.com\/[^\s]+)/)?.[1];
    const account = content.match(/\*\*Account:\*\*\s*@?(\S+)/)?.[1];
    if (slug && repo && account && !seen.has(slug)) {
      seen.add(slug);
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

    run(`gh auth switch --user ${skill.account}`, { env: GH_ENV, allowFail: true });
    run(`git clone --depth 1 ${skill.repo}.git ${patchDir}`);

    const jsPath     = join(patchDir, skill.scriptName);
    const readmePath = join(patchDir, 'README.md');
    const pkgPath    = join(patchDir, 'package.json');

    let changed = false;
    const changes = [];

    if (!SKIP_JS && existsSync(jsPath)) {
      const orig    = readFileSync(jsPath, 'utf8');
      const patched = patchJs(orig);
      if (patched !== orig) {
        changes.push('js');
        if (!DRY_RUN) writeFileSync(jsPath, patched);
        changed = true;
      }
    }

    if (!SKIP_README && existsSync(readmePath)) {
      const orig    = readFileSync(readmePath, 'utf8');
      const patched = patchReadme(orig, skill);
      if (patched !== orig) {
        changes.push('readme');
        if (!DRY_RUN) writeFileSync(readmePath, patched);
        changed = true;
      }
    }

    if (!changed) {
      if (SYNC_CLAWHUB) {
        // No file changes but force-publish current version to ClawHub
        const clawToken = CLAWHUB_TOKENS[skill.account];
        if (clawToken) {
          const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
          const ver = pkg.version || '1.0.0';
          try {
            run(`clawhub auth login --token ${clawToken} --no-browser`);
        run(`clawhub publish ${patchDir} --version ${ver}`);
            log(`  ↑ ${skill.slug} — synced to ClawHub v${ver}`);
            results.push({ slug: skill.slug, status: 'synced', changes: [`clawhub@${ver}`] });
          } catch (e) {
            log(`  ⚠ ${skill.slug} — ClawHub sync failed: ${e.message.split('\n')[0]}`);
            results.push({ slug: skill.slug, status: 'error', error: e.message });
          }
        } else {
          log(`  ⚠ ${skill.slug} — no ClawHub token for ${skill.account}`);
          results.push({ slug: skill.slug, status: 'up-to-date' });
        }
      } else {
        log(`  · ${skill.slug} — already up to date`);
        results.push({ slug: skill.slug, status: 'up-to-date' });
      }
      continue;
    }

    if (DRY_RUN) {
      log(`  ~ ${skill.slug} — would patch: ${changes.join(', ')}`);
      results.push({ slug: skill.slug, status: 'would-patch', changes });
      continue;
    }

    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const [maj, min, pat] = (pkg.version || '1.0.0').split('.').map(Number);
      pkg.version = `${maj}.${min}.${pat + 1}`;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      changes.push(`v${pkg.version}`);
    }

    run(`git -C ${patchDir} add -A`);
    run(`git -C ${patchDir} commit -m "chore: neta-skills sync ${new Date().toISOString().slice(0,10)} (${changes.join(', ')})"`);
    run(`git -C ${patchDir} push`);

    // Publish to ClawHub with the new version
    const clawToken = CLAWHUB_TOKENS[skill.account];
    if (clawToken) {
      const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
      const ver = pkg.version || '1.0.0';
      try {
        run(`clawhub auth login --token ${clawToken} --no-browser`);
        run(`clawhub publish ${patchDir} --version ${ver}`);
        changes.push(`clawhub@${ver}`);
        log(`  ↑ ${skill.slug} — published to ClawHub v${ver}`);
      } catch (e) {
        log(`  ⚠ ${skill.slug} — ClawHub publish failed: ${e.message.split('\n')[0]}`);
      }
    } else {
      log(`  ⚠ ${skill.slug} — no ClawHub token for ${skill.account}, skipping publish`);
    }

    log(`  ✓ ${skill.slug} — patched: ${changes.join(', ')}`);
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
  const published = r.changes?.some(c => c.startsWith('clawhub@'));
  const icon = r.status === 'synced' ? '↑' : r.status === 'patched' ? (published ? '↑' : '✓') : r.status === 'error' ? '✗' : '·';
  console.log(`  ${icon} ${r.slug.padEnd(38)} ${r.status}${r.changes ? ' — ' + r.changes.join(', ') : ''}`);
}
console.log('════════════════════════════════════════');
console.log(`\nUpstream:  https://github.com/talesofai/neta-skills`);
console.log(`Token (Global): ${SPEC.tokenUrlGlobal}`);
console.log(`Token (China):  ${SPEC.tokenUrlCN}`);
