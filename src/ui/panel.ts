import GUI from 'lil-gui';
import { DebugConfig, DebugView, EngineParams, Preset, SegmentationConfig } from '../types';

type PanelBindings = {
  guiRoot: HTMLElement;
  params: EngineParams;
  segmentation: SegmentationConfig;
  debug: DebugConfig;
  sampleInputs: Record<string, string>;
  onReloadInput: (url: string) => Promise<void>;
  onRecomputeVision: () => Promise<void>;
  onResetFlow: () => void;
  getRegionCount: () => number;
};

type PanelController = {
  gui: GUI;
  refreshRegionRange: () => void;
  applyPreset: (preset: Preset) => Promise<void>;
  dispose: () => void;
};

const DEBUG_OPTIONS: Record<string, DebugView> = {
  final: 'final',
  regionMask: 'regionMask',
  edgeMask: 'edgeMask',
  flow: 'flow',
  confidence: 'confidence',
  leakage: 'leakage',
};

export function createControlPanel(bindings: PanelBindings): PanelController {
  const gui = new GUI({
    autoPlace: false,
    width: 320,
  });

  bindings.guiRoot.innerHTML = '';
  bindings.guiRoot.appendChild(gui.domElement);

  const inputState = {
    source: Object.keys(bindings.sampleInputs)[0],
    reloadSource: async () => {
      const target = bindings.sampleInputs[inputState.source];
      if (target) {
        await bindings.onReloadInput(target);
        refreshRegionRange();
      }
    },
  };

  const segmentationState = {
    clusters: bindings.segmentation.clusters,
    edgeThreshold: bindings.segmentation.edgeThreshold,
    edgeDilate: bindings.segmentation.edgeDilate,
    flowSmoothing: bindings.segmentation.flowSmoothing,
    recompute: async () => {
      syncSegmentation();
      await bindings.onRecomputeVision();
      refreshRegionRange();
    },
  };

  const presetState = {
    applyPreset: async () => {
      await bindings.onRecomputeVision();
      refreshRegionRange();
    },
    exportPreset: () => {
      const payload: Preset = {
        name: 'custom-export',
        params: { ...bindings.params },
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'local-constrained-flow.custom.json';
      a.click();
      URL.revokeObjectURL(url);
    },
  };

  const inputFolder = gui.addFolder('Input');
  inputFolder
    .add(inputState, 'source', Object.keys(bindings.sampleInputs))
    .name('base image')
    .onFinishChange(async () => {
      await inputState.reloadSource();
    });
  inputFolder.add(inputState, 'reloadSource').name('reload');

  const segFolder = gui.addFolder('Segmentation');
  segFolder.add(segmentationState, 'clusters', 8, 12, 1).name('clusters');
  segFolder.add(segmentationState, 'edgeThreshold', 0.05, 0.45, 0.01).name('edge threshold');
  segFolder.add(segmentationState, 'edgeDilate', 0, 5, 1).name('edge dilate');
  segFolder.add(segmentationState, 'flowSmoothing', 0, 4, 1).name('flow smooth');
  segFolder.add(segmentationState, 'recompute').name('recompute maps');

  const flowFolder = gui.addFolder('Flow');
  flowFolder.add(bindings.params, 'motionSpeed', 0, 3, 0.01).name('motion speed');
  flowFolder.add(bindings.params, 'turbulence', 0, 1.5, 0.01).name('turbulence');
  flowFolder.add(bindings.params, 'edgeLock', 0, 1.2, 0.01).name('edge lock');

  const textureFolder = gui.addFolder('Texture');
  textureFolder.add(bindings.params, 'maskFeather', 0, 1, 0.01).name('mask feather');
  textureFolder.add(bindings.params, 'textureScale', 0, 1.4, 0.01).name('texture scale');
  const regionController = textureFolder
    .add(bindings.params, 'activeRegionId', -1, Math.max(0, bindings.getRegionCount() - 1), 1)
    .name('active region');

  const postFolder = gui.addFolder('Post');
  postFolder.add(bindings.params, 'grainAmount', 0, 1, 0.01).name('grain');
  postFolder.add(bindings.params, 'chromaAberration', 0, 1, 0.01).name('chroma shift');

  const debugFolder = gui.addFolder('Debug');
  debugFolder.add(bindings.debug, 'view', DEBUG_OPTIONS).name('view');
  debugFolder.add(bindings.debug, 'showFlowArrows').name('flow arrows');
  debugFolder.add(bindings, 'onResetFlow').name('reset flow');

  const presetFolder = gui.addFolder('Presets');
  presetFolder.add(presetState, 'applyPreset').name('sync maps');
  presetFolder.add(presetState, 'exportPreset').name('export current');

  [inputFolder, segFolder, flowFolder, textureFolder, postFolder, debugFolder].forEach((folder) =>
    folder.open(),
  );

  function syncSegmentation(): void {
    bindings.segmentation.clusters = segmentationState.clusters;
    bindings.segmentation.edgeThreshold = segmentationState.edgeThreshold;
    bindings.segmentation.edgeDilate = segmentationState.edgeDilate;
    bindings.segmentation.flowSmoothing = segmentationState.flowSmoothing;
  }

  function refreshRegionRange(): void {
    const maxRegion = Math.max(0, bindings.getRegionCount() - 1);
    regionController.min(-1).max(maxRegion).step(1).updateDisplay();
    if (bindings.params.activeRegionId > maxRegion) {
      bindings.params.activeRegionId = -1;
      regionController.updateDisplay();
    }
  }

  return {
    gui,
    refreshRegionRange,
    applyPreset: async (preset: Preset) => {
      Object.assign(bindings.params, preset.params);
      gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
      await bindings.onRecomputeVision();
      refreshRegionRange();
    },
    dispose: () => gui.destroy(),
  };
}
