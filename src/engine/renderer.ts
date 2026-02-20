import p5 from 'p5';
import basePassFrag from './passes/basePass.frag?raw';
import maskFlowPassFrag from './passes/maskFlowPass.frag?raw';
import compositePassFrag from './passes/compositePass.frag?raw';
import {
  ArtInputPackage,
  DebugConfig,
  DebugView,
  EngineParams,
  SegmentationConfig,
  VisionArtifacts,
} from '../types';
import { parseMaskPackManifest, type ResolvedMaskPackManifest } from '../contracts/artInputManifest';
import { buildFlowHint } from '../vision/flowHint';
import { extractEdges } from '../vision/edgeExtractor';
import { extractRegionMasks } from '../vision/maskExtractor';

const VERT_SHADER = `
precision mediump float;

attribute vec3 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;

void main() {
  vTexCoord = aTexCoord;
  vec4 positionVec4 = vec4(aPosition, 1.0);
  positionVec4.xy = positionVec4.xy * 2.0 - 1.0;
  gl_Position = positionVec4;
}
`;

const DEBUG_MODE_MAP: Record<DebugView, number> = {
  final: 0,
  regionMask: 1,
  edgeMask: 2,
  flow: 3,
  confidence: 4,
  leakage: 5,
};

type RendererOptions = {
  parent: HTMLElement;
  statsTarget: HTMLElement;
  inputPackage: ArtInputPackage;
  params: EngineParams;
  segmentation: SegmentationConfig;
  debug: DebugConfig;
};

type RuntimeMetrics = {
  fps: number;
  leakageRatio: number;
};

export class Renderer {
  public readonly params: EngineParams;
  public readonly segmentation: SegmentationConfig;
  public readonly debug: DebugConfig;

  private readonly p: p5;
  private readonly parent: HTMLElement;
  private readonly statsTarget: HTMLElement;
  private inputPackage: ArtInputPackage;

  private canvas?: p5.Renderer;
  private flowBufferA?: p5.Graphics;
  private flowBufferB?: p5.Graphics;
  private composeBuffer?: p5.Graphics;
  private arrowOverlay?: p5.Graphics;

  private baseShader?: p5.Shader;
  private flowShader?: p5.Shader;
  private compositeShader?: p5.Shader;

  private workingBaseImage?: p5.Image;
  private regionImage?: p5.Image;
  private edgeImage?: p5.Image;
  private confidenceImage?: p5.Image;
  private flowImage?: p5.Image;
  private flowMagnitudeImage?: p5.Image;

  private regionCount = 1;
  private vision?: VisionArtifacts;
  private activeMask = new Float32Array(0);

  private ready = false;
  private frameStart = 0;
  private lastFrameTime = 0;
  private metrics: RuntimeMetrics = { fps: 0, leakageRatio: 0 };
  private maskSignature = '';

  private readonly renderWidth = 720;
  private readonly renderHeight = 720;

  public constructor(p: p5, options: RendererOptions) {
    this.p = p;
    this.parent = options.parent;
    this.statsTarget = options.statsTarget;
    this.inputPackage = options.inputPackage;
    this.params = options.params;
    this.segmentation = options.segmentation;
    this.debug = options.debug;
  }

  public async initialize(): Promise<void> {
    const p = this.p;
    p.pixelDensity(1);

    this.canvas = p.createCanvas(this.renderWidth, this.renderHeight, p.WEBGL);
    this.canvas.parent(this.parent);

    this.flowBufferA = p.createGraphics(this.renderWidth, this.renderHeight, p.WEBGL);
    this.flowBufferB = p.createGraphics(this.renderWidth, this.renderHeight, p.WEBGL);
    this.composeBuffer = p.createGraphics(this.renderWidth, this.renderHeight, p.WEBGL);
    this.arrowOverlay = p.createGraphics(this.renderWidth, this.renderHeight);

    [this.flowBufferA, this.flowBufferB, this.composeBuffer].forEach((buf) => {
      buf.pixelDensity(1);
      buf.noStroke();
      buf.clear();
    });

    this.baseShader = p.createShader(VERT_SHADER, basePassFrag);
    this.flowShader = p.createShader(VERT_SHADER, maskFlowPassFrag);
    this.compositeShader = p.createShader(VERT_SHADER, compositePassFrag);

    await this.loadBaseImage(this.inputPackage.baseImageUrl);
    this.frameStart = performance.now();
    this.ready = true;
  }

  public isReady(): boolean {
    return this.ready;
  }

  public getMetrics(): RuntimeMetrics {
    return { ...this.metrics };
  }

  public getRegionCount(): number {
    return this.regionCount;
  }

  public resetFlow(): void {
    this.resetFlowState();
  }

  public async reloadInput(nextInput: ArtInputPackage): Promise<void> {
    this.inputPackage = nextInput;
    this.ready = false;
    await this.loadBaseImage(nextInput.baseImageUrl);
    this.ready = true;
  }

  public async recomputeVision(): Promise<void> {
    if (!this.workingBaseImage) {
      return;
    }

    this.computeVisionTextures(this.workingBaseImage);
    await this.applyOptionalOverrides();
    this.rebuildActiveMask();
    this.buildFlowArrows();
    this.resetFlowState();
  }

  public draw(): void {
    const p = this.p;

    if (!this.ready || !this.flowBufferA || !this.flowBufferB || !this.composeBuffer) {
      p.background(10, 8, 12);
      p.push();
      p.resetMatrix();
      p.fill(230, 220, 210);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(14);
      p.text('Loading pipeline…', 0, 0);
      p.pop();
      return;
    }

    const now = performance.now();
    const dt = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 1 / 60;
    this.lastFrameTime = now;

    const signature = `${this.params.activeRegionId}:${this.params.maskFeather.toFixed(3)}`;
    if (signature !== this.maskSignature) {
      this.maskSignature = signature;
      this.rebuildActiveMask();
    }

    this.runFlowPass(dt);
    this.runCompositePass();

    p.shader(this.baseShader as p5.Shader);
    (this.baseShader as p5.Shader).setUniform('u_sourceTex', this.composeBuffer);
    p.rect(-p.width / 2, -p.height / 2, p.width, p.height);

    if (this.debug.view === 'flow' && this.debug.showFlowArrows && this.arrowOverlay) {
      p.push();
      p.resetShader();
      p.imageMode(p.CORNER);
      p.blendMode(p.ADD);
      p.translate(-p.width / 2, -p.height / 2);
      p.image(this.arrowOverlay, 0, 0, p.width, p.height);
      p.pop();
    }

    if (p.frameCount % 20 === 0) {
      this.updateLeakageEstimate();
    }

    this.metrics.fps = p.frameRate();
    this.renderStats();
  }

  public destroy(): void {
    this.canvas?.remove();
  }

  private async loadBaseImage(url: string): Promise<void> {
    const p = this.p;
    const loaded = await new Promise<p5.Image>((resolve, reject) => {
      p.loadImage(
        url,
        (img) => resolve(img),
        (event) => reject(new Error(`Failed loading image: ${String(event)}`)),
      );
    });

    this.workingBaseImage = loaded.get();
    this.workingBaseImage.resize(this.renderWidth, this.renderHeight);

    this.computeVisionTextures(this.workingBaseImage);
    await this.applyOptionalOverrides();
    this.rebuildActiveMask();
    this.buildFlowArrows();
    this.resetFlowState();
  }

  private computeVisionTextures(image: p5.Image): void {
    const imageData = this.imageDataFromP5Image(image);

    const region = extractRegionMasks(imageData, this.segmentation.clusters, this.params.seed);
    const edge = extractEdges(imageData, this.segmentation.edgeThreshold, this.segmentation.edgeDilate);
    const flow = buildFlowHint(imageData, this.segmentation.flowSmoothing);

    this.regionCount = region.regionCount;

    this.regionImage = this.createGrayTextureFromRegionIds(region.regionIds, region.width, region.height, region.regionCount);
    this.edgeImage = this.createGrayTexture(edge.edgeMask, edge.width, edge.height);
    this.confidenceImage = this.createGrayTextureFloat(region.confidence, region.width, region.height);
    this.flowImage = this.createFlowTexture(flow.vectors, flow.width, flow.height);
    this.flowMagnitudeImage = this.createGrayTextureFloat(flow.magnitude, flow.width, flow.height);

    this.vision = {
      width: imageData.width,
      height: imageData.height,
      regionCount: region.regionCount,
      regionIds: region.regionIds,
      confidence: region.confidence,
      edgeMask: edge.edgeMask,
      flowVectors: flow.vectors,
      flowMagnitude: flow.magnitude,
    };
  }

  private async applyOptionalOverrides(): Promise<void> {
    if (!this.inputPackage.maskPackUrl && !this.inputPackage.flowHintUrl) {
      return;
    }

    const p = this.p;

    if (this.inputPackage.maskPackUrl) {
      try {
        const maskPackUrl = this.inputPackage.maskPackUrl;
        const response = await fetch(maskPackUrl);
        if (response.ok) {
          const payload = (await response.json()) as unknown;
          const resolvedPack = parseMaskPackManifest(payload, maskPackUrl);
          await this.applyMaskPack(resolvedPack);
        }
      } catch {
        // Keep auto-extracted masks if optional pack is invalid.
      }
    }

    if (this.inputPackage.flowHintUrl) {
      try {
        const externalFlow = await new Promise<p5.Image>((resolve, reject) => {
          p.loadImage(
            this.inputPackage.flowHintUrl as string,
            (img) => resolve(img),
            () => reject(new Error('Cannot load flow hint image')),
          );
        });
        this.applyFlowHintOverride(externalFlow);
      } catch {
        // Ignore malformed flow hint overrides.
      }
    }
  }

  private async applyMaskPack(pack: ResolvedMaskPackManifest): Promise<void> {
    const p = this.p;
    const loadMaybe = async (url?: string): Promise<p5.Image | null> => {
      if (!url) {
        return null;
      }
      try {
        return await new Promise<p5.Image>((resolve, reject) => {
          p.loadImage(
            url,
            (img) => resolve(img),
            () => reject(new Error('failed')),
          );
        });
      } catch {
        return null;
      }
    };

    const [regionMask, edgeMask, confidenceMask] = await Promise.all([
      loadMaybe(pack.regionMaskUrl),
      loadMaybe(pack.edgeMaskUrl),
      loadMaybe(pack.confidenceUrl),
    ]);

    if (regionMask) {
      regionMask.resize(this.renderWidth, this.renderHeight);
      this.regionImage = regionMask;
      if (typeof pack.regionCount === 'number' && Number.isFinite(pack.regionCount)) {
        this.regionCount = Math.max(1, Math.min(255, Math.round(pack.regionCount)));
      }
    }

    if (edgeMask) {
      edgeMask.resize(this.renderWidth, this.renderHeight);
      this.edgeImage = edgeMask;
    }

    if (confidenceMask) {
      confidenceMask.resize(this.renderWidth, this.renderHeight);
      this.confidenceImage = confidenceMask;
    }
  }

  private applyFlowHintOverride(flowHintImage: p5.Image): void {
    flowHintImage.resize(this.renderWidth, this.renderHeight);
    this.flowImage = flowHintImage;
    this.flowMagnitudeImage = this.createMagnitudeTextureFromFlowHint(flowHintImage);
  }

  private runFlowPass(dt: number): void {
    if (
      !this.flowBufferA ||
      !this.flowBufferB ||
      !this.flowShader ||
      !this.regionImage ||
      !this.edgeImage ||
      !this.confidenceImage ||
      !this.flowImage ||
      !this.flowMagnitudeImage ||
      !this.workingBaseImage
    ) {
      return;
    }

    this.flowBufferB.shader(this.flowShader);
    this.flowShader.setUniform('u_prevTex', this.flowBufferA);
    this.flowShader.setUniform('u_baseTex', this.workingBaseImage);
    this.flowShader.setUniform('u_regionTex', this.regionImage);
    this.flowShader.setUniform('u_edgeTex', this.edgeImage);
    this.flowShader.setUniform('u_confidenceTex', this.confidenceImage);
    this.flowShader.setUniform('u_flowHintTex', this.flowImage);
    this.flowShader.setUniform('u_flowMagTex', this.flowMagnitudeImage);

    this.flowShader.setUniform('u_resolution', [this.renderWidth, this.renderHeight]);
    this.flowShader.setUniform('u_time', this.p.millis() / 1000);
    this.flowShader.setUniform('u_dt', dt);
    this.flowShader.setUniform('u_motionSpeed', this.params.motionSpeed);
    this.flowShader.setUniform('u_turbulence', this.params.turbulence);
    this.flowShader.setUniform('u_edgeLock', this.params.edgeLock);
    this.flowShader.setUniform('u_maskFeather', this.params.maskFeather);
    this.flowShader.setUniform('u_textureScale', this.params.textureScale);
    this.flowShader.setUniform('u_activeRegion', this.params.activeRegionId);
    this.flowShader.setUniform('u_regionCount', this.regionCount);

    this.flowBufferB.rect(
      -this.flowBufferB.width / 2,
      -this.flowBufferB.height / 2,
      this.flowBufferB.width,
      this.flowBufferB.height,
    );

    [this.flowBufferA, this.flowBufferB] = [this.flowBufferB, this.flowBufferA];
  }

  private runCompositePass(): void {
    if (
      !this.composeBuffer ||
      !this.compositeShader ||
      !this.workingBaseImage ||
      !this.flowBufferA ||
      !this.regionImage ||
      !this.edgeImage ||
      !this.confidenceImage ||
      !this.flowImage ||
      !this.flowMagnitudeImage
    ) {
      return;
    }

    this.composeBuffer.shader(this.compositeShader);
    this.compositeShader.setUniform('u_baseTex', this.workingBaseImage);
    this.compositeShader.setUniform('u_flowStateTex', this.flowBufferA);
    this.compositeShader.setUniform('u_regionTex', this.regionImage);
    this.compositeShader.setUniform('u_edgeTex', this.edgeImage);
    this.compositeShader.setUniform('u_confidenceTex', this.confidenceImage);
    this.compositeShader.setUniform('u_flowHintTex', this.flowImage);
    this.compositeShader.setUniform('u_flowMagTex', this.flowMagnitudeImage);

    this.compositeShader.setUniform('u_resolution', [this.renderWidth, this.renderHeight]);
    this.compositeShader.setUniform('u_time', this.p.millis() / 1000);
    this.compositeShader.setUniform('u_grainAmount', this.params.grainAmount);
    this.compositeShader.setUniform('u_chromaAberration', this.params.chromaAberration);
    this.compositeShader.setUniform('u_maskFeather', this.params.maskFeather);
    this.compositeShader.setUniform('u_activeRegion', this.params.activeRegionId);
    this.compositeShader.setUniform('u_regionCount', this.regionCount);
    this.compositeShader.setUniform('u_debugMode', DEBUG_MODE_MAP[this.debug.view]);

    this.composeBuffer.rect(
      -this.composeBuffer.width / 2,
      -this.composeBuffer.height / 2,
      this.composeBuffer.width,
      this.composeBuffer.height,
    );
  }

  private resetFlowState(): void {
    if (!this.flowBufferA || !this.flowBufferB) {
      return;
    }
    this.flowBufferA.clear();
    this.flowBufferA.background(0, 0, 0, 255);
    this.flowBufferB.clear();
    this.flowBufferB.background(0, 0, 0, 255);
  }

  private rebuildActiveMask(): void {
    if (!this.vision) {
      this.activeMask = new Float32Array(0);
      return;
    }

    const total = this.vision.width * this.vision.height;
    this.activeMask = new Float32Array(total);

    for (let i = 0; i < total; i += 1) {
      const confidence = this.vision.confidence[i];
      const rid = this.vision.regionIds[i];
      const selected =
        this.params.activeRegionId < 0 ? 1 : rid === this.params.activeRegionId ? 1 : 0;
      const confBoost = this.p.constrain(
        this.p.map(confidence, 0.15 - this.params.maskFeather * 0.1, 0.8, 0, 1),
        0,
        1,
      );
      this.activeMask[i] = selected * confBoost;
    }

    this.maskSignature = `${this.params.activeRegionId}:${this.params.maskFeather.toFixed(3)}`;
  }

  private updateLeakageEstimate(): void {
    if (!this.flowBufferA || !this.activeMask.length) {
      return;
    }

    this.flowBufferA.loadPixels();
    const px = this.flowBufferA.pixels;

    let outsideEnergy = 0;
    let totalEnergy = 0;
    const step = 4;

    for (let y = 0; y < this.renderHeight; y += step) {
      for (let x = 0; x < this.renderWidth; x += step) {
        const pIdx = (y * this.renderWidth + x) * 4;
        const v = px[pIdx] / 255;
        const mask = this.activeMask[y * this.renderWidth + x] || 0;
        outsideEnergy += v * (1 - mask);
        totalEnergy += v;
      }
    }

    this.metrics.leakageRatio = totalEnergy > 0 ? outsideEnergy / totalEnergy : 0;
  }

  private renderStats(): void {
    const runtime = (performance.now() - this.frameStart) / 1000;
    this.statsTarget.innerHTML = [
      `<span>fps: ${this.metrics.fps.toFixed(1)}</span>`,
      `<span>leakage: ${(this.metrics.leakageRatio * 100).toFixed(2)}%</span>`,
      `<span>region: ${this.params.activeRegionId < 0 ? 'ALL' : this.params.activeRegionId}</span>`,
      `<span>regions total: ${this.regionCount}</span>`,
      `<span>runtime: ${runtime.toFixed(1)}s</span>`,
    ].join('');
  }

  private buildFlowArrows(): void {
    if (!this.arrowOverlay || !this.vision) {
      return;
    }

    const g = this.arrowOverlay;
    g.clear();
    g.push();
    g.stroke(255, 214, 156, 120);
    g.strokeWeight(1);
    g.noFill();

    const stride = 30;
    for (let y = stride; y < this.vision.height - stride; y += stride) {
      for (let x = stride; x < this.vision.width - stride; x += stride) {
        const idx = (y * this.vision.width + x) * 2;
        const mag = this.vision.flowMagnitude[y * this.vision.width + x];
        if (mag < 0.08) {
          continue;
        }

        const vx = this.vision.flowVectors[idx];
        const vy = this.vision.flowVectors[idx + 1];

        const scale = 8 + mag * 8;
        const x2 = x + vx * scale;
        const y2 = y + vy * scale;

        g.line(x, y, x2, y2);
        const hx = x2 - vx * 2.5 - vy * 1.6;
        const hy = y2 - vy * 2.5 + vx * 1.6;
        const hx2 = x2 - vx * 2.5 + vy * 1.6;
        const hy2 = y2 - vy * 2.5 - vx * 1.6;
        g.line(x2, y2, hx, hy);
        g.line(x2, y2, hx2, hy2);
      }
    }
    g.pop();
  }

  private imageDataFromP5Image(image: p5.Image): ImageData {
    image.loadPixels();
    const pixels = image.pixels;
    return new ImageData(new Uint8ClampedArray(pixels), image.width, image.height);
  }

  private createGrayTexture(data: Uint8Array, width: number, height: number): p5.Image {
    const img = this.p.createImage(width, height);
    img.loadPixels();
    for (let i = 0; i < width * height; i += 1) {
      const v = data[i];
      const idx = i * 4;
      img.pixels[idx] = v;
      img.pixels[idx + 1] = v;
      img.pixels[idx + 2] = v;
      img.pixels[idx + 3] = 255;
    }
    img.updatePixels();
    return img;
  }

  private createGrayTextureFloat(data: Float32Array, width: number, height: number): p5.Image {
    const img = this.p.createImage(width, height);
    img.loadPixels();
    for (let i = 0; i < width * height; i += 1) {
      const v = Math.floor(this.p.constrain(data[i], 0, 1) * 255);
      const idx = i * 4;
      img.pixels[idx] = v;
      img.pixels[idx + 1] = v;
      img.pixels[idx + 2] = v;
      img.pixels[idx + 3] = 255;
    }
    img.updatePixels();
    return img;
  }

  private createGrayTextureFromRegionIds(
    regionIds: Uint8Array,
    width: number,
    height: number,
    regionCount: number,
  ): p5.Image {
    const img = this.p.createImage(width, height);
    const denom = Math.max(1, regionCount - 1);

    img.loadPixels();
    for (let i = 0; i < width * height; i += 1) {
      const v = Math.floor((regionIds[i] / denom) * 255);
      const idx = i * 4;
      img.pixels[idx] = v;
      img.pixels[idx + 1] = v;
      img.pixels[idx + 2] = v;
      img.pixels[idx + 3] = 255;
    }
    img.updatePixels();
    return img;
  }

  private createFlowTexture(vectors: Float32Array, width: number, height: number): p5.Image {
    const img = this.p.createImage(width, height);
    img.loadPixels();
    for (let i = 0; i < width * height; i += 1) {
      const idxVec = i * 2;
      const r = Math.floor((vectors[idxVec] * 0.5 + 0.5) * 255);
      const g = Math.floor((vectors[idxVec + 1] * 0.5 + 0.5) * 255);
      const idx = i * 4;
      img.pixels[idx] = r;
      img.pixels[idx + 1] = g;
      img.pixels[idx + 2] = 127;
      img.pixels[idx + 3] = 255;
    }
    img.updatePixels();
    return img;
  }

  private createMagnitudeTextureFromFlowHint(flowHint: p5.Image): p5.Image {
    const out = this.p.createImage(flowHint.width, flowHint.height);
    flowHint.loadPixels();
    out.loadPixels();

    for (let i = 0; i < flowHint.width * flowHint.height; i += 1) {
      const idx = i * 4;
      const mag = flowHint.pixels[idx + 2];
      out.pixels[idx] = mag;
      out.pixels[idx + 1] = mag;
      out.pixels[idx + 2] = mag;
      out.pixels[idx + 3] = 255;
    }

    out.updatePixels();
    return out;
  }
}
