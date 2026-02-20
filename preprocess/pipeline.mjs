import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { deriveStructureHintsWithGemini, stylizeWithNanoBanana } from './models.mjs';
import { ensureDir, readImageAsRgba, writeFlowHintPng, writeGrayPng, writeRgbaPng } from './image_io.mjs';
import {
  buildFlowHintFromRgba,
  dilateBinaryMask,
  extractEdgesFromRgba,
  extractRegionMasksFromRgba,
} from './vision.mjs';
import { maybeGenerateOptionalSvg } from './svg_optional.mjs';

function parseArgs(argv) {
  const map = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      continue;
    }
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

function parseBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') {
    return true;
  }
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') {
    return false;
  }
  return fallback;
}

function makeJobId(seed = new Date()) {
  const iso = seed.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
  return `job_${iso}_${rand}`;
}

function toUint8FromFloat(values) {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const v = Math.max(0, Math.min(1, values[i]));
    out[i] = Math.round(v * 255);
  }
  return out;
}

function buildRegionMask(regionIds, regionCount) {
  const out = new Uint8Array(regionIds.length);
  const denom = Math.max(1, regionCount - 1);
  for (let i = 0; i < regionIds.length; i += 1) {
    out[i] = Math.round((regionIds[i] / denom) * 255);
  }
  return out;
}

function usage() {
  console.log(
    [
      'Usage: node scripts/preprocess_run.mjs --input <file>',
      '',
      'Options:',
      '  --input <path>             Source image path (required)',
      '  --output-root <path>       Root output dir (default: outputs)',
      '  --job-id <id>              Custom job id',
      '  --width <number>           Max width for preprocessing (default: 1280)',
      '  --height <number>          Max height for preprocessing (default: 1280)',
      '  --clusters <8..12>         Base cluster count before model tuning (default: 10)',
      '  --edge-threshold <0..1>    Base edge threshold before model tuning (default: 0.18)',
      '  --edge-dilate <0..5>       Base dilation rounds before model tuning (default: 2)',
      '  --flow-smoothing <0..4>    Base flow smoothing rounds before model tuning (default: 2)',
      '  --seed <int>               Deterministic seed for region extraction (default: 42)',
      '  --style-preset <name>      Stylization preset: balanced|graphic|texture',
      '  --style-prompt <text>      Optional stylization prompt for remote model',
      '  --enable-svg <bool>        Allow optional SVG enhancement path (default: true)',
      '  --use-remote-models <bool> Allow Nano Banana + Gemini API calls (default: true)',
      '  --gemini-model <id>        Override Gemini model id',
      '',
      'Environment (optional):',
      '  NANO_BANANA_API_URL / NANO_BANANA_API_KEY / NANO_BANANA_MODEL',
      '  GEMINI_API_KEY / GEMINI_MODEL',
    ].join('\n'),
  );
}

export async function runPreprocess(options) {
  const inputPath = path.resolve(options.input);
  if (!existsSync(inputPath)) {
    throw new Error(`Input image not found: ${inputPath}`);
  }

  const outputRoot = path.resolve(options.outputRoot || 'outputs');
  const jobId = options.jobId || makeJobId();
  const outputDir = path.join(outputRoot, jobId);
  await ensureDir(outputDir);

  const source = await readImageAsRgba(inputPath, {
    width: options.width,
    height: options.height,
  });

  const stylizeResult = await stylizeWithNanoBanana(source, {
    useRemoteModels: options.useRemoteModels,
    stylePreset: options.stylePreset,
    stylePrompt: options.stylePrompt,
  });

  const defaults = {
    clusters: options.clusters,
    edgeThreshold: options.edgeThreshold,
    edgeDilate: options.edgeDilate,
    flowSmoothing: options.flowSmoothing,
  };

  const structureResult = await deriveStructureHintsWithGemini(stylizeResult.image, defaults, {
    useRemoteModels: options.useRemoteModels,
    enableSvg: options.enableSvg,
    geminiModel: options.geminiModel,
  });

  const tuned = structureResult.hints;
  const region = extractRegionMasksFromRgba(stylizeResult.image, tuned.clusters, options.seed);
  let edge = extractEdgesFromRgba(stylizeResult.image, tuned.edgeThreshold, tuned.edgeDilate);
  const flow = buildFlowHintFromRgba(stylizeResult.image, tuned.flowSmoothing);

  const svgResult = await maybeGenerateOptionalSvg(edge.edgeMask, edge.width, edge.height, {
    enableSvg: options.enableSvg,
    suggestedByModel: tuned.enableSvg,
    outputDir,
  });

  if (svgResult.applied) {
    edge = {
      ...edge,
      edgeMask: dilateBinaryMask(edge.edgeMask, edge.width, edge.height, 1),
    };
  }

  const baseFile = 'base.png';
  const regionFile = 'mask_region.png';
  const edgeFile = 'mask_edge.png';
  const confidenceFile = 'mask_confidence.png';
  const flowFile = 'flow_hint.png';
  const maskPackFile = 'mask_pack.json';

  await writeRgbaPng(path.join(outputDir, baseFile), stylizeResult.image);
  await writeGrayPng(path.join(outputDir, regionFile), region.width, region.height, buildRegionMask(region.regionIds, region.regionCount));
  await writeGrayPng(path.join(outputDir, edgeFile), edge.width, edge.height, edge.edgeMask);
  await writeGrayPng(path.join(outputDir, confidenceFile), region.width, region.height, toUint8FromFloat(region.confidence));
  await writeFlowHintPng(path.join(outputDir, flowFile), flow.width, flow.height, flow.vectors, flow.magnitude);

  const maskPack = {
    version: '1.0.0',
    regionMaskUrl: `./${regionFile}`,
    edgeMaskUrl: `./${edgeFile}`,
    confidenceUrl: `./${confidenceFile}`,
    regionCount: region.regionCount,
    encoding: {
      regionMask: 'grayscale (0..255 mapped from region id)',
      edgeMask: 'binary grayscale (0/255)',
      confidence: 'grayscale confidence [0..255]',
    },
  };

  const maskPackPath = path.join(outputDir, maskPackFile);
  await fs.writeFile(maskPackPath, `${JSON.stringify(maskPack, null, 2)}\n`, 'utf8');

  const manifest = {
    version: '1.0.0',
    source: path.relative(process.cwd(), inputPath),
    createdAt: new Date().toISOString(),
    baseImageUrl: `./${baseFile}`,
    maskPackUrl: `./${maskPackFile}`,
    flowHintUrl: `./${flowFile}`,
    meta: {
      jobId,
      dimensions: {
        width: source.width,
        height: source.height,
      },
      model: {
        nanoBanana: {
          mode: stylizeResult.mode,
          model: stylizeResult.model,
          reason: stylizeResult.reason || null,
        },
        gemini: {
          mode: structureResult.mode,
          model: structureResult.model,
          reason: structureResult.reason || null,
        },
      },
      params: {
        clusters: tuned.clusters,
        edgeThreshold: tuned.edgeThreshold,
        edgeDilate: tuned.edgeDilate,
        flowSmoothing: tuned.flowSmoothing,
        seed: options.seed,
      },
      svg: {
        enabled: options.enableSvg,
        applied: svgResult.applied,
        svgUrl: svgResult.svgUrl,
        lineCount: svgResult.lineCount,
        reason: svgResult.reason,
      },
    },
  };

  const manifestPath = path.join(outputDir, 'manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    outputDir,
    manifestPath,
    manifest,
    maskPackPath,
    artifacts: [baseFile, regionFile, edgeFile, confidenceFile, flowFile, maskPackFile, 'manifest.json'],
  };
}

function argsToOptions(argv) {
  const args = parseArgs(argv);
  const input = args.get('input');
  if (!input) {
    return null;
  }

  return {
    input,
    outputRoot: args.get('output-root') || 'outputs',
    jobId: args.get('job-id') || null,
    width: Math.max(256, Number(args.get('width') || 1280)),
    height: Math.max(256, Number(args.get('height') || 1280)),
    clusters: Math.max(8, Math.min(12, Number(args.get('clusters') || 10))),
    edgeThreshold: Math.max(0.05, Math.min(0.45, Number(args.get('edge-threshold') || 0.18))),
    edgeDilate: Math.max(0, Math.min(5, Number(args.get('edge-dilate') || 2))),
    flowSmoothing: Math.max(0, Math.min(4, Number(args.get('flow-smoothing') || 2))),
    seed: Number(args.get('seed') || 42),
    stylePreset: args.get('style-preset') || 'balanced',
    stylePrompt: args.get('style-prompt') || '',
    enableSvg: parseBoolean(args.get('enable-svg'), true),
    useRemoteModels: parseBoolean(args.get('use-remote-models'), true),
    geminiModel: args.get('gemini-model') || '',
  };
}

export async function runPreprocessCli(argv = process.argv) {
  const args = parseArgs(argv);
  if (parseBoolean(args.get('help'), false) || parseBoolean(args.get('h'), false)) {
    usage();
    return 0;
  }

  const options = argsToOptions(argv);
  if (!options) {
    usage();
    return 2;
  }

  const started = Date.now();
  const result = await runPreprocess(options);
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);

  console.log(`input: ${path.resolve(options.input)}`);
  console.log(`output dir: ${result.outputDir}`);
  console.log(`manifest: ${result.manifestPath}`);
  console.log(`artifacts: ${result.artifacts.join(', ')}`);
  console.log(`remote models: ${options.useRemoteModels ? 'enabled' : 'disabled'}`);
  console.log(`svg optional path: ${options.enableSvg ? 'enabled' : 'disabled'}`);
  console.log(`elapsed: ${elapsed}s`);
  return 0;
}

