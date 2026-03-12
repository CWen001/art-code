#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  console.log('Usage: node scripts/validate_fps.mjs --video <mp4> [--min 30]');
}

const args = parseArgs(process.argv);
const video = args.get('video');
const minFps = Number(args.get('min') ?? 30);

if (!video || !existsSync(video)) {
  console.error(`Video not found: ${video}`);
  usage();
  process.exit(2);
}

try {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=avg_frame_rate,r_frame_rate,duration,width,height',
      '-of',
      'json',
      video,
    ],
    { encoding: 'utf8' },
  );

  const parsed = JSON.parse(out);
  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new Error('No video stream found');
  }

  const [num, den] = String(stream.avg_frame_rate ?? '0/1')
    .split('/')
    .map((v) => Number(v));
  const fps = den !== 0 ? num / den : 0;

  console.log(`video: ${path.resolve(video)}`);
  console.log(`resolution: ${stream.width}x${stream.height}`);
  console.log(`duration: ${Number(stream.duration ?? 0).toFixed(3)}s`);
  console.log(`avg fps: ${fps.toFixed(3)}`);
  console.log(`threshold: >= ${minFps.toFixed(3)}`);

  if (fps >= minFps) {
    console.log('PASS: fps threshold met.');
    process.exit(0);
  }

  console.error('FAIL: fps below threshold.');
  process.exit(1);
} catch (error) {
  console.error('validate_fps failed:', error instanceof Error ? error.message : String(error));
  process.exit(2);
}
