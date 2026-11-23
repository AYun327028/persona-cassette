/**
 * @fileoverview Zero-dependency YAML subset parser/serializer and Markdown
 * frontmatter utilities tailored for OKF pages and taxonomy configurations.
 */

const NUMERIC_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UNQUOTED_SAFE_RE = /^[^:#\[\]{},&*!|>'"%@`\s][^:#\[\]{}\r\n]*$/;

/**
 * Strip an unquoted YAML comment (# preceded by start-of-line or whitespace).
 * Preserves '#' inside quotes or joined tokens like `session#step1`.
 *
 * @param {string} line
 * @returns {string}
 */
function stripInlineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'" && line[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

/**
 * Split top-level comma-separated tokens inside `[...]` ignoring quoted commas.
 *
 * @param {string} inner
 * @returns {string[]}
 */
function splitFlowItems(inner) {
  const items = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote === '"') {
      current += ch;
      if (ch === '\\' && i + 1 < inner.length) {
        current += inner[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'" && inner[i + 1] === "'") {
        current += "'";
        i += 1;
        continue;
      }
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    items.push(current.trim());
  }
  return items;
}

/**
 * Parse a YAML scalar or inline collection (`[...]`, `{}`).
 *
 * @param {string} raw
 * @returns {unknown}
 */
function parseScalar(raw) {
  const val = raw.trim();
  if (val === '' || val === 'null' || val === '~') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === '[]') return [];
  if (val === '{}') return {};

  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowItems(inner).map((item) => parseScalar(item));
  }

  if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
    const body = val.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === '\\' && i + 1 < body.length) {
        const next = body[i + 1];
        i += 1;
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else out += next;
      } else {
        out += body[i];
      }
    }
    return out;
  }

  if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
    return val.slice(1, -1).replace(/''/g, "'");
  }

  if (NUMERIC_RE.test(val)) {
    return Number(val);
  }
  return val;
}

/**
 * Split a `key: value` line outside quotes. Returns null if not a key/value line.
 *
 * @param {string} content
 * @returns {{ key: string, value: string } | null}
 */
function splitKeyValue(content) {
  let quote = null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quote === '"') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'" && content[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i === content.length - 1 || /\s/.test(content[i + 1]))) {
      const rawKey = content.slice(0, i).trim();
      if (!rawKey) return null;
      const key = String(parseScalar(rawKey));
      const value = content.slice(i + 1).trim();
      return { key, value };
    }
  }
  return null;
}

function tokenizeLines(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const tokens = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const match = raw.match(/^( *)([\s\S]*)$/);
    const indent = match ? match[1].length : 0;
    const stripped = stripInlineComment(match ? match[2].trimStart() : '');
    if (!stripped) continue;
    tokens.push({ lineNo: i + 1, indent, text: stripped });
  }
  return tokens;
}

function parseBlock(tokens, idx, minIndent) {
  if (idx >= tokens.length) return { value: {}, nextIdx: idx };
  const first = tokens[idx];
  if (first.text === '-' || first.text.startsWith('- ')) {
    return parseSequence(tokens, idx, first.indent);
  }
  return parseMapping(tokens, idx, minIndent);
}

function parseSequence(tokens, startIdx, seqIndent) {
  const arr = [];
  let idx = startIdx;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.indent < seqIndent) break;
    if (tok.indent > seqIndent) {
      throw new SyntaxError(`Unexpected indentation at YAML line ${tok.lineNo}`);
    }
    if (!(tok.text === '-' || tok.text.startsWith('- '))) break;

    const rest = tok.text === '-' ? '' : tok.text.slice(2).trim();
    if (!rest) {
      idx += 1;
      if (idx < tokens.length && tokens[idx].indent > seqIndent) {
        const nested = parseBlock(tokens, idx, tokens[idx].indent);
        arr.push(nested.value);
        idx = nested.nextIdx;
      } else {
        arr.push(null);
      }
      continue;
    }

    const kv = splitKeyValue(rest);
    if (kv) {
      const obj = {};
      const itemIndent = seqIndent + 2;
      idx += 1;
      if (kv.value) {
        obj[kv.key] = parseScalar(kv.value);
      } else if (idx < tokens.length && tokens[idx].indent > itemIndent) {
        const nested = parseBlock(tokens, idx, tokens[idx].indent);
        obj[kv.key] = nested.value;
        idx = nested.nextIdx;
      } else {
        obj[kv.key] = null;
      }
      if (idx < tokens.length && tokens[idx].indent >= itemIndent && !(tokens[idx].text.startsWith('- '))) {
        const more = parseMapping(tokens, idx, tokens[idx].indent);
        Object.assign(obj, more.value);
        idx = more.nextIdx;
      }
      arr.push(obj);
      continue;
    }

    arr.push(parseScalar(rest));
    idx += 1;
  }
  return { value: arr, nextIdx: idx };
}

function parseMapping(tokens, startIdx, mapIndent) {
  const obj = {};
  let idx = startIdx;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.indent < mapIndent) break;
    if (tok.text === '-' || tok.text.startsWith('- ')) break;

    const kv = splitKeyValue(tok.text);
    if (!kv) {
      throw new SyntaxError(`Invalid YAML mapping at line ${tok.lineNo}: "${tok.text}"`);
    }
    idx += 1;
    if (kv.value) {
      obj[kv.key] = parseScalar(kv.value);
    } else if (
      idx < tokens.length &&
      (tokens[idx].indent > tok.indent ||
        (tokens[idx].indent === tok.indent &&
          (tokens[idx].text === '-' || tokens[idx].text.startsWith('- '))))
    ) {
      const childIndent = tokens[idx].indent;
      const nested = parseBlock(tokens, idx, childIndent);
      obj[kv.key] = nested.value;
      idx = nested.nextIdx;
    } else {
      obj[kv.key] = null;
    }
  }
  return { value: obj, nextIdx: idx };
}

/**
 * Parse YAML subset text into a JavaScript object or array.
 *
 * @param {string} text
 * @returns {Record<string, any> | any[]}
 */
export function parseYaml(text) {
  const tokens = tokenizeLines(text);
  if (tokens.length === 0) return {};
  const { value } = parseBlock(tokens, 0, tokens[0].indent);
  return value;
}

function needsQuotes(str) {
  if (str === '') return true;
  if (str !== str.trim()) return true;
  if (str === 'true' || str === 'false' || str === 'null' || str === '~') return true;
  if (NUMERIC_RE.test(str)) return true;
  if (/[\r\n]/.test(str)) return true;
  if (str.includes(': ') || str.endsWith(':') || str.includes(' #')) return true;
  return !UNQUOTED_SAFE_RE.test(str);
}

function formatScalar(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  const str = String(val);
  if (!needsQuotes(str)) return str;
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function formatKey(key) {
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : formatScalar(key);
}

function serializeValue(val, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(val)) {
    if (val.length === 0) return ['[]'];
    const lines = [];
    for (const item of val) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          lines.push(`${pad}- {}`);
        } else {
          const [k0, v0] = entries[0];
          if (v0 !== null && typeof v0 === 'object') {
            lines.push(`${pad}- ${formatKey(k0)}:`);
            lines.push(...serializeValue(v0, indent + 4));
          } else {
            lines.push(`${pad}- ${formatKey(k0)}: ${formatScalar(v0)}`);
          }
          for (let i = 1; i < entries.length; i += 1) {
            const [k, v] = entries[i];
            if (v !== null && typeof v === 'object') {
              lines.push(`${pad}  ${formatKey(k)}:`);
              lines.push(...serializeValue(v, indent + 4));
            } else {
              lines.push(`${pad}  ${formatKey(k)}: ${formatScalar(v)}`);
            }
          }
        }
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        lines.push(...serializeValue(item, indent + 2));
      } else {
        lines.push(`${pad}- ${formatScalar(item)}`);
      }
    }
    return lines;
  }

  if (val !== null && typeof val === 'object') {
    const entries = Object.entries(val);
    if (entries.length === 0) return ['{}'];
    const lines = [];
    for (const [k, v] of entries) {
      if (Array.isArray(v)) {
        if (v.length === 0) {
          lines.push(`${pad}${formatKey(k)}: []`);
        } else {
          lines.push(`${pad}${formatKey(k)}:`);
          lines.push(...serializeValue(v, indent + 2));
        }
      } else if (v !== null && typeof v === 'object') {
        const subEntries = Object.entries(v);
        if (subEntries.length === 0) {
          lines.push(`${pad}${formatKey(k)}: {}`);
        } else {
          lines.push(`${pad}${formatKey(k)}:`);
          lines.push(...serializeValue(v, indent + 2));
        }
      } else {
        lines.push(`${pad}${formatKey(k)}: ${formatScalar(v)}`);
      }
    }
    return lines;
  }

  return [`${pad}${formatScalar(val)}`];
}

/**
 * Serialize a JavaScript object or array into deterministic YAML text.
 *
 * @param {Record<string, any> | any[]} obj
 * @returns {string}
 */
export function stringifyYaml(obj) {
  return `${serializeValue(obj, 0).join('\n')}\n`;
}

/**
 * Parse leading YAML frontmatter from a Markdown string.
 *
 * @param {string} markdown
 * @returns {{ hasFrontmatter: boolean, data: Record<string, any>, body: string }}
 */
export function parseFrontmatter(markdown) {
  const normalized = String(markdown ?? '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) {
    return { hasFrontmatter: false, data: {}, body: normalized };
  }
  const parsed = parseYaml(match[1]);
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return { hasFrontmatter: true, data, body: match[2] };
}

/**
 * Serialize frontmatter metadata and Markdown body cleanly.
 *
 * @param {Record<string, any>} data
 * @param {string} body
 * @returns {string}
 */
export function serializeFrontmatter(data, body) {
  const yaml = stringifyYaml(data).trimEnd();
  const cleanBody = String(body ?? '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  return `---\n${yaml}\n---\n\n${cleanBody}${cleanBody.endsWith('\n') || !cleanBody ? '' : '\n'}`;
}
