/**
 * @fileoverview Multi-dimensional tag governance, OKF frontmatter linting,
 * RiverMemo body-closure checks, and generated `tags/index.md` + `tags/chains.md`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, parseYaml, serializeFrontmatter } from './yaml-lite.mjs';

const REQUIRED_FIELDS = [
  'id',
  'title',
  'type',
  'status',
  'domain',
  'anchors',
  'tag_chain',
  'sources',
  'updated_at',
  'compiled_by'
];

function cleanTagString(raw) {
  return String(raw ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/[，。；：、]+$/g, '')
    .replace(/^[，。；：、]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForClosure(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\-_`"''“”‘’]/g, '');
}

async function collectActiveWikiFiles(wikiRoot) {
  const results = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(wikiRoot, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (rel === 'archive' || rel.startsWith('archive/')) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (rel === 'index.md' || rel === 'log.md') continue;
        results.push({ fullPath, relPath: `wiki/${rel}` });
      }
    }
  }
  await walk(wikiRoot);
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return results;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function renderTagsIndexMd(pages) {
  const byTag = new Map();
  const byDomain = new Map();

  for (const page of pages) {
    for (const dom of page.domains) {
      if (!byDomain.has(dom)) byDomain.set(dom, []);
      byDomain.get(dom).push(page);
    }
    const allTags = [...new Set([...page.anchors, ...page.tagChain])];
    for (const tag of allTags) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(page);
    }
  }

  const lines = [
    '# Tags 反查总索引',
    '',
    '> 由 `pmv lint-tags --fix` 自动生成，请勿手动编辑。',
    '',
    `活跃记忆页总数：${pages.length} | 唯一概念节点数：${byTag.size}`,
    '',
    '## 按领域（Domains）',
    ''
  ];

  for (const [dom, list] of [...byDomain.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const links = list.map((p) => `[${p.title}](../${p.relPath})`).join('、');
    lines.push(`- **${dom}** (${list.length}): ${links}`);
  }

  lines.push('', '## 按概念标签（Anchors & Tag Chains）', '');
  for (const [tag, list] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const links = list.map((p) => `[${p.title}](../${p.relPath})`).join('、');
    lines.push(`- \`${tag}\` (${list.length}): ${links}`);
  }

  return `${lines.join('\n')}\n`;
}

function renderTagChainsMd(pages) {
  const lines = [
    '# RiverMemo 有序标签河道图（Tag Chains）',
    '',
    '> 由 `pmv lint-tags --fix` 自动生成，便于人工巡检每篇记忆的因果流向与直接锚点。',
    ''
  ];

  for (const page of pages) {
    const anchorsText = page.anchors.length > 0 ? page.anchors.join(', ') : '(无)';
    const chainText = page.tagChain.length > 0 ? page.tagChain.join(' -> ') : '(无)';
    lines.push(`- **[${page.title}](../${page.relPath})** \`[${page.id}]\``);
    lines.push(`  - Anchors: ${anchorsText}`);
    lines.push(`  - Chain: ${chainText}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Lint (and optionally auto-fix) OKF frontmatter tags, aliases, blacklist,
 * relative links, and RiverMemo body closure across active wiki pages.
 *
 * @param {string} vaultPath
 * @param {{ fix?: boolean, decisionClient?: any }} [options]
 */
export async function lintTags(vaultPath, options = {}) {
  const fix = options.fix === true;
  const decisionClient = options.decisionClient || null;

  const taxonomyPath = path.join(vaultPath, 'tags', 'taxonomy.yaml');
  const taxonomyRaw = await fs.readFile(taxonomyPath, 'utf8');
  const taxonomy = parseYaml(taxonomyRaw) || {};

  const allowedDomains = new Set(Array.isArray(taxonomy.domains) ? taxonomy.domains : []);
  const aliases = taxonomy.aliases && typeof taxonomy.aliases === 'object' ? taxonomy.aliases : {};
  const blacklist = new Set(
    (Array.isArray(taxonomy.blacklist) ? taxonomy.blacklist : []).map((w) => cleanTagString(w).toLowerCase())
  );
  const minChain = Number(taxonomy.tag_chain_rules?.min_length ?? 2);
  const maxChain = Number(taxonomy.tag_chain_rules?.max_length ?? 8);
  const requireClosure = taxonomy.tag_chain_rules?.require_body_closure !== false;

  const wikiRoot = path.join(vaultPath, 'wiki');
  const wikiFiles = await collectActiveWikiFiles(wikiRoot);

  const parsedPages = [];
  const allIds = new Set();

  for (const file of wikiFiles) {
    const raw = await fs.readFile(file.fullPath, 'utf8');
    const fm = parseFrontmatter(raw);
    if (fm.data?.id) allIds.add(String(fm.data.id));
    parsedPages.push({ ...file, ...fm });
  }

  const issues = [];
  const plannedFixes = [];
  const activeSummaryPages = [];
  const tagCounts = new Map();

  for (const page of parsedPages) {
    if (!page.hasFrontmatter) {
      issues.push({ file: page.relPath, severity: 'error', code: 'missing_frontmatter', message: 'Missing YAML frontmatter' });
      continue;
    }

    const data = structuredClone(page.data);
    if (data.status === 'archived') continue;

    for (const field of REQUIRED_FIELDS) {
      if (data[field] === undefined || data[field] === null || data[field] === '') {
        issues.push({ file: page.relPath, severity: 'error', code: 'missing_field', message: `Missing required field "${field}"` });
      }
    }

    let fileChanged = false;

    const normalizeTagArray = (arr, fieldName, allowDomainAlias = false) => {
      if (!Array.isArray(arr)) return [];
      const seen = new Set();
      const result = [];

      for (const rawItem of arr) {
        const rawStr = String(rawItem ?? '');
        let cleaned = cleanTagString(rawStr);
        if (cleaned !== rawStr) {
          fileChanged = true;
          plannedFixes.push({ file: page.relPath, field: fieldName, action: 'normalize_punctuation', from: rawStr, to: cleaned });
        }

        if (aliases[cleaned]) {
          const canonical = String(aliases[cleaned]);
          fileChanged = true;
          plannedFixes.push({ file: page.relPath, field: fieldName, action: 'resolve_alias', from: cleaned, to: canonical });
          cleaned = canonical;
        }

        if (!cleaned) continue;
        if (seen.has(cleaned)) {
          fileChanged = true;
          plannedFixes.push({ file: page.relPath, field: fieldName, action: 'deduplicate', value: cleaned });
          continue;
        }
        seen.add(cleaned);
        result.push(cleaned);

        if (allowDomainAlias && allowedDomains.size > 0 && !allowedDomains.has(cleaned)) {
          issues.push({ file: page.relPath, severity: 'error', code: 'unknown_domain', message: `Domain "${cleaned}" is not in taxonomy.yaml` });
        }
        if (!allowDomainAlias && blacklist.has(cleaned.toLowerCase())) {
          issues.push({ file: page.relPath, severity: 'error', code: 'blacklisted_tag', message: `Tag "${cleaned}" in ${fieldName} is blacklisted` });
        }
      }
      return result;
    };

    const nextDomains = normalizeTagArray(Array.isArray(data.domain) ? data.domain : [data.domain].filter(Boolean), 'domain', true);
    const nextAnchors = normalizeTagArray(Array.isArray(data.anchors) ? data.anchors : [], 'anchors', false);
    const nextChain = normalizeTagArray(Array.isArray(data.tag_chain) ? data.tag_chain : [], 'tag_chain', false);

    data.domain = nextDomains;
    data.anchors = nextAnchors;
    data.tag_chain = nextChain;

    if (nextChain.length < minChain || nextChain.length > maxChain) {
      issues.push({
        file: page.relPath,
        severity: 'warning',
        code: 'tag_chain_length',
        message: `tag_chain length ${nextChain.length} is outside [${minChain}, ${maxChain}]`
      });
    }

    if (requireClosure) {
      const normalizedBody = normalizeForClosure(page.body);
      const unclosed = [...new Set([...nextAnchors, ...nextChain])].filter(
        (tag) => !normalizedBody.includes(normalizeForClosure(tag))
      );

      for (const tag of unclosed) {
        let softClosed = false;
        if (decisionClient && decisionClient.isActive()) {
          const res = await decisionClient.evaluate({
            state: page.body.slice(0, 3500),
            questions: {
              covered: {
                type: 'noul',
                instructions: `Does the document body substantively discuss or support the concept "${tag}"?`
              }
            }
          });
          if (!res.degraded && Number(res.answers?.covered?.noul) >= 0.75) {
            softClosed = true;
          }
        }
        if (!softClosed) {
          issues.push({
            file: page.relPath,
            severity: 'error',
            code: 'unclosed_tag',
            message: `Tag "${tag}" is not closed (absent) in document body`
          });
        }
      }
    }

    if (Array.isArray(data.supersedes)) {
      for (const refId of data.supersedes) {
        if (!allIds.has(String(refId))) {
          issues.push({
            file: page.relPath,
            severity: 'warning',
            code: 'broken_supersedes',
            message: `supersedes target "${refId}" was not found among wiki pages`
          });
        }
      }
    }

    const mdLinks = page.body.matchAll(/\[[^\]]+\]\(([^)#?\s]+\.md)(?:#[^)]*)?\)/g);
    for (const m of mdLinks) {
      const relTarget = m[1];
      if (/^https?:\/\//i.test(relTarget)) continue;
      const absTarget = path.resolve(path.dirname(page.fullPath), relTarget);
      if (!(await fileExists(absTarget))) {
        issues.push({
          file: page.relPath,
          severity: 'error',
          code: 'broken_link',
          message: `Broken relative link target "${relTarget}"`
        });
      }
    }

    for (const tag of new Set([...nextAnchors, ...nextChain])) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }

    if (fix && fileChanged) {
      await fs.writeFile(page.fullPath, serializeFrontmatter(data, page.body), 'utf8');
    }

    activeSummaryPages.push({
      id: String(data.id || page.relPath),
      title: String(data.title || page.relPath),
      relPath: page.relPath,
      domains: nextDomains,
      anchors: nextAnchors,
      tagChain: nextChain
    });
  }

  const orphanTags = [];
  if (activeSummaryPages.length >= 5) {
    for (const [tag, count] of tagCounts.entries()) {
      if (count === 1) orphanTags.push(tag);
    }
  }

  if (fix) {
    const tagsDir = path.join(vaultPath, 'tags');
    await fs.mkdir(tagsDir, { recursive: true });
    await fs.writeFile(path.join(tagsDir, 'index.md'), renderTagsIndexMd(activeSummaryPages), 'utf8');
    await fs.writeFile(path.join(tagsDir, 'chains.md'), renderTagChainsMd(activeSummaryPages), 'utf8');
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  return {
    filesScanned: parsedPages.length,
    activePages: activeSummaryPages.length,
    errors,
    warnings,
    orphanTags,
    issues,
    plannedFixes,
    appliedFixes: fix ? plannedFixes.length : 0
  };
}
