#!/usr/bin/env node
/**
 * @fileoverview Standalone installer for the Antigravity deep-tuned example
 * plugin. Automatically rewrites `hooks.json` and `mcp_config.json` with the
 * user's real cloned paths so zero manual path editing is required.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEST = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'persona-cassette-memory');

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags[k] = true;
      else {
        flags[k] = next;
        i += 1;
      }
    }
  }
  return flags;
}

async function copyDirRecursive(src, dest, skipNames = new Set()) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDirRecursive(sPath, dPath, skipNames);
    else if (entry.isFile()) await fs.copyFile(sPath, dPath);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const destDir = flags.target ? path.resolve(String(flags.target)) : DEFAULT_DEST;
  const toForward = (p) => path.resolve(p).replace(/\\/g, '/');

  await copyDirRecursive(EXAMPLE_DIR, destDir, new Set(['tests', 'sample-workspace', 'README.md']));

  const pluginJsonPath = path.join(destDir, 'plugin.json');
  const pluginJson = JSON.parse(await fs.readFile(pluginJsonPath, 'utf8'));
  pluginJson.disabled = !Boolean(flags.enable);
  await fs.writeFile(pluginJsonPath, `${JSON.stringify(pluginJson, null, 2)}\n`, 'utf8');

  const hooksJson = {
    [pluginJson.name || 'persona-cassette-memory']: {
      SessionStart: [
        { type: 'command', command: `node "${toForward(path.join(EXAMPLE_DIR, 'hook-session-start.mjs'))}"`, timeout: 10 }
      ],
      PreInvocation: [
        { type: 'command', command: `node "${toForward(path.join(EXAMPLE_DIR, 'hook-pre-invocation.mjs'))}"`, timeout: 15 }
      ],
      Stop: [
        { type: 'command', command: `node "${toForward(path.join(EXAMPLE_DIR, 'hook-stop.mjs'))}"`, timeout: 10 }
      ]
    }
  };
  await fs.writeFile(path.join(destDir, 'hooks.json'), `${JSON.stringify(hooksJson, null, 2)}\n`, 'utf8');

  const mcpJson = {
    mcpServers: {
      'pmv-memory': {
        command: 'node',
        args: [toForward(path.join(EXAMPLE_DIR, 'mcp-server.mjs'))]
      }
    }
  };
  await fs.writeFile(path.join(destDir, 'mcp_config.json'), `${JSON.stringify(mcpJson, null, 2)}\n`, 'utf8');

  console.log(
    JSON.stringify(
      { installed: true, source: EXAMPLE_DIR, target: destDir, enabled: !pluginJson.disabled },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(`[install-antigravity-example error] ${err?.message || err}`);
  process.exit(1);
});
