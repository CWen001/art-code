import type { ArtInputPackage } from '../types';

export type MaskPackManifestInput = {
  version?: unknown;
  regionMask?: unknown;
  edgeMask?: unknown;
  confidenceMask?: unknown;
  regionMaskUrl?: unknown;
  edgeMaskUrl?: unknown;
  confidenceUrl?: unknown;
  regionCount?: unknown;
  encoding?: unknown;
};

export type ResolvedMaskPackManifest = {
  version: string;
  regionMaskUrl?: string;
  edgeMaskUrl?: string;
  confidenceUrl?: string;
  regionCount?: number;
  encoding?: Record<string, unknown>;
};

export type PreprocessManifestInput = {
  version?: unknown;
  source?: unknown;
  createdAt?: unknown;
  baseImageUrl?: unknown;
  maskPackUrl?: unknown;
  flowHintUrl?: unknown;
  meta?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveUrl(candidate: unknown, baseUrl: string): string | undefined {
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

function normalizeVersion(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return '1.0.0';
  }
  return value.trim();
}

export function parseMaskPackManifest(
  payload: unknown,
  baseUrl: string,
): ResolvedMaskPackManifest {
  if (!isRecord(payload)) {
    throw new Error('Mask pack payload must be an object.');
  }

  const pack = payload as MaskPackManifestInput;

  const regionMaskUrl =
    resolveUrl(pack.regionMaskUrl, baseUrl) ?? resolveUrl(pack.regionMask, baseUrl);
  const edgeMaskUrl = resolveUrl(pack.edgeMaskUrl, baseUrl) ?? resolveUrl(pack.edgeMask, baseUrl);
  const confidenceUrl =
    resolveUrl(pack.confidenceUrl, baseUrl) ?? resolveUrl(pack.confidenceMask, baseUrl);

  if (!regionMaskUrl && !edgeMaskUrl && !confidenceUrl) {
    throw new Error('Mask pack must include at least one mask URL field.');
  }

  let regionCount: number | undefined;
  if (typeof pack.regionCount === 'number' && Number.isFinite(pack.regionCount)) {
    regionCount = Math.max(1, Math.min(255, Math.round(pack.regionCount)));
  }

  let encoding: Record<string, unknown> | undefined;
  if (isRecord(pack.encoding)) {
    encoding = { ...pack.encoding };
  }

  return {
    version: normalizeVersion(pack.version),
    regionMaskUrl,
    edgeMaskUrl,
    confidenceUrl,
    regionCount,
    encoding,
  };
}

export function parsePreprocessManifest(
  payload: unknown,
  manifestUrl: string,
): ArtInputPackage {
  if (!isRecord(payload)) {
    throw new Error('Manifest payload must be a JSON object.');
  }

  const manifest = payload as PreprocessManifestInput;
  const baseImageUrl = resolveUrl(manifest.baseImageUrl, manifestUrl);

  if (!baseImageUrl) {
    throw new Error('Manifest missing required "baseImageUrl".');
  }

  const inputPackage: ArtInputPackage = {
    baseImageUrl,
  };

  const maskPackUrl = resolveUrl(manifest.maskPackUrl, manifestUrl);
  if (maskPackUrl) {
    inputPackage.maskPackUrl = maskPackUrl;
  }

  const flowHintUrl = resolveUrl(manifest.flowHintUrl, manifestUrl);
  if (flowHintUrl) {
    inputPackage.flowHintUrl = flowHintUrl;
  }

  const meta: Record<string, unknown> = {};
  if (typeof manifest.source === 'string' && manifest.source.trim()) {
    meta.source = manifest.source.trim();
  }
  if (isRecord(manifest.meta)) {
    if (typeof manifest.meta.title === 'string' && manifest.meta.title.trim()) {
      meta.title = manifest.meta.title.trim();
    }
    if (!meta.source && typeof manifest.meta.source === 'string' && manifest.meta.source.trim()) {
      meta.source = manifest.meta.source.trim();
    }
  }

  if (Object.keys(meta).length > 0) {
    inputPackage.meta = {
      title: typeof meta.title === 'string' ? meta.title : undefined,
      source: typeof meta.source === 'string' ? meta.source : undefined,
    };
  }

  return inputPackage;
}

export function resolveRelativeUrl(url: string, baseUrl: string): string {
  return resolveUrl(url, baseUrl) ?? url;
}
