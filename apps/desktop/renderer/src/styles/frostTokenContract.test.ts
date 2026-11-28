import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Peer Frost v2 CSS Token Contract & Ratchet Gate.
 *
 * Enforces the Peer Frost A×G matte token protocol across all desktop renderer CSS:
 *   1. Default dark neutral surfaces in tokens.css stay strictly matte obsidian (zero blue-slate drift).
 *   2. Legacy --za-* / --pa-* aliases in [data-theme="dark"] never hardcode hex colors.
 *   3. No cheesy top white specular highlights (--glass-edge-highlight stays flat; no new inset 0 1px 0 white).
 *   4. A×G dual-tier activation tokens & concentric radius ladder stay intact and high-contrast.
 *   5. No new blue --azure-trace / --za-accent-soft background washes on cards/panels.
 *   6. Ratchet baselines on raw #hex colors and legacy color/surface aliases:
 *      - Any new CSS file MUST have 0 raw hexes, 0 legacy color aliases, 0 azure background washes, 0 white top speculars.
 *      - Existing legacy files may only stay at or shrink below their recorded baseline (reduce the baseline as you migrate!).
 */

const ALLOWED_SHARED_LEGACY_VARS =
  /^--(?:za-motion-|za-ease-|za-code-font-size$|za-font-|za-sidebar-current-width$|za-workbench-current-width$|za-workbench-width$|pa-drawer-width$|pa-dropdown-menu-width$|pa-update-pct$|pa-focus-)/i;

const AZURE_BG_WASH_PATTERN =
  /background(?:-color)?\s*:[^;]*--(?:azure-trace|cinnabar-trace|za-accent-soft)\b/i;

const TOP_WHITE_SPECULAR_PATTERN =
  /inset\s+0\s+1px\s+0\s+rgba\(\s*255\s*,\s*255\s*,\s*255/i;

const RAW_HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/g;
const LEGACY_VAR_USAGE_PATTERN = /var\(\s*(--(?:za|pa|ink|cinnabar|surface-vellum)-[a-z0-9-]+)/gi;

// ─── Frozen Ratchet Baselines (ALL ZEROED — zero legacy CSS debt allowed!) ───

const LEGACY_AZURE_BG_WASH_BASELINE: Readonly<Record<string, number>> = {};

const LEGACY_TOP_WHITE_SPECULAR_BASELINE: Readonly<Record<string, number>> = {};

const LEGACY_RAW_HEX_BASELINE: Readonly<Record<string, number>> = {};

const LEGACY_COLOR_ALIAS_BASELINE: Readonly<Record<string, number>> = {};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractCssBlock(source: string, selectorPrefix: string): string {
  const start = source.indexOf(selectorPrefix);
  assert.notEqual(start, -1, `Missing selector block: ${selectorPrefix}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `Missing opening brace for ${selectorPrefix}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`Unclosed CSS block: ${selectorPrefix}`);
}

function parseHexRgb(hex: string): readonly [number, number, number] {
  const clean = hex.replace('#', '');
  assert.equal(clean.length, 6, `Expected 6-digit hex color, got ${hex}`);
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function channelSpread(hex: string): number {
  const [r, g, b] = parseHexRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function readTokenValue(block: string, tokenName: string): string | null {
  const escaped = tokenName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  return match ? match[1]!.trim() : null;
}

function resolveNumericPx(block: string, tokenName: string, seen = new Set<string>()): number {
  assert.ok(!seen.has(tokenName), `Cyclic token reference at ${tokenName}`);
  seen.add(tokenName);
  const raw = readTokenValue(block, tokenName);
  assert.ok(raw, `Missing token ${tokenName}`);
  const direct = raw.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (direct) return Number.parseFloat(direct[1]!);
  const alias = raw.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/);
  if (alias) return resolveNumericPx(block, alias[1]!, seen);
  const sum = raw.match(/^calc\(\s*var\(\s*(--[a-zA-Z0-9-]+)\s*\)\s*\+\s*var\(\s*(--[a-zA-Z0-9-]+)\s*\)\s*\)$/);
  if (sum) {
    return resolveNumericPx(block, sum[1]!, new Set(seen)) + resolveNumericPx(block, sum[2]!, new Set(seen));
  }
  assert.fail(`Token ${tokenName} must resolve to numeric px (or var/calc sum), got: ${raw}`);
}

function scanCssSource(cssSource: string, options: { readonly excludeRawHex?: boolean } = {}) {
  const stripped = stripComments(cssSource);
  const lines = stripped.split('\n');
  const azureWashes: string[] = [];
  const topSpeculars: string[] = [];
  const rawHexes: string[] = [];
  const legacyColorAliases: string[] = [];

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (AZURE_BG_WASH_PATTERN.test(line)) {
      azureWashes.push(`L${lineNo}: ${line.trim()}`);
    }
    if (TOP_WHITE_SPECULAR_PATTERN.test(line)) {
      topSpeculars.push(`L${lineNo}: ${line.trim()}`);
    }
    if (!options.excludeRawHex && !/mask-image\s*:/i.test(line)) {
      for (const match of line.matchAll(RAW_HEX_PATTERN)) {
        rawHexes.push(`L${lineNo}: ${match[0]}`);
      }
    }
    for (const match of line.matchAll(LEGACY_VAR_USAGE_PATTERN)) {
      const token = match[1]!;
      if (!ALLOWED_SHARED_LEGACY_VARS.test(token)) {
        legacyColorAliases.push(`L${lineNo}: ${token}`);
      }
    }
  });

  return { azureWashes, topSpeculars, rawHexes, legacyColorAliases };
}

function walkCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkCssFiles(full, out);
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out.sort();
}

// ─── Self-Tests ────────────────────────────────────────────────────────────────

test('frost token scanner catches blue-slate drift, azure washes, top white speculars, raw hexes and legacy color aliases', () => {
  assert.ok(channelSpread('#181C24') > 7, 'legacy blue-slate #181C24 must violate dark neutrality spread');
  assert.ok(channelSpread('#19191C') <= 7, 'matte obsidian #19191C must pass dark neutrality spread');

  const bad = scanCssSource(`
    .card {
      background: color-mix(in srgb, var(--azure-trace) 70%, var(--paper-sheet));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
      border-color: #262C37;
      color: var(--za-text);
    }
  `);
  assert.equal(bad.azureWashes.length, 1);
  assert.equal(bad.topSpeculars.length, 1);
  assert.equal(bad.rawHexes.length, 1);
  assert.equal(bad.legacyColorAliases.length, 1);

  const clean = scanCssSource(`
    /* var(--za-bg-0) #181C24 inset 0 1px 0 rgba(255,255,255,0.2) */
    .card {
      background: var(--paper-hover);
      color: var(--graphite-base);
      transition: background var(--za-motion-fast) var(--za-ease-standard);
      mask-image: linear-gradient(to bottom, #000 0%, transparent 100%);
    }
  `);
  assert.deepEqual(clean.azureWashes, []);
  assert.deepEqual(clean.topSpeculars, []);
  assert.deepEqual(clean.rawHexes, []);
  assert.deepEqual(clean.legacyColorAliases, []);
});

// ─── Canonical tokens.css Invariants ───────────────────────────────────────────

test('tokens.css default dark theme enforces neutral matte obsidian surfaces and zero hardcoded alias hexes', () => {
  const tokensCss = stripComments(readFileSync(new URL('./tokens.css', import.meta.url), 'utf8'));
  const darkBlock = extractCssBlock(tokensCss, '[data-theme="dark"] {');

  // 1. All dark neutral surface hexes stay matte obsidian (channel spread <= 7; no blue-slate drift)
  const darkSurfaceHexes = [...darkBlock.matchAll(/(--(?:chrome|paper|control)-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)];
  assert.ok(darkSurfaceHexes.length >= 12, `Expected >= 12 dark neutral surface tokens, found ${darkSurfaceHexes.length}`);
  const bluish: string[] = [];
  for (const [, name, hex] of darkSurfaceHexes) {
    const spread = channelSpread(hex!);
    if (spread > 7) bluish.push(`${name}: ${hex} (RGB spread=${spread}, max=7)`);
  }
  assert.deepEqual(bluish, [], `Dark Frost surfaces must stay neutral matte obsidian:\n${bluish.join('\n')}`);

  // 2. No hardcoded hex colors on --za-* / --pa-* compatibility aliases in [data-theme="dark"]
  const aliasHexes = [...darkBlock.matchAll(/(--(?:za|pa)-[a-z0-9-]+)\s*:\s*([^;]*#[0-9a-fA-F]{3,8}[^;]*);/g)]
    .map((m) => `${m[1]}: ${m[2]}`);
  assert.deepEqual(
    aliasHexes,
    [],
    `Compatibility aliases in [data-theme="dark"] must reference canonical Frost tokens via var(...):\n${aliasHexes.join('\n')}`,
  );

  // 3. Flat matte glass edge highlight everywhere in tokens.css (no top white specular line)
  const edgeHighlights = [...tokensCss.matchAll(/--glass-edge-highlight\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim());
  assert.ok(edgeHighlights.length >= 2, `Expected >= 2 --glass-edge-highlight declarations, found ${edgeHighlights.length}`);
  for (const value of edgeHighlights) {
    assert.equal(
      value,
      '0 0 0 0 transparent',
      `--glass-edge-highlight must stay flat matte ("0 0 0 0 transparent"), got: ${value}`,
    );
  }
});

test('tokens.css maintains A×G dual-tier activation tokens and monotonic concentric radius ladder', () => {
  const tokensCss = stripComments(readFileSync(new URL('./tokens.css', import.meta.url), 'utf8'));
  const lightBlock = extractCssBlock(tokensCss, ':root {');
  const darkBlock = extractCssBlock(tokensCss, '[data-theme="dark"] {');

  for (const [label, block] of [[':root', lightBlock], ['[data-theme="dark"]', darkBlock]] as const) {
    const glassRowActive = readTokenValue(block, '--chrome-glass-row-active');
    const glassRowBorder = readTokenValue(block, '--chrome-glass-row-border');
    const keycapBg = readTokenValue(block, '--chrome-keycap-bg');
    const keycapFg = readTokenValue(block, '--chrome-keycap-fg');
    const keycapBorder = readTokenValue(block, '--chrome-keycap-border');

    assert.ok(glassRowActive, `${label} missing --chrome-glass-row-active`);
    assert.ok(glassRowBorder, `${label} missing --chrome-glass-row-border`);
    assert.ok(!/gradient\(/i.test(glassRowActive), `${label} --chrome-glass-row-active must stay flat matte (no gloss gradient)`);
    assert.ok(keycapBg && /^#[0-9a-fA-F]{6}$/.test(keycapBg), `${label} --chrome-keycap-bg must be a solid hex keycap, got ${keycapBg}`);
    assert.ok(keycapFg && /^#[0-9a-fA-F]{6}$/.test(keycapFg), `${label} --chrome-keycap-fg must be a solid hex ink, got ${keycapFg}`);
    assert.ok(keycapBorder, `${label} missing --chrome-keycap-border`);
    assert.ok(
      contrastRatio(keycapBg, keycapFg) >= 7,
      `${label} keycap contrast (${keycapBg} on ${keycapFg}) must meet WCAG AAA (>= 7:1)`,
    );
  }

  // Concentric radius ladder: detail (4) <= chip/compact (8) <= control/row (10) <= inset (12) <= panel (16) <= popover/composer/modal (18) <= dialog (20)
  const ladder = [
    '--ui-radius-detail',
    '--ui-radius-chip',
    '--ui-radius-control-compact',
    '--ui-radius-control',
    '--ui-radius-row',
    '--ui-radius-inset',
    '--ui-radius-panel',
    '--ui-radius-popover',
    '--ui-radius-composer',
    '--ui-radius-modal',
    '--ui-radius-dialog',
  ];
  const values = ladder.map((token) => ({ token, px: resolveNumericPx(lightBlock, token) }));
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(
      values[i]!.px >= values[i - 1]!.px,
      `Concentric radius ladder inverted: ${values[i - 1]!.token} (${values[i - 1]!.px}px) > ${values[i]!.token} (${values[i]!.px}px)`,
    );
  }
});

// ─── Full-Repo CSS Ratchet Gate ────────────────────────────────────────────────

test('desktop renderer CSS obeys Peer Frost v2 token protocol without expanding legacy debt', (t) => {
  const rendererSrc = fileURLToPath(new URL('..', import.meta.url));
  const cssFiles = walkCssFiles(rendererSrc).filter(
    (file) => relative(rendererSrc, file) !== 'styles/tokens.css',
  );
  assert.ok(cssFiles.length >= 70, `Unexpected CSS scan scope: ${cssFiles.length} files`);

  const violations: string[] = [];

  for (const file of cssFiles) {
    const rel = relative(rendererSrc, file).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    const result = scanCssSource(source, {
      excludeRawHex: rel === 'chat/styles/code-highlight.css',
    });

    const maxAzure = LEGACY_AZURE_BG_WASH_BASELINE[rel] ?? 0;
    if (result.azureWashes.length > maxAzure) {
      violations.push(
        `[azure-bg-wash] ${rel}: found ${result.azureWashes.length} (allowed <= ${maxAzure}). Use neutral matte --paper-hover / --control-fill instead of --azure-trace:\n  ${result.azureWashes.join('\n  ')}`,
      );
    }

    const maxSpecular = LEGACY_TOP_WHITE_SPECULAR_BASELINE[rel] ?? 0;
    if (result.topSpeculars.length > maxSpecular) {
      violations.push(
        `[top-white-specular] ${rel}: found ${result.topSpeculars.length} (allowed <= ${maxSpecular}). Do not add white top inset highlights:\n  ${result.topSpeculars.join('\n  ')}`,
      );
    }

    const maxHex = LEGACY_RAW_HEX_BASELINE[rel] ?? 0;
    if (result.rawHexes.length > maxHex) {
      violations.push(
        `[raw-hex] ${rel}: found ${result.rawHexes.length} (allowed <= ${maxHex}). Consume canonical Frost tokens from styles/tokens.css instead of raw hex colors:\n  ${result.rawHexes.slice(0, 10).join(', ')}`,
      );
    }

    const maxLegacy = LEGACY_COLOR_ALIAS_BASELINE[rel] ?? 0;
    if (result.legacyColorAliases.length > maxLegacy) {
      violations.push(
        `[legacy-alias] ${rel}: found ${result.legacyColorAliases.length} (allowed <= ${maxLegacy}). Use canonical Frost tokens (--chrome-*, --paper-*, --control-*, --graphite-*, --azure-*, --state-*) instead of --za-* / --pa-* / --ink-*:\n  ${result.legacyColorAliases.slice(0, 10).join(', ')}`,
      );
    }
  }

  t.diagnostic(`Audited ${cssFiles.length} renderer CSS files against Peer Frost v2 token contract`);
  assert.deepEqual(violations, [], `Peer Frost CSS Token Contract violation(s):\n\n${violations.join('\n\n')}`);
});
