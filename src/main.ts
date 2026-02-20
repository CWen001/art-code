import p5 from 'p5';
import './style.css';
import defaultPreset from './presets/local-constrained-flow.json';
import { Renderer } from './engine/renderer';
import { createControlPanel } from './ui/panel';
import { ArtInputPackage, DebugConfig, EngineParams, Preset, SegmentationConfig } from './types';

const sampleInputs: Record<string, string> = {
  'sample_input_a (default)': new URL('../ref/pics/sample_input_a.jpeg', import.meta.url).href,
  'sample_input_b': new URL('../ref/pics/sample_input_b.jpeg', import.meta.url).href,
  sample_input_c: new URL('../ref/pics/sample_input_c.jpeg', import.meta.url).href,
};

const inputPackage: ArtInputPackage = {
  baseImageUrl: sampleInputs['sample_input_a (default)'],
  meta: {
    title: 'external artist Local Flow - Phase 2.5+3',
    source: 'ref/pics/sample_input_a.jpeg',
  },
};

const params: EngineParams = {
  ...defaultPreset.params,
};

const segmentation: SegmentationConfig = {
  clusters: 10,
  edgeThreshold: 0.18,
  edgeDilate: 2,
  flowSmoothing: 2,
};

const debug: DebugConfig = {
  view: 'final',
  showFlowArrows: true,
};

const canvasRoot = document.getElementById('canvas-root');
const guiRoot = document.getElementById('gui-root');
const statsBar = document.getElementById('stats-bar');

if (!canvasRoot || !guiRoot || !statsBar) {
  throw new Error('Missing root DOM nodes');
}

let renderer: Renderer | null = null;
let panelHandle: ReturnType<typeof createControlPanel> | null = null;

new p5((p) => {
  p.setup = () => {
    renderer = new Renderer(p, {
      parent: canvasRoot,
      statsTarget: statsBar,
      inputPackage,
      params,
      segmentation,
      debug,
    });

    renderer
      .initialize()
      .then(async () => {
        if (!renderer) {
          return;
        }

        panelHandle = createControlPanel({
          guiRoot,
          params,
          segmentation,
          debug,
          sampleInputs,
          onReloadInput: async (url) => {
            inputPackage.baseImageUrl = url;
            await renderer?.reloadInput(inputPackage);
            panelHandle?.refreshRegionRange();
          },
          onRecomputeVision: async () => {
            await renderer?.recomputeVision();
            panelHandle?.refreshRegionRange();
          },
          onResetFlow: () => {
            renderer?.resetFlow();
          },
          getRegionCount: () => renderer?.getRegionCount() ?? 1,
        });

        await panelHandle.applyPreset(defaultPreset as Preset);
      })
      .catch((error: unknown) => {
        console.error(error);
        statsBar.textContent = 'Initialization failed. See console for details.';
      });
  };

  p.draw = () => {
    renderer?.draw();
  };
});

window.addEventListener('beforeunload', () => {
  panelHandle?.dispose();
  renderer?.destroy();
});
