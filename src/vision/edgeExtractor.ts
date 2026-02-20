export type EdgeExtractionResult = {
  width: number;
  height: number;
  edgeMask: Uint8Array<ArrayBufferLike>;
  edgeStrength: Float32Array<ArrayBufferLike>;
};

function luminance(data: Uint8ClampedArray, i: number): number {
  return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
}

function dilateBinary(mask: Uint8Array<ArrayBufferLike>, width: number, height: number, rounds: number): Uint8Array<ArrayBufferLike> {
  let input = mask;
  let output = new Uint8Array(mask.length) as Uint8Array<ArrayBufferLike>;

  for (let r = 0; r < rounds; r += 1) {
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

  return input as Uint8Array<ArrayBufferLike>;
}

export function extractEdges(
  imageData: ImageData,
  threshold = 0.18,
  dilationRounds = 2,
): EdgeExtractionResult {
  const { width, height, data } = imageData;
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
    edgeMask: dilateBinary(edgeMask, width, height, Math.max(0, Math.floor(dilationRounds))),
    edgeStrength,
  };
}
