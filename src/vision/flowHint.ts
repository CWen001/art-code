export type FlowHintResult = {
  width: number;
  height: number;
  vectors: Float32Array<ArrayBufferLike>; // xy per pixel, normalized
  magnitude: Float32Array<ArrayBufferLike>;
};

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function blurScalar(
  src: Float32Array<ArrayBufferLike>,
  width: number,
  height: number,
): Float32Array<ArrayBufferLike> {
  const dst = new Float32Array(src.length) as Float32Array<ArrayBufferLike>;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let sum = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          sum += src[(y + oy) * width + (x + ox)];
        }
      }
      dst[y * width + x] = sum / 9;
    }
  }
  return dst;
}

function blurVec2(
  src: Float32Array<ArrayBufferLike>,
  width: number,
  height: number,
): Float32Array<ArrayBufferLike> {
  const dst = new Float32Array(src.length) as Float32Array<ArrayBufferLike>;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let sumX = 0;
      let sumY = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const idx = ((y + oy) * width + (x + ox)) * 2;
          sumX += src[idx];
          sumY += src[idx + 1];
        }
      }
      const outIdx = (y * width + x) * 2;
      dst[outIdx] = sumX / 9;
      dst[outIdx + 1] = sumY / 9;
    }
  }
  return dst;
}

export function buildFlowHint(imageData: ImageData, smoothPasses = 2): FlowHintResult {
  const { width, height, data } = imageData;
  const gray = new Float32Array(width * height);

  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    gray[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
  }

  const vectors = new Float32Array(width * height * 2) as Float32Array<ArrayBufferLike>;
  let magnitude = new Float32Array(width * height) as Float32Array<ArrayBufferLike>;
  let maxMag = 1e-6;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const dx = gray[idx + 1] - gray[idx - 1];
      const dy = gray[idx + width] - gray[idx - width];

      // Tangential flow follows contour lines more closely than direct gradient.
      let vx = -dy;
      let vy = dx;
      let mag = Math.sqrt(vx * vx + vy * vy);

      if (mag < 1e-5) {
        const angle = hash2(x, y) * Math.PI * 2;
        vx = Math.cos(angle) * 0.04;
        vy = Math.sin(angle) * 0.04;
        mag = 0.04;
      } else {
        vx /= mag;
        vy /= mag;
      }

      const vIdx = idx * 2;
      vectors[vIdx] = vx;
      vectors[vIdx + 1] = vy;
      magnitude[idx] = mag;
      if (mag > maxMag) {
        maxMag = mag;
      }
    }
  }

  for (let i = 0; i < magnitude.length; i += 1) {
    magnitude[i] /= maxMag;
  }

  let smoothVectors: Float32Array<ArrayBufferLike> = vectors;
  let smoothMagnitude: Float32Array<ArrayBufferLike> = magnitude;
  const rounds = Math.max(0, Math.floor(smoothPasses));

  for (let i = 0; i < rounds; i += 1) {
    smoothVectors = blurVec2(smoothVectors, width, height);
    smoothMagnitude = blurScalar(smoothMagnitude, width, height);
  }

  // Renormalize vectors after blur.
  for (let i = 0; i < width * height; i += 1) {
    const vIdx = i * 2;
    const vx = smoothVectors[vIdx];
    const vy = smoothVectors[vIdx + 1];
    const len = Math.sqrt(vx * vx + vy * vy) + 1e-6;
    smoothVectors[vIdx] = vx / len;
    smoothVectors[vIdx + 1] = vy / len;
  }

  return {
    width,
    height,
    vectors: smoothVectors,
    magnitude: smoothMagnitude,
  };
}
