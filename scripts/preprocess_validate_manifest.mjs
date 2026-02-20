#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const map = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      map.set(key.slice(2), 'true');
    } else {
      map.set(key.slice(2), next);
      i += 1;
    }
  }
  return map;
}

function usage() {
  console.log('Usage: node scripts/preprocess_validate_manifest.mjs --manifest <outputs/job_xxx/manifest.json>');
}

function assertField(obj, field, kind) {
  if (!(field in obj)) {
    throw new Error(`Missing field: ${field}`);
  }
  if (kind === 'string' && typeof obj[field] !== 'string') {
    throw new Error(`Field ${field} must be string`);
  }
}

const args = parseArgs(process.argv);
const manifestPath = args.get('manifest');
if (!manifestPath) {
  usage();
  process.exit(2);
}

try {
  const absoluteManifest = path.resolve(manifestPath);
  const raw = fs.readFileSync(absoluteManifest, 'utf8');
  const manifest = JSON.parse(raw);

  assertField(manifest, 'version', 'string');
  assertField(manifest, 'source', 'string');
  assertField(manifest, 'createdAt', 'string');
  assertField(manifest, 'baseImageUrl', 'string');
  assertField(manifest, 'maskPackUrl', 'string');
  assertField(manifest, 'flowHintUrl', 'string');

  const outputDir = path.dirname(absoluteManifest);
  const requiredFiles = [manifest.baseImageUrl, manifest.maskPackUrl, manifest.flowHintUrl];
  for (const rel of requiredFiles) {
    const target = path.resolve(outputDir, rel);
    if (!fs.existsSync(target)) {
      throw new Error(`Referenced file not found: ${target}`);
    }
  }

  const maskPackPath = path.resolve(outputDir, manifest.maskPackUrl);
  const maskPack = JSON.parse(fs.readFileSync(maskPackPath, 'utf8'));
  assertField(maskPack, 'regionMaskUrl', 'string');
  assertField(maskPack, 'edgeMaskUrl', 'string');
  assertField(maskPack, 'confidenceUrl', 'string');

  for (const rel of [maskPack.regionMaskUrl, maskPack.edgeMaskUrl, maskPack.confidenceUrl]) {
    const target = path.resolve(outputDir, rel);
    if (!fs.existsSync(target)) {
      throw new Error(`Mask pack file not found: ${target}`);
    }
  }

  console.log(`manifest: ${absoluteManifest}`);
  console.log('PASS: manifest schema and artifact references are valid.');
} catch (error) {
  console.error('FAIL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

