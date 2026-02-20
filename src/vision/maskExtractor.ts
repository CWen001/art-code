export type MaskExtractionResult = {
  width: number;
  height: number;
  regionCount: number;
  regionIds: Uint8Array<ArrayBufferLike>;
  confidence: Float32Array<ArrayBufferLike>;
  centroids: Array<[number, number, number]>;
};

type Vec3 = [number, number, number];

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function distSq(a: Vec3, b: Vec3): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function nearestTwo(color: Vec3, centroids: Vec3[]): { first: number; second: number; d1: number; d2: number } {
  let first = 0;
  let second = 1;
  let d1 = Infinity;
  let d2 = Infinity;

  for (let i = 0; i < centroids.length; i += 1) {
    const d = distSq(color, centroids[i]);
    if (d < d1) {
      d2 = d1;
      second = first;
      d1 = d;
      first = i;
    } else if (d < d2) {
      d2 = d;
      second = i;
    }
  }

  return { first, second, d1, d2 };
}

function initCentroids(samples: Vec3[], k: number, seed: number): Vec3[] {
  const rng = mulberry32(seed);
  const centroids: Vec3[] = [];
  centroids.push(samples[Math.floor(rng() * samples.length)]);

  while (centroids.length < k) {
    const dists = samples.map((s) => {
      let best = Infinity;
      for (const c of centroids) {
        const d = distSq(s, c);
        if (d < best) {
          best = d;
        }
      }
      return best;
    });

    const total = dists.reduce((acc, v) => acc + v, 0);
    let target = rng() * total;

    for (let i = 0; i < samples.length; i += 1) {
      target -= dists[i];
      if (target <= 0) {
        centroids.push(samples[i]);
        break;
      }
    }

    if (centroids.length < k && centroids.length >= samples.length) {
      centroids.push(samples[Math.floor(rng() * samples.length)]);
    }
  }

  return centroids;
}

export function extractRegionMasks(
  imageData: ImageData,
  clusterCount = 10,
  seed = 42,
): MaskExtractionResult {
  const { width, height, data } = imageData;
  const total = width * height;
  const k = Math.max(2, Math.min(16, Math.floor(clusterCount)));

  const targetSamples = 24_000;
  const stride = Math.max(1, Math.floor(Math.sqrt(total / targetSamples)));

  const samples: Vec3[] = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4;
      samples.push([data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255]);
    }
  }

  let centroids = initCentroids(samples, k, seed);

  for (let iter = 0; iter < 8; iter += 1) {
    const sums: Array<Vec3> = Array.from({ length: k }, () => [0, 0, 0]);
    const counts = new Uint32Array(k);

    for (const sample of samples) {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < k; i += 1) {
        const d = distSq(sample, centroids[i]);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      sums[best][0] += sample[0];
      sums[best][1] += sample[1];
      sums[best][2] += sample[2];
      counts[best] += 1;
    }

    centroids = centroids.map((center, i) => {
      if (!counts[i]) {
        return center;
      }
      return [
        sums[i][0] / counts[i],
        sums[i][1] / counts[i],
        sums[i][2] / counts[i],
      ];
    });
  }

  const regionIds = new Uint8Array(total);
  const confidence = new Float32Array(total);
  const counts = new Uint32Array(k);

  for (let i = 0; i < total; i += 1) {
    const idx = i * 4;
    const color: Vec3 = [data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255];
    const near = nearestTwo(color, centroids);
    regionIds[i] = near.first;
    counts[near.first] += 1;

    const c = 1 - near.d1 / (near.d2 + 1e-6);
    confidence[i] = Math.max(0, Math.min(1, c));
  }

  // Merge tiny regions into nearest large centroid to reduce speckle.
  const minArea = Math.floor(total * 0.0012);
  const small = new Set<number>();
  const large: number[] = [];
  for (let i = 0; i < k; i += 1) {
    if (counts[i] < minArea) {
      small.add(i);
    } else {
      large.push(i);
    }
  }

  if (small.size > 0 && large.length > 0) {
    for (let i = 0; i < total; i += 1) {
      const id = regionIds[i];
      if (!small.has(id)) {
        continue;
      }

      const idx = i * 4;
      const color: Vec3 = [data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255];
      let best = large[0];
      let bestDist = Infinity;
      for (const candidate of large) {
        const d = distSq(color, centroids[candidate]);
        if (d < bestDist) {
          bestDist = d;
          best = candidate;
        }
      }
      regionIds[i] = best;
    }
  }

  return {
    width,
    height,
    regionCount: k,
    regionIds,
    confidence,
    centroids: centroids as Array<[number, number, number]>,
  };
}
