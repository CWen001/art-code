import { decodeImageBufferToRgba, encodeRgbaToPngBuffer } from './image_io.mjs';
import { estimateImageGeometryBias } from './vision.mjs';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hash2(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
  return s - Math.floor(s);
}

function makeStyleConfig(stylePreset) {
  const key = String(stylePreset || 'balanced').toLowerCase();
  if (key === 'graphic') {
    return { contrast: 1.16, saturation: 1.05, gamma: 0.94, levels: 18, noise: 0.018 };
  }
  if (key === 'texture') {
    return { contrast: 1.08, saturation: 1.18, gamma: 0.98, levels: 30, noise: 0.026 };
  }
  return { contrast: 1.12, saturation: 1.12, gamma: 0.96, levels: 24, noise: 0.02 };
}

function localStylize(image, stylePreset) {
  const cfg = makeStyleConfig(stylePreset);
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      let r = data[i] / 255;
      let g = data[i + 1] / 255;
      let b = data[i + 2] / 255;

      r = Math.pow(r, cfg.gamma);
      g = Math.pow(g, cfg.gamma);
      b = Math.pow(b, cfg.gamma);

      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * cfg.saturation;
      g = luma + (g - luma) * cfg.saturation;
      b = luma + (b - luma) * cfg.saturation;

      r = (r - 0.5) * cfg.contrast + 0.5;
      g = (g - 0.5) * cfg.contrast + 0.5;
      b = (b - 0.5) * cfg.contrast + 0.5;

      const noise = (hash2(x, y) - 0.5) * cfg.noise;
      r = clamp(r + noise, 0, 1);
      g = clamp(g + noise * 0.8, 0, 1);
      b = clamp(b + noise * 1.2, 0, 1);

      r = Math.round(r * cfg.levels) / cfg.levels;
      g = Math.round(g * cfg.levels) / cfg.levels;
      b = Math.round(b * cfg.levels) / cfg.levels;

      out[i] = Math.round(clamp(r, 0, 1) * 255);
      out[i + 1] = Math.round(clamp(g, 0, 1) * 255);
      out[i + 2] = Math.round(clamp(b, 0, 1) * 255);
      out[i + 3] = data[i + 3];
    }
  }

  return { width, height, data: out };
}

function parseBase64ImagePayload(json) {
  if (typeof json?.imageBase64 === 'string') {
    return json.imageBase64;
  }
  if (typeof json?.output?.imageBase64 === 'string') {
    return json.output.imageBase64;
  }
  if (typeof json?.data?.[0]?.b64_json === 'string') {
    return json.data[0].b64_json;
  }
  return null;
}

async function stylizeRemoteNanoBanana(image, options) {
  const endpoint = process.env.NANO_BANANA_API_URL;
  if (!endpoint) {
    throw new Error('NANO_BANANA_API_URL is not set');
  }

  const sourcePng = await encodeRgbaToPngBuffer(image);
  const payload = {
    model: process.env.NANO_BANANA_MODEL || 'nano-banana-stylize',
    stylePreset: options.stylePreset || 'balanced',
    prompt: options.stylePrompt || 'Stylize as controllable generative-art base with preserved structures.',
    imageBase64: sourcePng.toString('base64'),
    mimeType: 'image/png',
  };

  const headers = {
    'content-type': 'application/json',
  };
  if (process.env.NANO_BANANA_API_KEY) {
    headers.authorization = `Bearer ${process.env.NANO_BANANA_API_KEY}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Nano Banana request failed: HTTP ${response.status}`);
  }

  const json = await response.json();
  const outputBase64 = parseBase64ImagePayload(json);
  if (!outputBase64) {
    throw new Error('Nano Banana response did not include imageBase64');
  }

  const outputBuffer = Buffer.from(outputBase64, 'base64');
  const stylized = await decodeImageBufferToRgba(outputBuffer, {
    width: image.width,
    height: image.height,
  });

  return {
    image: stylized,
    mode: 'remote',
    model: payload.model,
    endpoint,
  };
}

export async function stylizeWithNanoBanana(image, options) {
  const useRemote = Boolean(options.useRemoteModels);
  if (useRemote) {
    try {
      return await stylizeRemoteNanoBanana(image, options);
    } catch (error) {
      return {
        image: localStylize(image, options.stylePreset),
        mode: 'fallback',
        model: 'local-deterministic',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    image: localStylize(image, options.stylePreset),
    mode: 'fallback',
    model: 'local-deterministic',
    reason: 'remote models disabled',
  };
}

function sanitizeHints(rawHints, defaults) {
  return {
    clusters: clamp(Math.round(Number(rawHints.clusters ?? defaults.clusters)), 8, 12),
    edgeThreshold: clamp(Number(rawHints.edgeThreshold ?? defaults.edgeThreshold), 0.05, 0.45),
    edgeDilate: clamp(Math.round(Number(rawHints.edgeDilate ?? defaults.edgeDilate)), 0, 5),
    flowSmoothing: clamp(Math.round(Number(rawHints.flowSmoothing ?? defaults.flowSmoothing)), 0, 4),
    enableSvg: Boolean(rawHints.enableSvg),
    reason: typeof rawHints.reason === 'string' ? rawHints.reason : '',
  };
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
    if (codeFenceMatch?.[1]) {
      return JSON.parse(codeFenceMatch[1]);
    }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(text.slice(first, last + 1));
    }
    throw new Error('unable to parse Gemini JSON response');
  }
}

async function deriveHintsRemoteGemini(image, defaults, options) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const model = options.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const png = await encodeRgbaToPngBuffer(image);

  const prompt = [
    'You are choosing preprocessing controls for generative art motion constraints.',
    'Return JSON only with fields:',
    '{ "clusters": number(8-12), "edgeThreshold": number(0.05-0.45), "edgeDilate": integer(0-5), "flowSmoothing": integer(0-4), "enableSvg": boolean, "reason": string }',
    `Default controls: clusters=${defaults.clusters}, edgeThreshold=${defaults.edgeThreshold}, edgeDilate=${defaults.edgeDilate}, flowSmoothing=${defaults.flowSmoothing}.`,
    `SVG is allowed: ${options.enableSvg}. Enable it only when strong geometric lines will improve masks.`,
  ].join('\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed: HTTP ${response.status}`);
  }
  const json = await response.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Gemini response missing text content');
  }

  const parsed = parseJsonLoose(text);
  const hints = sanitizeHints(parsed, defaults);
  if (!options.enableSvg) {
    hints.enableSvg = false;
  }

  return {
    hints,
    mode: 'remote',
    model,
    reason: hints.reason || 'remote recommendation',
  };
}

function deriveHintsLocal(image, defaults, options) {
  const { edgeDensity, straightness, gradientMean } = estimateImageGeometryBias(image);
  const clusters = clamp(Math.round(8 + gradientMean * 20), 8, 12);
  const edgeThreshold = clamp(0.14 + (0.11 - edgeDensity) * 0.55, 0.09, 0.32);
  const edgeDilate = edgeDensity > 0.18 ? 1 : edgeDensity < 0.08 ? 3 : 2;
  const flowSmoothing = gradientMean > 0.12 ? 1 : 2;
  const svgCandidate = options.enableSvg && straightness > 0.62 && edgeDensity > 0.03 && edgeDensity < 0.22;

  return {
    hints: sanitizeHints(
      {
        clusters,
        edgeThreshold,
        edgeDilate,
        flowSmoothing,
        enableSvg: svgCandidate,
        reason: `local heuristic (edgeDensity=${edgeDensity.toFixed(3)}, straightness=${straightness.toFixed(3)})`,
      },
      defaults,
    ),
    mode: 'fallback',
    model: 'local-heuristic',
    reason: 'deterministic local structure estimation',
  };
}

export async function deriveStructureHintsWithGemini(image, defaults, options) {
  if (options.useRemoteModels) {
    try {
      return await deriveHintsRemoteGemini(image, defaults, options);
    } catch (error) {
      const local = deriveHintsLocal(image, defaults, options);
      local.reason = error instanceof Error ? error.message : String(error);
      return local;
    }
  }
  return deriveHintsLocal(image, defaults, options);
}

