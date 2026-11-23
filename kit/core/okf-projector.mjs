/**
 * @fileoverview Lossless one-way projection from OKF Markdown files under `wiki/`
 * into RiverMemo ingestible documents, preserving ordered anchors + tag_chain.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './ledger.mjs';
import { parseFrontmatter } from './yaml-lite.mjs';

export const ACTIVE_WIKI_DIARIES = ['projects', 'domains', 'decisions', 'episodes', 'syntheses'];

const IMPORTANCE_ORDER = { low: 1, normal: 2, high: 3, core: 4 };

/**
 * Project active OKF wiki pages into clean RiverMemo documents without mutating
 * any source Markdown files. Explicitly skips `wiki/archive/`, `wiki/index.md`,
 * `wiki/log.md`, and pages with `status === 'archived'`.
 *
 * @param {string} vaultPath
 * @param {{ filters?: { include_diaries?: string[] | null, exclude_domains?: string[], min_importance?: string | null } }} [rules]
 */
export async function projectVaultToRiverDocs(vaultPath, rules = {}) {
  const filters = rules?.filters || {};
  const includeDiaries = Array.isArray(filters.include_diaries) && filters.include_diaries.length > 0
    ? new Set(filters.include_diaries.map(String))
    : null;
  const excludeDomains = new Set(
    Array.isArray(filters.exclude_domains) ? filters.exclude_domains.map(String) : []
  );
  const minRank = filters.min_importance ? (IMPORTANCE_ORDER[filters.min_importance] || 1) : 1;

  const wikiRoot = path.join(vaultPath, 'wiki');
  const docs = [];

  for (const diaryName of ACTIVE_WIKI_DIARIES) {
    if (includeDiaries && !includeDiaries.has(diaryName)) continue;
    const dirPath = path.join(wikiRoot, diaryName);

    let entries = [];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }

    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of mdFiles) {
      const absPath = path.join(dirPath, fileName);
      const relPath = `wiki/${diaryName}/${fileName}`;
      const stat = await fs.stat(absPath);
      const raw = await fs.readFile(absPath, 'utf8');
      const fm = parseFrontmatter(raw);
      const data = fm.data || {};

      if (data.status === 'archived') continue;

      const domains = Array.isArray(data.domain)
        ? data.domain.map(String)
        : (data.domain ? [String(data.domain)] : []);
      if (domains.some((d) => excludeDomains.has(d))) continue;

      const impRank = IMPORTANCE_ORDER[String(data.importance || 'normal')] || 2;
      if (impRank < minRank) continue;

      const anchors = Array.isArray(data.anchors) ? data.anchors.map(String).filter(Boolean) : [];
      const tagChain = Array.isArray(data.tag_chain) ? data.tag_chain.map(String).filter(Boolean) : [];
      const orderedTags = [...new Set([...anchors, ...tagChain])];

      const title = String(data.title || path.basename(fileName, '.md')).trim();
      const bodyClean = String(fm.body || '').trim();
      const tagTail = orderedTags.length > 0 ? `\n\nTag: ${orderedTags.join(', ')}\n` : '\n';
      const projectedText = `# ${title}\n\n${bodyClean}${tagTail}`;

      docs.push({
        relPath,
        diaryName,
        title,
        projectedText,
        orderedTags,
        checksum: sha256(projectedText),
        mtime: Math.floor(stat.mtimeMs),
        size: Buffer.byteLength(projectedText, 'utf8'),
        okfMeta: {
          id: String(data.id || relPath),
          title,
          relPath,
          diaryName,
          type: String(data.type || 'concept'),
          status: String(data.status || 'active'),
          domain: domains,
          importance: String(data.importance || 'normal'),
          confidence: String(data.confidence || 'high'),
          updated_at: String(data.updated_at || ''),
          anchors,
          tag_chain: tagChain,
          sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
          excerpt: bodyClean
        }
      });
    }
  }

  docs.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const diaryNames = [...new Set(docs.map((d) => d.diaryName))];
  return { docs, diaryNames };
}
