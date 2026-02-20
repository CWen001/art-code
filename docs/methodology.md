# Local Constrained Flow - Methodology

## Scope
This phase implements the **2.5 + 3** pipeline only:
- Input: static base artwork (`base image`) with optional mask/flow overrides.
- Output: real-time constrained kinetic texture in web preview (`720p`, target `>=30fps`).

Not included in this phase:
- Prompt-image generation (NanoBanana or diffusion tooling)
- Global mandala collapse / polar remapping
- Model training / cloud deployment

## Input Requirements
For stable constrained motion, the base image should satisfy:
1. Color block separability: clear local palette contrast for clustering (`k=8..12`).
2. Edge density: visible contour boundaries; thin lines are acceptable if dilation is enabled.
3. Texture grain diversity: both smooth and high-frequency regions help visual rhythm.
4. Resolution: source can be high-res, runtime uses 720x720 working buffer.

Recommended sample order:
1. `ref/pics/sample_input_a.jpeg` (default)
2. `ref/pics/sample_input_b.jpeg`
3. `ref/pics/sample_input_c.jpeg`

## System Pipeline
1. **Segmentation** (`maskExtractor.ts`)
- Color clustering (`kmeans`, configurable `clusters`)
- Region id map + confidence map
- Tiny region merge to reduce speckle noise

2. **Boundary Locking** (`edgeExtractor.ts`)
- Sobel edge detection
- Binary threshold
- Morphological dilation to strengthen hard boundaries

3. **Flow Hint** (`flowHint.ts`)
- Tangential vectors from image gradients
- Magnitude normalization
- Optional smoothing passes

4. **Kinetic Pass** (`maskFlowPass.frag`)
- Ping-pong FBO advection (`prev/curr`)
- Region mask gate (`activeRegionId`)
- Edge lock suppression (`edgeLock`)
- Local texture synthesis (stripe + stipple + fiber)

5. **Composite Pass** (`compositePass.frag`)
- Base + kinetic layer blend
- Subtle paper grain and chromatic shift
- Debug outputs: region / edge / flow / confidence / leakage

## Parameter Tuning Order
Tune in this strict order:
1. `edgeLock` and segmentation settings first (stop boundary leak)
2. `motionSpeed` second (set spatial travel distance)
3. `turbulence` third (add local irregularity)
4. `textureScale` fourth (define micro-pattern density)
5. `grainAmount` and `chromaAberration` last (final material feel)

## Common Failure Modes and Fixes
1. **Leakage too high** (dynamic spills outside intended area)
- Raise `edgeLock`
- Increase `edgeDilate`
- Lower `motionSpeed`
- Reduce `turbulence`

2. **Motion looks dead / static**
- Increase `motionSpeed`
- Increase `textureScale` slightly
- Select a single high-contrast region (`activeRegionId`)

3. **Image feels over-processed / too digital**
- Lower `chromaAberration`
- Lower `grainAmount`
- Reduce `turbulence`

4. **Segmentation unstable on dense artwork**
- Reduce cluster count (`clusters` to 8 or 9)
- Recompute maps
- Optionally provide external mask pack override

## Validation Workflow
### FPS
```bash
npm run validate:fps -- --video <output.mp4> --min 30
```

### Leakage
```bash
npm run validate:leakage -- --video <output.mp4> --base ref/pics/sample_input_a.jpeg --threshold 0.03 --max-frames 240
```

Interpretation:
- `leakage <= 3%` is target
- `fps >= 30` at 720p is target

## Next Phase Hook (for Step 1 integration)
Future "photo/illustration -> stylized base" stage should output a compatible `ArtInputPackage`:
- `baseImageUrl`
- optional `maskPackUrl` (region/edge/confidence)
- optional `flowHintUrl`

No core engine interface changes are required.
