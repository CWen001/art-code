export type ArtInputPackage = {
  baseImageUrl: string;
  maskPackUrl?: string;
  flowHintUrl?: string;
  meta?: { title?: string; source?: string };
};

export type MaskPack = {
  regionMaskTex: WebGLTexture | null;
  edgeMaskTex: WebGLTexture | null;
  confidenceTex: WebGLTexture | null;
};

export type FlowFieldPack = {
  flowTex: WebGLTexture | null; // RG: direction
  magnitudeTex: WebGLTexture | null;
};

export type EngineParams = {
  seed: number;
  motionSpeed: number;
  turbulence: number;
  edgeLock: number;
  maskFeather: number;
  textureScale: number;
  grainAmount: number;
  chromaAberration: number;
  activeRegionId: number; // -1 means all regions
};

export type Preset = {
  name: string;
  params: EngineParams;
};

export type DebugView = 'final' | 'regionMask' | 'edgeMask' | 'flow' | 'confidence' | 'leakage';

export type SegmentationConfig = {
  clusters: number;
  edgeThreshold: number;
  edgeDilate: number;
  flowSmoothing: number;
};

export type DebugConfig = {
  view: DebugView;
  showFlowArrows: boolean;
};

export type VisionArtifacts = {
  width: number;
  height: number;
  regionCount: number;
  regionIds: Uint8Array<ArrayBufferLike>;
  confidence: Float32Array<ArrayBufferLike>;
  edgeMask: Uint8Array<ArrayBufferLike>;
  flowVectors: Float32Array<ArrayBufferLike>;
  flowMagnitude: Float32Array<ArrayBufferLike>;
};
