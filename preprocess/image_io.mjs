import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readImageAsRgba(inputPath, targetSize = null) {
  let pipeline = sharp(inputPath, { failOn: 'warning' }).rotate();
  if (targetSize?.width || targetSize?.height) {
    pipeline = pipeline.resize({
      width: targetSize.width ?? null,
      height: targetSize.height ?? null,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

export async function decodeImageBufferToRgba(buffer, targetSize = null) {
  let pipeline = sharp(buffer, { failOn: 'warning' }).rotate();
  if (targetSize?.width || targetSize?.height) {
    pipeline = pipeline.resize({
      width: targetSize.width ?? null,
      height: targetSize.height ?? null,
      fit: 'fill',
    });
  }

  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

export async function encodeRgbaToPngBuffer(image) {
  return sharp(image.data, {
    raw: {
      width: image.width,
      height: image.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

export async function writeRgbaPng(outputPath, image) {
  await ensureDir(path.dirname(outputPath));
  await sharp(image.data, {
    raw: {
      width: image.width,
      height: image.height,
      channels: 4,
    },
  })
    .png()
    .toFile(outputPath);
}

export async function writeGrayPng(outputPath, width, height, grayBuffer) {
  await ensureDir(path.dirname(outputPath));
  await sharp(grayBuffer, {
    raw: {
      width,
      height,
      channels: 1,
    },
  })
    .png()
    .toFile(outputPath);
}

export async function writeFlowHintPng(outputPath, width, height, vectors, magnitude) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const vIdx = i * 2;
    const o = i * 4;
    const vx = Math.max(-1, Math.min(1, vectors[vIdx]));
    const vy = Math.max(-1, Math.min(1, vectors[vIdx + 1]));
    const mag = Math.max(0, Math.min(1, magnitude[i]));

    rgba[o] = Math.round((vx * 0.5 + 0.5) * 255);
    rgba[o + 1] = Math.round((vy * 0.5 + 0.5) * 255);
    rgba[o + 2] = Math.round(mag * 255);
    rgba[o + 3] = 255;
  }

  await writeRgbaPng(outputPath, { width, height, data: rgba });
}

