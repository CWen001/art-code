function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function distSq(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function nearestTwo(color, centroids) {
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

function initCentroids(samples, k, seed) {
  const rng = mulberry32(seed);
  const centroids = [samples[Math.floor(rng() * samples.length)]];

  while (centroids.length < k) {
    const dists = samples.map((sample) => {
      let best = Infinity;
      for (const centroid of centroids) {
        const d = distSq(sample, centroid);
        if (d < best) {
          best = d;
        }
      }
      return best;
    });

    const total = dists.reduce((acc, value) => acc + value, 0);
    let target = rng() * total;
    let picked = samples[samples.length - 1];
    for (let i = 0; i < samples.length; i += 1) {
      target -= dists[i];
      if (target <= 0) {
        picked = samples[i];
        break;
      }
    }
    centroids.push(picked);
  }

  return centroids;
}

export function extractRegionMasksFromRgba(image, clusterCount = 10, seed = 42) {
  const { width, height, data } = image;
  const total = width * height;
  const k = Math.max(2, Math.min(16, Math.floor(clusterCount)));

  const targetSamples = 24_000;
  const stride = Math.max(1, Math.floor(Math.sqrt(total / targetSamples)));
  const samples = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4;
      samples.push([data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255]);
    }
  }

  let centroids = initCentroids(samples, k, seed);
  for (let iter = 0; iter < 8; iter += 1) {
    const sums = Array.from({ length: k }, () => [0, 0, 0]);
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
      return [sums[i][0] / counts[i], sums[i][1] / counts[i], sums[i][2] / counts[i]];
    });
  }

  const regionIds = new Uint8Array(total);
  const confidence = new Float32Array(total);
  const counts = new Uint32Array(k);
  for (let i = 0; i < total; i += 1) {
    const idx = i * 4;
    const color = [data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255];
    const near = nearestTwo(color, centroids);
    regionIds[i] = near.first;
    counts[near.first] += 1;
    confidence[i] = clamp01(1 - near.d1 / (near.d2 + 1e-6));
  }

  // Merge tiny regions to reduce speckle noise on dense artworks.
  const minArea = Math.floor(total * 0.0012);
  const small = new Set();
  const large = [];
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
      const color = [data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255];
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
    centroids,
  };
}

function luminance(data, i) {
  return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
}

export function dilateBinaryMask(mask, width, height, rounds) {
  let input = mask;
  let output = new Uint8Array(mask.length);
  const passCount = Math.max(0, Math.floor(rounds));

  for (let r = 0; r < passCount; r += 1) {
    output.fill(0);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x;
        let on = false;
        for (let oy = -1; oy <= 1 && !on; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (input[idx + oy * width + ox] > 0) {
              on = true;
              break;
            }
          }
        }
        output[idx] = on ? 255 : 0;
      }
    }
    const tmp = input;
    input = output;
    output = tmp;
  }
  return input;
}

export function extractEdgesFromRgba(image, threshold = 0.18, dilationRounds = 2) {
  const { width, height, data } = image;
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      gray[y * width + x] = luminance(data, idx);
    }
  }

  const edgeStrength = new Float32Array(width * height);
  let maxMag = 1e-6;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i00 = gray[(y - 1) * width + (x - 1)];
      const i10 = gray[(y - 1) * width + x];
      const i20 = gray[(y - 1) * width + (x + 1)];
      const i01 = gray[y * width + (x - 1)];
      const i21 = gray[y * width + (x + 1)];
      const i02 = gray[(y + 1) * width + (x - 1)];
      const i12 = gray[(y + 1) * width + x];
      const i22 = gray[(y + 1) * width + (x + 1)];

      const gx = -i00 + i20 - 2 * i01 + 2 * i21 - i02 + i22;
      const gy = i00 + 2 * i10 + i20 - i02 - 2 * i12 - i22;
      const mag = Math.sqrt(gx * gx + gy * gy);
      const outIdx = y * width + x;
      edgeStrength[outIdx] = mag;
      if (mag > maxMag) {
        maxMag = mag;
      }
    }
  }

  for (let i = 0; i < edgeStrength.length; i += 1) {
    edgeStrength[i] /= maxMag;
  }

  const edgeMask = new Uint8Array(width * height);
  for (let i = 0; i < edgeMask.length; i += 1) {
    edgeMask[i] = edgeStrength[i] > threshold ? 255 : 0;
  }

  return {
    width,
    height,
    edgeMask: dilateBinaryMask(edgeMask, width, height, dilationRounds),
    edgeStrength,
  };
}

function hash2(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function blurScalar(src, width, height) {
  const dst = new Float32Array(src.length);
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

function blurVec2(src, width, height) {
  const dst = new Float32Array(src.length);
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

export function buildFlowHintFromRgba(image, smoothPasses = 2) {
  const { width, height, data } = image;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    gray[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
  }

  const vectors = new Float32Array(width * height * 2);
  let magnitude = new Float32Array(width * height);
  let maxMag = 1e-6;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const dx = gray[idx + 1] - gray[idx - 1];
      const dy = gray[idx + width] - gray[idx - width];

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

  let smoothVectors = vectors;
  let smoothMagnitude = magnitude;
  const rounds = Math.max(0, Math.floor(smoothPasses));
  for (let i = 0; i < rounds; i += 1) {
    smoothVectors = blurVec2(smoothVectors, width, height);
    smoothMagnitude = blurScalar(smoothMagnitude, width, height);
  }

  for (let i = 0; i < width * height; i += 1) {
    const idx = i * 2;
    const vx = smoothVectors[idx];
    const vy = smoothVectors[idx + 1];
    const len = Math.sqrt(vx * vx + vy * vy) + 1e-6;
    smoothVectors[idx] = vx / len;
    smoothVectors[idx + 1] = vy / len;
  }

  return {
    width,
    height,
    vectors: smoothVectors,
    magnitude: smoothMagnitude,
  };
}

export function estimateImageGeometryBias(image) {
  const { width, height, data } = image;
  let straightAligned = 0;
  let edgeCount = 0;
  let gradientEnergy = 0;

  const luminanceBuffer = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      luminanceBuffer[y * width + x] = luminance(data, idx);
    }
  }

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const dx = luminanceBuffer[idx + 1] - luminanceBuffer[idx - 1];
      const dy = luminanceBuffer[idx + width] - luminanceBuffer[idx - width];
      const mag = Math.sqrt(dx * dx + dy * dy);
      gradientEnergy += mag;

      if (mag < 0.12) {
        continue;
      }

      edgeCount += 1;
      const angle = Math.abs(Math.atan2(dy, dx));
      const d0 = Math.min(angle, Math.abs(Math.PI - angle));
      const d90 = Math.abs(Math.PI / 2 - angle);
      const axisDist = Math.min(d0, d90);
      if (axisDist < (15 * Math.PI) / 180) {
        straightAligned += 1;
      }
    }
  }

  const total = Math.max(1, width * height);
  const edgeDensity = edgeCount / total;
  const straightness = edgeCount > 0 ? straightAligned / edgeCount : 0;
  const gradientMean = gradientEnergy / total;
  return { edgeDensity, straightness, gradientMean };
}

