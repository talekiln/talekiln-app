#!/usr/bin/env node
// Sign a plugin folder: writes `files` + `signature` into its manifest.json (or --out <file>).
//
//   TALEKILN_PLUGIN_SIGNING_KEY_FILE=/secure/path/plugin-signing.pem \
//   node scripts/sign-plugin.mjs <pluginDir> --kid <key id> [--out <manifest path>] [--dry-run]
//
//   node scripts/sign-plugin.mjs <pluginDir> --inspect
//     No key needed: prints the file list, each file's sha256 and the package fingerprint (hash) as JSON. The
//     fingerprint is what the cloud registry records for a submission and what the desktop plugin page shows,
//     so a reviewer can check a downloaded package against the registry entry before approving it.
//
// The private key (EC P-256, PKCS8 PEM) is read ONLY from the file named by TALEKILN_PLUGIN_SIGNING_KEY_FILE
// (or, for CI secret stores, inline from TALEKILN_PLUGIN_SIGNING_KEY_PEM with `\n` escapes). Never pass it as
// an argument and never commit it. The key id must match the `kid` published in the official JWKS.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const sdk = require('../src');

function parseArgs(argv) {
  const out = { dir: null, kid: process.env.TALEKILN_PLUGIN_SIGNING_KID || null, out: null, dryRun: false, inspect: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kid') out.kid = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--inspect') out.inspect = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!out.dir) out.dir = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return out;
}

/** Key-less report: what a submission to the registry (or a reviewer's check) needs. */
function inspect(dir, raw) {
  const v = sdk.validateManifest(raw);
  if (!v.ok) throw new Error(`manifest is invalid: ${v.errors.join('; ')}`);
  let files = raw.files;
  if (!files) {
    const listed = sdk.listPluginFiles(dir);
    if (listed.symlinks.length) throw new Error(`symbolic links are not allowed in a plugin package: ${listed.symlinks[0]}`);
    files = listed.files;
  }
  files = [...new Set(files)].sort();
  const { signature: _s, ...unsigned } = raw;
  const manifest = { ...unsigned, files };
  const fileHashes = sdk.hashFiles(dir, files);
  const hash = sdk.payloadHash(sdk.signingPayload(manifest, fileHashes));
  const check = sdk.verifySignature(raw, dir, () => null);
  return {
    name: raw.name, version: raw.version, files, fileHashes, hash, manifest,
    signature: { status: check.status, reason: check.reason, kid: check.kid },
  };
}

function loadPrivateKey(env) {
  if (env.TALEKILN_PLUGIN_SIGNING_KEY_FILE) return readFileSync(env.TALEKILN_PLUGIN_SIGNING_KEY_FILE, 'utf8');
  if (env.TALEKILN_PLUGIN_SIGNING_KEY_PEM) return env.TALEKILN_PLUGIN_SIGNING_KEY_PEM.replace(/\\n/g, '\n');
  throw new Error('set TALEKILN_PLUGIN_SIGNING_KEY_FILE (path to an EC P-256 PKCS8 PEM) or TALEKILN_PLUGIN_SIGNING_KEY_PEM');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.dir) {
    console.log('usage: sign-plugin.mjs <pluginDir> --kid <kid> [--out <manifest.json>] [--dry-run]\n'
      + '       sign-plugin.mjs <pluginDir> --inspect   (no key: files, hashes and fingerprint as JSON)\n'
      + '       private key: TALEKILN_PLUGIN_SIGNING_KEY_FILE=<pem path> (or TALEKILN_PLUGIN_SIGNING_KEY_PEM)');
    process.exit(args.help ? 0 : 2);
  }
  const dir = resolve(args.dir);
  const manifestPath = join(dir, 'manifest.json');
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (args.inspect) {
    console.log(JSON.stringify(inspect(dir, raw), null, 2));
    return;
  }
  if (!args.kid) throw new Error('--kid is required (or TALEKILN_PLUGIN_SIGNING_KID)');
  const { manifest, hash, files } = sdk.signManifest(raw, dir, loadPrivateKey(process.env), { kid: args.kid });
  const v = sdk.validateManifest(manifest);
  if (!v.ok) throw new Error(`signed manifest is invalid: ${v.errors.join('; ')}`);
  const check = sdk.verifySignature(manifest, dir, () => null);
  if (check.status !== 'invalid' || check.reason !== 'unknown kid') throw new Error(`self-check failed: ${check.reason}`);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!args.dryRun) writeFileSync(args.out ? resolve(args.out) : manifestPath, text, 'utf8');
  console.log(`${args.dryRun ? '[dry-run] ' : ''}signed ${manifest.name}@${manifest.version} kid=${args.kid} files=${files.length} hash=${hash}`);
}

try { main(); } catch (e) {
  console.error(`sign-plugin: ${e.message}`);
  process.exit(1);
}
