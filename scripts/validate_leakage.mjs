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
  console.log(
    [
      'Usage: node scripts/validate_leakage.mjs --video <mp4> --base <image> [--threshold 0.03] [--k 10] [--region-id -1] [--max-frames 240]',
      'Notes:',
      '- region-id -1 means auto-pick the most energetic region.',
      '- leakage ratio = motion energy outside selected region / total motion energy.',
    ].join('\n'),
  );
}

function distSq(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function kmeansRGB(raw, width, height, k, iterations = 6) {
  const total = width * height;
  const stride = Math.max(1, Math.floor(Math.sqrt(total / 22000)));
  const samples = [];

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 3;
      samples.push([raw[idx] / 255, raw[idx + 1] / 255, raw[idx + 2] / 255]);
    }
  }

  const centroids = [];
  for (let i = 0; i < k; i += 1) {
    const s = samples[Math.floor((i / k) * (samples.length - 1))];
    centroids.push([...s]);
  }

  for (let iter = 0; iter < iterations; iter += 1) {
    const sums = Array.from({ length: k }, () => [0, 0, 0]);
    const counts = new Uint32Array(k);

    for (const sample of samples) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c += 1) {
        const d = distSq(sample, centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }

      sums[best][0] += sample[0];
      sums[best][1] += sample[1];
      sums[best][2] += sample[2];
      counts[best] += 1;
    }

    for (let c = 0; c < k; c += 1) {
      if (!counts[c]) continue;
      centroids[c][0] = sums[c][0] / counts[c];
      centroids[c][1] = sums[c][1] / counts[c];
      centroids[c][2] = sums[c][2] / counts[c];
    }
  }

  const labels = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const idx = i * 3;
    const pixel = [raw[idx] / 255, raw[idx + 1] / 255, raw[idx + 2] / 255];

    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < k; c += 1) {
      const d = distSq(pixel, centroids[c]);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    labels[i] = best;
  }

  return labels;
}

function rawFramesFromVideo(video, width, height) {
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', video, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
}

function rawFrameFromImage(imagePath, width, height) {
  return execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      imagePath,
      '-vf',
      `scale=${width}:${height}`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
}

const args = parseArgs(process.argv);
const video = args.get('video') ?? 'ref/videos/sample_motion_b.mp4';
const base = args.get('base') ?? 'ref/pics/sample_input_a.jpeg';
const threshold = Number(args.get('threshold') ?? 0.03);
const maxFrames = Number(args.get('max-frames') ?? 240);
const k = Math.max(2, Math.min(16, Number(args.get('k') ?? 10)));
let regionId = Number(args.get('region-id') ?? -1);

if (!existsSync(video) || !existsSync(base)) {
  console.error('Input not found.');
  usage();
  process.exit(2);
}

try {
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,avg_frame_rate,duration',
        '-of',
        'json',
        video,
      ],
      { encoding: 'utf8' },
    ),
  );

  const stream = probe.streams?.[0];
  if (!stream) {
    throw new Error('No video stream found');
  }

  const width = Number(stream.width);
  const height = Number(stream.height);
  const frameBytes = width * height * 3;

  const rawVideo = rawFramesFromVideo(video, width, height);
  const totalFrames = Math.floor(rawVideo.length / frameBytes);
  const frameCount = Math.max(2, Math.min(maxFrames, totalFrames));

  const motion = new Float32Array(width * height);
  for (let f = 1; f < frameCount; f += 1) {
    const prevOffset = (f - 1) * frameBytes;
    const currOffset = f * frameBytes;

    for (let p = 0; p < width * height; p += 1) {
      const idx = p * 3;
      const dR = Math.abs(rawVideo[prevOffset + idx] - rawVideo[currOffset + idx]);
      const dG = Math.abs(rawVideo[prevOffset + idx + 1] - rawVideo[currOffset + idx + 1]);
      const dB = Math.abs(rawVideo[prevOffset + idx + 2] - rawVideo[currOffset + idx + 2]);
      motion[p] += (dR + dG + dB) / (3 * 255);
    }
  }

  const inv = 1 / (frameCount - 1);
  for (let i = 0; i < motion.length; i += 1) {
    motion[i] *= inv;
  }

  const baseRaw = rawFrameFromImage(base, width, height);
  const labels = kmeansRGB(baseRaw, width, height, k);

  if (regionId < 0) {
    const sums = new Float64Array(k);
    const counts = new Uint32Array(k);
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels[i];
      sums[label] += motion[i];
      counts[label] += 1;
    }

    let bestRegion = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < k; i += 1) {
      const mean = counts[i] ? sums[i] / counts[i] : 0;
      if (mean > bestValue) {
        bestValue = mean;
        bestRegion = i;
      }
    }
    regionId = bestRegion;
  }

  let outside = 0;
  let total = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const e = motion[i];
    total += e;
    if (labels[i] !== regionId) {
      outside += e;
    }
  }

  const leakage = total > 0 ? outside / total : 0;

  console.log(`video: ${path.resolve(video)}`);
  console.log(`base: ${path.resolve(base)}`);
  console.log(`resolution: ${width}x${height}`);
  console.log(`frames sampled: ${frameCount}/${totalFrames}`);
  console.log(`clusters: ${k}`);
  console.log(`active region: ${regionId}`);
  console.log(`leakage ratio: ${(leakage * 100).toFixed(3)}%`);
  console.log(`threshold: ${(threshold * 100).toFixed(3)}%`);

  if (leakage <= threshold) {
    console.log('PASS: leakage within threshold.');
    process.exit(0);
  }

  console.error('FAIL: leakage above threshold.');
  process.exit(1);
} catch (error) {
  console.error('validate_leakage failed:', error instanceof Error ? error.message : String(error));
  process.exit(2);
}
