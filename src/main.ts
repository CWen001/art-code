import p5 from 'p5';
import './style.css';
import defaultPreset from './presets/local-constrained-flow.json';
import { Renderer } from './engine/renderer';
import { createControlPanel } from './ui/panel';
import { ArtInputPackage, DebugConfig, EngineParams, Preset, SegmentationConfig } from './types';

function createPlaceholderArtDataUrl(label: string, colors: [string, string, string, string]): string {
  const [bg, primary, secondary, accent] = colors;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 720">
      <rect width="720" height="720" fill="${bg}" />
      <circle cx="220" cy="250" r="170" fill="${primary}" opacity="0.95" />
      <rect x="340" y="120" width="220" height="300" rx="36" fill="${secondary}" opacity="0.88" transform="rotate(14 450 270)" />
      <path d="M120 520 C240 430, 360 620, 560 500" fill="none" stroke="${accent}" stroke-width="34" stroke-linecap="round" />
      <path d="M140 160 L300 140 L280 320 Z" fill="${accent}" opacity="0.22" />
      <text x="48" y="676" fill="rgba(255,255,255,0.72)" font-size="28" font-family="IBM Plex Sans, Arial, sans-serif">${label}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const sampleInputs: Record<string, string> = {
  'Built-in Sample A': createPlaceholderArtDataUrl('Sample A', ['#12151c', '#d66c4a', '#e5d2b8', '#f4f0e8']),
  'Built-in Sample B': createPlaceholderArtDataUrl('Sample B', ['#10181f', '#3d7f8c', '#e9b44c', '#f5f2eb']),
  'Built-in Sample C': createPlaceholderArtDataUrl('Sample C', ['#181118', '#9b4d96', '#6fc3b2', '#f0ebe3']),
};

const inputPackage: ArtInputPackage = {
  baseImageUrl: sampleInputs['Built-in Sample A'],
  meta: {
    title: 'Local Constrained Flow',
    source: 'built-in placeholder artwork',
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

function replaceInputPackage(nextInput: ArtInputPackage): void {
  inputPackage.baseImageUrl = nextInput.baseImageUrl;

  if (nextInput.maskPackUrl) {
    inputPackage.maskPackUrl = nextInput.maskPackUrl;
  } else {
    delete inputPackage.maskPackUrl;
  }

  if (nextInput.flowHintUrl) {
    inputPackage.flowHintUrl = nextInput.flowHintUrl;
  } else {
    delete inputPackage.flowHintUrl;
  }

  if (nextInput.meta) {
    inputPackage.meta = { ...nextInput.meta };
  } else {
    delete inputPackage.meta;
  }
}

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
          initialInput: inputPackage,
          onApplyInputPackage: async (nextInput) => {
            replaceInputPackage(nextInput);
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
        panelHandle?.setStatus('error', 'Renderer initialization failed.');
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
