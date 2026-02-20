import { ArtInputPackage, DebugConfig, DebugView, EngineParams, Preset, SegmentationConfig } from '../types';
import { parseMaskPackManifest, parsePreprocessManifest } from '../contracts/artInputManifest';

type PanelBindings = {
  guiRoot: HTMLElement;
  params: EngineParams;
  segmentation: SegmentationConfig;
  debug: DebugConfig;
  sampleInputs: Record<string, string>;
  initialInput: ArtInputPackage;
  onApplyInputPackage: (inputPackage: ArtInputPackage) => Promise<void>;
  onRecomputeVision: () => Promise<void>;
  onResetFlow: () => void;
  getRegionCount: () => number;
};

type StatusLevel = 'idle' | 'busy' | 'success' | 'error';

type PanelController = {
  refreshRegionRange: () => void;
  applyPreset: (preset: Preset) => Promise<void>;
  setStatus: (level: StatusLevel, message: string) => void;
  dispose: () => void;
};

type ParamBundle = {
  params: EngineParams;
  segmentation: SegmentationConfig;
  debug: DebugConfig;
};

type SavedSnapshot = {
  id: string;
  name: string;
  createdAt: string;
  bundle: ParamBundle;
};

type SnapshotFilePayload = {
  kind?: string;
  version?: number;
  name?: string;
  createdAt?: string;
  params?: unknown;
  segmentation?: unknown;
  debug?: unknown;
  snapshot?: {
    name?: string;
    createdAt?: string;
    params?: unknown;
    segmentation?: unknown;
    debug?: unknown;
  };
};

const DEBUG_OPTIONS: Array<{ label: string; value: DebugView }> = [
  { label: 'Final', value: 'final' },
  { label: 'Region', value: 'regionMask' },
  { label: 'Edge', value: 'edgeMask' },
  { label: 'Flow', value: 'flow' },
  { label: 'Confidence', value: 'confidence' },
  { label: 'Leakage', value: 'leakage' },
];

const STATUS_LABEL: Record<StatusLevel, string> = {
  idle: 'Idle',
  busy: 'Busy',
  success: 'OK',
  error: 'Error',
};

export function createControlPanel(bindings: PanelBindings): PanelController {
  const objectUrls = new Set<string>();
  const controlSyncers: Array<() => void> = [];
  const snapshots: SavedSnapshot[] = [];
  const rollbackStack: ParamBundle[] = [];
  let slotA: SavedSnapshot | null = null;
  let slotB: SavedSnapshot | null = null;
  let lastAppliedSlot: 'A' | 'B' = 'B';
  let currentInput = cloneInputPackage(bindings.initialInput);
  let busy = false;
  let mapsDirty = false;
  let uploadedImageUrl: string | null = null;
  let disposed = false;

  const shell = createNode('div', 'panel-shell');
  shell.innerHTML = `
    <section class="panel-section">
      <div class="section-head">
        <h2>Input</h2>
        <p>Choose sample, local file, or preprocess manifest package.</p>
      </div>
      <div class="field">
        <label for="sample-input-select">Sample Base</label>
        <div class="field-inline">
          <select id="sample-input-select" data-el="sampleSelect"></select>
          <button type="button" data-el="applySample">Apply</button>
        </div>
      </div>
      <div class="field">
        <label for="local-image-input">Local Image</label>
        <input id="local-image-input" data-el="localImage" type="file" accept="image/*" />
      </div>
      <div class="field">
        <label for="manifest-url-input">Manifest URL</label>
        <div class="field-inline">
          <input id="manifest-url-input" data-el="manifestUrl" type="text" placeholder="/outputs/job-id/manifest.json" />
          <button type="button" data-el="loadManifestUrl">Load</button>
        </div>
      </div>
      <div class="field">
        <label for="manifest-file-input">Manifest File</label>
        <input id="manifest-file-input" data-el="manifestFile" type="file" accept="application/json,.json" />
      </div>
      <div class="kv-grid">
        <div>
          <span>Base</span>
          <code data-el="currentBase"></code>
        </div>
        <div>
          <span>Mask</span>
          <code data-el="currentMask"></code>
        </div>
        <div>
          <span>Flow</span>
          <code data-el="currentFlow"></code>
        </div>
      </div>
    </section>

    <section class="panel-section">
      <div class="section-head">
        <h2>Workflow</h2>
        <p>Snapshot, import/export, A/B compare, rollback.</p>
      </div>
      <div class="field">
        <label for="snapshot-name-input">Snapshot Name</label>
        <div class="field-inline">
          <input id="snapshot-name-input" data-el="snapshotName" type="text" placeholder="preset-iteration-a" />
          <button type="button" data-el="saveSnapshot">Save</button>
        </div>
      </div>
      <div class="button-row">
        <button type="button" data-el="exportCurrent">Export Current</button>
        <label class="file-button">
          Import JSON
          <input data-el="importSnapshotFile" type="file" accept="application/json,.json" />
        </label>
      </div>
      <div class="field">
        <label for="snapshot-list">Saved Snapshots</label>
        <select id="snapshot-list" data-el="snapshotList" size="5"></select>
      </div>
      <div class="button-row">
        <button type="button" data-el="applySnapshot">Apply Snapshot</button>
        <button type="button" data-el="deleteSnapshot">Delete</button>
        <button type="button" data-el="rollback">Rollback</button>
      </div>
      <div class="button-row">
        <button type="button" data-el="setA">Set A</button>
        <button type="button" data-el="setB">Set B</button>
        <button type="button" data-el="applyA">Apply A</button>
        <button type="button" data-el="applyB">Apply B</button>
        <button type="button" data-el="toggleAB">Toggle A/B</button>
      </div>
      <div class="kv-grid">
        <div>
          <span>Slot A</span>
          <code data-el="slotAValue">empty</code>
        </div>
        <div>
          <span>Slot B</span>
          <code data-el="slotBValue">empty</code>
        </div>
      </div>
    </section>

    <section class="panel-section">
      <div class="section-head">
        <h2>Parameters</h2>
        <p>Segmentation and motion controls. Seed/segmentation updates need recompute.</p>
      </div>
      <div class="subsection">
        <h3>Segmentation</h3>
        <div data-el="segmentationGrid" class="control-grid"></div>
        <div class="button-row">
          <button type="button" data-el="recomputeVision">Recompute Maps</button>
          <span data-el="mapsDirty" class="dirty-flag">Maps synced</span>
        </div>
      </div>
      <div class="subsection">
        <h3>Flow</h3>
        <div data-el="flowGrid" class="control-grid"></div>
      </div>
      <div class="subsection">
        <h3>Texture / Post</h3>
        <div data-el="textureGrid" class="control-grid"></div>
      </div>
    </section>

    <section class="panel-section">
      <div class="section-head">
        <h2>Debug</h2>
        <p>Fast debug view entry and consistent rendering toggles.</p>
      </div>
      <div class="debug-views" data-el="debugViewButtons"></div>
      <label class="checkbox-row" for="show-flow-arrows">
        <input id="show-flow-arrows" data-el="showFlowArrows" type="checkbox" />
        Show flow arrows
      </label>
      <div class="button-row">
        <button type="button" data-el="resetFlow">Reset Flow Buffer</button>
      </div>
      <div class="kv-grid">
        <div>
          <span>Region Count</span>
          <code data-el="regionCount">1</code>
        </div>
      </div>
    </section>

    <section class="panel-section status-section">
      <div class="section-head">
        <h2>Status</h2>
      </div>
      <div class="status-line">
        <span data-el="statusBadge" class="status-badge status-idle">Idle</span>
        <span data-el="statusText">Ready.</span>
      </div>
    </section>
  `;

  bindings.guiRoot.innerHTML = '';
  bindings.guiRoot.appendChild(shell);

  const sampleSelect = getNode<HTMLSelectElement>(shell, '[data-el="sampleSelect"]');
  const applySampleButton = getNode<HTMLButtonElement>(shell, '[data-el="applySample"]');
  const localImageInput = getNode<HTMLInputElement>(shell, '[data-el="localImage"]');
  const manifestUrlInput = getNode<HTMLInputElement>(shell, '[data-el="manifestUrl"]');
  const loadManifestUrlButton = getNode<HTMLButtonElement>(shell, '[data-el="loadManifestUrl"]');
  const manifestFileInput = getNode<HTMLInputElement>(shell, '[data-el="manifestFile"]');
  const currentBaseNode = getNode<HTMLElement>(shell, '[data-el="currentBase"]');
  const currentMaskNode = getNode<HTMLElement>(shell, '[data-el="currentMask"]');
  const currentFlowNode = getNode<HTMLElement>(shell, '[data-el="currentFlow"]');
  const snapshotNameInput = getNode<HTMLInputElement>(shell, '[data-el="snapshotName"]');
  const saveSnapshotButton = getNode<HTMLButtonElement>(shell, '[data-el="saveSnapshot"]');
  const exportCurrentButton = getNode<HTMLButtonElement>(shell, '[data-el="exportCurrent"]');
  const importSnapshotFileInput = getNode<HTMLInputElement>(shell, '[data-el="importSnapshotFile"]');
  const snapshotList = getNode<HTMLSelectElement>(shell, '[data-el="snapshotList"]');
  const applySnapshotButton = getNode<HTMLButtonElement>(shell, '[data-el="applySnapshot"]');
  const deleteSnapshotButton = getNode<HTMLButtonElement>(shell, '[data-el="deleteSnapshot"]');
  const rollbackButton = getNode<HTMLButtonElement>(shell, '[data-el="rollback"]');
  const setAButton = getNode<HTMLButtonElement>(shell, '[data-el="setA"]');
  const setBButton = getNode<HTMLButtonElement>(shell, '[data-el="setB"]');
  const applyAButton = getNode<HTMLButtonElement>(shell, '[data-el="applyA"]');
  const applyBButton = getNode<HTMLButtonElement>(shell, '[data-el="applyB"]');
  const toggleABButton = getNode<HTMLButtonElement>(shell, '[data-el="toggleAB"]');
  const slotAValue = getNode<HTMLElement>(shell, '[data-el="slotAValue"]');
  const slotBValue = getNode<HTMLElement>(shell, '[data-el="slotBValue"]');
  const segmentationGrid = getNode<HTMLElement>(shell, '[data-el="segmentationGrid"]');
  const flowGrid = getNode<HTMLElement>(shell, '[data-el="flowGrid"]');
  const textureGrid = getNode<HTMLElement>(shell, '[data-el="textureGrid"]');
  const recomputeVisionButton = getNode<HTMLButtonElement>(shell, '[data-el="recomputeVision"]');
  const mapsDirtyNode = getNode<HTMLElement>(shell, '[data-el="mapsDirty"]');
  const debugViewButtonsNode = getNode<HTMLElement>(shell, '[data-el="debugViewButtons"]');
  const showFlowArrowsInput = getNode<HTMLInputElement>(shell, '[data-el="showFlowArrows"]');
  const resetFlowButton = getNode<HTMLButtonElement>(shell, '[data-el="resetFlow"]');
  const regionCountNode = getNode<HTMLElement>(shell, '[data-el="regionCount"]');
  const statusBadgeNode = getNode<HTMLElement>(shell, '[data-el="statusBadge"]');
  const statusTextNode = getNode<HTMLElement>(shell, '[data-el="statusText"]');

  const sampleEntries = Object.entries(bindings.sampleInputs);
  for (const [label] of sampleEntries) {
    const option = document.createElement('option');
    option.value = label;
    option.textContent = label;
    sampleSelect.appendChild(option);
  }

  const initialSampleLabel = sampleEntries.find((entry) => entry[1] === currentInput.baseImageUrl)?.[0];
  if (initialSampleLabel) {
    sampleSelect.value = initialSampleLabel;
  } else if (sampleEntries.length > 0) {
    sampleSelect.value = sampleEntries[0][0];
  }

  function setStatus(level: StatusLevel, message: string): void {
    if (disposed) {
      return;
    }
    statusBadgeNode.textContent = STATUS_LABEL[level];
    statusBadgeNode.className = `status-badge status-${level}`;
    statusTextNode.textContent = message;
  }

  function setMapsDirty(next: boolean): void {
    mapsDirty = next;
    mapsDirtyNode.textContent = mapsDirty ? 'Maps pending recompute' : 'Maps synced';
    mapsDirtyNode.classList.toggle('is-dirty', mapsDirty);
  }

  function createBundle(): ParamBundle {
    return {
      params: cloneEngineParams(bindings.params),
      segmentation: cloneSegmentation(bindings.segmentation),
      debug: cloneDebug(bindings.debug),
    };
  }

  function pushRollback(bundle: ParamBundle): void {
    rollbackStack.push(bundle);
    if (rollbackStack.length > 30) {
      rollbackStack.shift();
    }
    rollbackButton.disabled = rollbackStack.length === 0;
  }

  function updateInputSummary(): void {
    currentBaseNode.textContent = compactValue(currentInput.baseImageUrl);
    currentMaskNode.textContent = compactValue(currentInput.maskPackUrl ?? 'none');
    currentFlowNode.textContent = compactValue(currentInput.flowHintUrl ?? 'none');
  }

  function renderSnapshotList(): void {
    const currentValue = snapshotList.value;
    snapshotList.innerHTML = '';

    snapshots.forEach((snapshot) => {
      const option = document.createElement('option');
      option.value = snapshot.id;
      option.textContent = `${snapshot.name} (${new Date(snapshot.createdAt).toLocaleTimeString()})`;
      snapshotList.appendChild(option);
    });

    if (snapshots.length === 0) {
      snapshotList.disabled = true;
      applySnapshotButton.disabled = true;
      deleteSnapshotButton.disabled = true;
      return;
    }

    snapshotList.disabled = false;
    applySnapshotButton.disabled = false;
    deleteSnapshotButton.disabled = false;
    snapshotList.value = snapshots.some((snapshot) => snapshot.id === currentValue)
      ? currentValue
      : snapshots[0].id;
  }

  function updateABLabels(): void {
    slotAValue.textContent = slotA ? `${slotA.name} @ ${new Date(slotA.createdAt).toLocaleTimeString()}` : 'empty';
    slotBValue.textContent = slotB ? `${slotB.name} @ ${new Date(slotB.createdAt).toLocaleTimeString()}` : 'empty';
    applyAButton.disabled = !slotA;
    applyBButton.disabled = !slotB;
    toggleABButton.disabled = !slotA || !slotB;
  }

  async function runTask(taskName: string, task: () => Promise<void>): Promise<void> {
    if (busy) {
      setStatus('error', 'Another task is running.');
      return;
    }
    busy = true;
    setStatus('busy', `${taskName}...`);
    try {
      await task();
      if (!disposed) {
        setStatus('success', `${taskName} done.`);
      }
    } catch (error: unknown) {
      if (!disposed) {
        setStatus('error', `${taskName} failed: ${toErrorMessage(error)}`);
      }
    } finally {
      busy = false;
    }
  }

  function needsVisionRecompute(before: ParamBundle, after: ParamBundle): boolean {
    return (
      before.params.seed !== after.params.seed ||
      before.segmentation.clusters !== after.segmentation.clusters ||
      before.segmentation.edgeThreshold !== after.segmentation.edgeThreshold ||
      before.segmentation.edgeDilate !== after.segmentation.edgeDilate ||
      before.segmentation.flowSmoothing !== after.segmentation.flowSmoothing
    );
  }

  function syncAllControls(): void {
    controlSyncers.forEach((sync) => sync());
    setMapsDirty(false);
  }

  async function applyBundle(
    nextBundle: ParamBundle,
    options: { label: string; withRollback?: boolean },
  ): Promise<void> {
    const currentBundle = createBundle();
    if (options.withRollback ?? true) {
      pushRollback(currentBundle);
    }

    const shouldRecompute = needsVisionRecompute(currentBundle, nextBundle);
    Object.assign(bindings.params, nextBundle.params);
    Object.assign(bindings.segmentation, nextBundle.segmentation);
    Object.assign(bindings.debug, nextBundle.debug);
    syncAllControls();

    if (shouldRecompute) {
      await bindings.onRecomputeVision();
      refreshRegionRange();
    }

    setStatus('success', `${options.label} applied.`);
  }

  function recordPendingMapChange(previousBundle: ParamBundle): void {
    pushRollback(previousBundle);
    setMapsDirty(true);
  }

  function createSliderControl<T extends Record<string, number>>(
    root: HTMLElement,
    target: T,
    options: {
      key: keyof T;
      label: string;
      min: number;
      max: number;
      step: number;
      precision?: number;
      onCommit?: (previousBundle: ParamBundle) => Promise<void> | void;
    },
  ): void {
    const row = createNode('label', 'control-row');
    const labelNode = createNode('span', 'control-label', options.label);
    const rangeNode = document.createElement('input');
    rangeNode.type = 'range';
    rangeNode.min = String(options.min);
    rangeNode.max = String(options.max);
    rangeNode.step = String(options.step);
    rangeNode.className = 'control-range';

    const numberNode = document.createElement('input');
    numberNode.type = 'number';
    numberNode.min = String(options.min);
    numberNode.max = String(options.max);
    numberNode.step = String(options.step);
    numberNode.className = 'control-number';

    row.appendChild(labelNode);
    row.appendChild(rangeNode);
    row.appendChild(numberNode);
    root.appendChild(row);

    const precision =
      options.precision !== undefined ? options.precision : Math.max(0, countStepDecimals(options.step));

    const readValue = (): number => Number(target[options.key]);
    const writeValue = (value: number): void => {
      const clamped = clampNumber(value, options.min, options.max);
      target[options.key] = clamped as T[keyof T];
      const formatted = formatNumber(clamped, precision);
      rangeNode.value = String(clamped);
      numberNode.value = formatted;
    };

    let previousBundle: ParamBundle | null = null;
    const beginInteraction = (): void => {
      if (!previousBundle) {
        previousBundle = createBundle();
      }
    };
    const commitInteraction = async (): Promise<void> => {
      if (!previousBundle) {
        return;
      }
      const rollbackValue = previousBundle;
      previousBundle = null;
      if (options.onCommit) {
        await options.onCommit(rollbackValue);
      } else {
        pushRollback(rollbackValue);
      }
    };

    const updateFromRange = (): void => {
      const next = Number(rangeNode.value);
      if (!Number.isFinite(next)) {
        return;
      }
      writeValue(next);
    };

    const updateFromNumber = (): void => {
      const next = Number(numberNode.value);
      if (!Number.isFinite(next)) {
        writeValue(readValue());
        return;
      }
      writeValue(next);
    };

    rangeNode.addEventListener('pointerdown', beginInteraction);
    rangeNode.addEventListener('focus', beginInteraction);
    rangeNode.addEventListener('input', updateFromRange);
    rangeNode.addEventListener('change', () => {
      void commitInteraction();
    });

    numberNode.addEventListener('focus', beginInteraction);
    numberNode.addEventListener('input', updateFromNumber);
    numberNode.addEventListener('change', () => {
      void commitInteraction();
    });

    controlSyncers.push(() => writeValue(readValue()));
    writeValue(readValue());
  }

  createSliderControl(segmentationGrid, bindings.params, {
    key: 'seed',
    label: 'Seed',
    min: 1,
    max: 99999,
    step: 1,
    precision: 0,
    onCommit: (previousBundle) => recordPendingMapChange(previousBundle),
  });
  createSliderControl(segmentationGrid, bindings.segmentation, {
    key: 'clusters',
    label: 'Clusters',
    min: 8,
    max: 12,
    step: 1,
    precision: 0,
    onCommit: (previousBundle) => recordPendingMapChange(previousBundle),
  });
  createSliderControl(segmentationGrid, bindings.segmentation, {
    key: 'edgeThreshold',
    label: 'Edge Threshold',
    min: 0.05,
    max: 0.45,
    step: 0.01,
    onCommit: (previousBundle) => recordPendingMapChange(previousBundle),
  });
  createSliderControl(segmentationGrid, bindings.segmentation, {
    key: 'edgeDilate',
    label: 'Edge Dilate',
    min: 0,
    max: 5,
    step: 1,
    precision: 0,
    onCommit: (previousBundle) => recordPendingMapChange(previousBundle),
  });
  createSliderControl(segmentationGrid, bindings.segmentation, {
    key: 'flowSmoothing',
    label: 'Flow Smooth',
    min: 0,
    max: 4,
    step: 1,
    precision: 0,
    onCommit: (previousBundle) => recordPendingMapChange(previousBundle),
  });
  createSliderControl(flowGrid, bindings.params, {
    key: 'motionSpeed',
    label: 'Motion Speed',
    min: 0,
    max: 3,
    step: 0.01,
  });
  createSliderControl(flowGrid, bindings.params, {
    key: 'turbulence',
    label: 'Turbulence',
    min: 0,
    max: 1.5,
    step: 0.01,
  });
  createSliderControl(flowGrid, bindings.params, {
    key: 'edgeLock',
    label: 'Edge Lock',
    min: 0,
    max: 1.2,
    step: 0.01,
  });
  createSliderControl(textureGrid, bindings.params, {
    key: 'maskFeather',
    label: 'Mask Feather',
    min: 0,
    max: 1,
    step: 0.01,
  });
  createSliderControl(textureGrid, bindings.params, {
    key: 'textureScale',
    label: 'Texture Scale',
    min: 0,
    max: 1.4,
    step: 0.01,
  });
  createSliderControl(textureGrid, bindings.params, {
    key: 'grainAmount',
    label: 'Grain',
    min: 0,
    max: 1,
    step: 0.01,
  });
  createSliderControl(textureGrid, bindings.params, {
    key: 'chromaAberration',
    label: 'Chroma Shift',
    min: 0,
    max: 1,
    step: 0.01,
  });

  const activeRegionRow = createNode('label', 'control-row');
  const activeRegionLabel = createNode('span', 'control-label', 'Active Region');
  const activeRegionRange = document.createElement('input');
  activeRegionRange.type = 'range';
  activeRegionRange.min = '-1';
  activeRegionRange.max = '0';
  activeRegionRange.step = '1';
  activeRegionRange.className = 'control-range';

  const activeRegionNumber = document.createElement('input');
  activeRegionNumber.type = 'number';
  activeRegionNumber.min = '-1';
  activeRegionNumber.max = '0';
  activeRegionNumber.step = '1';
  activeRegionNumber.className = 'control-number';

  activeRegionRow.appendChild(activeRegionLabel);
  activeRegionRow.appendChild(activeRegionRange);
  activeRegionRow.appendChild(activeRegionNumber);
  textureGrid.appendChild(activeRegionRow);

  let regionPreviousBundle: ParamBundle | null = null;
  const beginRegionEdit = (): void => {
    if (!regionPreviousBundle) {
      regionPreviousBundle = createBundle();
    }
  };
  const commitRegionEdit = (): void => {
    if (!regionPreviousBundle) {
      return;
    }
    pushRollback(regionPreviousBundle);
    regionPreviousBundle = null;
  };

  const syncRegionValue = (): void => {
    const maxRegion = Math.max(0, bindings.getRegionCount() - 1);
    activeRegionRange.max = String(maxRegion);
    activeRegionNumber.max = String(maxRegion);
    if (bindings.params.activeRegionId > maxRegion) {
      bindings.params.activeRegionId = -1;
    }
    activeRegionRange.value = String(bindings.params.activeRegionId);
    activeRegionNumber.value = String(bindings.params.activeRegionId);
    regionCountNode.textContent = String(maxRegion + 1);
  };

  activeRegionRange.addEventListener('pointerdown', beginRegionEdit);
  activeRegionRange.addEventListener('focus', beginRegionEdit);
  activeRegionRange.addEventListener('input', () => {
    bindings.params.activeRegionId = Math.round(Number(activeRegionRange.value));
    activeRegionNumber.value = String(bindings.params.activeRegionId);
  });
  activeRegionRange.addEventListener('change', commitRegionEdit);
  activeRegionNumber.addEventListener('focus', beginRegionEdit);
  activeRegionNumber.addEventListener('input', () => {
    const next = Math.round(Number(activeRegionNumber.value));
    if (!Number.isFinite(next)) {
      return;
    }
    const maxRegion = Math.max(0, bindings.getRegionCount() - 1);
    bindings.params.activeRegionId = clampNumber(next, -1, maxRegion);
    activeRegionRange.value = String(bindings.params.activeRegionId);
    activeRegionNumber.value = String(bindings.params.activeRegionId);
  });
  activeRegionNumber.addEventListener('change', commitRegionEdit);
  controlSyncers.push(syncRegionValue);

  showFlowArrowsInput.addEventListener('change', () => {
    const previous = createBundle();
    bindings.debug.showFlowArrows = showFlowArrowsInput.checked;
    pushRollback(previous);
  });
  controlSyncers.push(() => {
    showFlowArrowsInput.checked = bindings.debug.showFlowArrows;
  });

  const debugButtons = new Map<DebugView, HTMLButtonElement>();
  DEBUG_OPTIONS.forEach((option) => {
    const button = createNode('button', 'debug-pill', option.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (bindings.debug.view === option.value) {
        return;
      }
      const previous = createBundle();
      bindings.debug.view = option.value;
      pushRollback(previous);
      syncDebugButtons();
    });
    debugButtons.set(option.value, button);
    debugViewButtonsNode.appendChild(button);
  });

  function syncDebugButtons(): void {
    debugButtons.forEach((button, value) => {
      button.classList.toggle('is-active', value === bindings.debug.view);
    });
  }
  controlSyncers.push(syncDebugButtons);

  function createSnapshot(name: string): SavedSnapshot {
    return {
      id: `snapshot-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      name,
      createdAt: new Date().toISOString(),
      bundle: createBundle(),
    };
  }

  function findSelectedSnapshot(): SavedSnapshot | null {
    const targetId = snapshotList.value;
    if (!targetId) {
      return null;
    }
    return snapshots.find((snapshot) => snapshot.id === targetId) ?? null;
  }

  function upsertSnapshot(snapshot: SavedSnapshot): void {
    snapshots.unshift(snapshot);
    if (snapshots.length > 24) {
      snapshots.pop();
    }
    renderSnapshotList();
    snapshotList.value = snapshot.id;
  }

  async function applyInputPackage(nextInput: ArtInputPackage): Promise<void> {
    currentInput = cloneInputPackage(nextInput);
    await bindings.onApplyInputPackage(currentInput);
    refreshRegionRange();
    setMapsDirty(false);
    updateInputSummary();
  }

  async function loadManifestRecord(payload: unknown, baseUrl: string): Promise<ArtInputPackage> {
    const nextPackage = parsePreprocessManifest(payload, baseUrl);
    if (nextPackage.maskPackUrl) {
      nextPackage.maskPackUrl = await normalizeMaskPackUrl(nextPackage.maskPackUrl);
    }
    return nextPackage;
  }

  async function normalizeMaskPackUrl(maskPackUrl: string): Promise<string> {
    try {
      const response = await fetch(maskPackUrl);
      if (!response.ok) {
        return maskPackUrl;
      }
      const payload = (await response.json()) as unknown;
      if (!isRecord(payload)) {
        return maskPackUrl;
      }

      const parsed = parseMaskPackManifest(payload, maskPackUrl);
      const normalizedPack: Record<string, unknown> = {
        version: parsed.version,
      };
      if (parsed.regionMaskUrl) {
        normalizedPack.regionMaskUrl = parsed.regionMaskUrl;
        normalizedPack.regionMask = parsed.regionMaskUrl;
      }
      if (parsed.edgeMaskUrl) {
        normalizedPack.edgeMaskUrl = parsed.edgeMaskUrl;
        normalizedPack.edgeMask = parsed.edgeMaskUrl;
      }
      if (parsed.confidenceUrl) {
        normalizedPack.confidenceUrl = parsed.confidenceUrl;
        normalizedPack.confidenceMask = parsed.confidenceUrl;
      }
      if (typeof parsed.regionCount === 'number') {
        normalizedPack.regionCount = parsed.regionCount;
      }
      if (parsed.encoding) {
        normalizedPack.encoding = parsed.encoding;
      }

      const blob = new Blob([JSON.stringify(normalizedPack, null, 2)], { type: 'application/json' });
      const blobUrl = URL.createObjectURL(blob);
      objectUrls.add(blobUrl);
      return blobUrl;
    } catch {
      return maskPackUrl;
    }
  }

  async function parseSnapshotFile(file: File): Promise<SavedSnapshot> {
    const text = await file.text();
    let payload: SnapshotFilePayload;
    try {
      payload = JSON.parse(text) as SnapshotFilePayload;
    } catch {
      throw new Error('Invalid JSON file.');
    }

    const source = isRecord(payload.snapshot) ? payload.snapshot : payload;
    const params = parseEngineParams(source.params);
    if (!params) {
      throw new Error('Snapshot missing required params.');
    }

    const snapshotSegmentation = parseSegmentation(source.segmentation) ?? cloneSegmentation(bindings.segmentation);
    const snapshotDebug = parseDebug(source.debug) ?? cloneDebug(bindings.debug);
    const snapshotName = typeof source.name === 'string' && source.name.trim().length > 0 ? source.name : file.name;
    const snapshotCreatedAt =
      typeof source.createdAt === 'string' && source.createdAt.length > 0 ? source.createdAt : new Date().toISOString();

    return {
      id: `snapshot-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      name: snapshotName,
      createdAt: snapshotCreatedAt,
      bundle: {
        params,
        segmentation: snapshotSegmentation,
        debug: snapshotDebug,
      },
    };
  }

  applySampleButton.addEventListener('click', () => {
    const nextSample = bindings.sampleInputs[sampleSelect.value];
    if (!nextSample) {
      setStatus('error', 'Sample input not found.');
      return;
    }

    void runTask('Apply sample input', async () => {
      const nextPackage: ArtInputPackage = {
        baseImageUrl: nextSample,
        meta: {
          source: sampleSelect.value,
          title: currentInput.meta?.title ?? 'Sample Input',
        },
      };
      await applyInputPackage(nextPackage);
    });
  });

  localImageInput.addEventListener('change', () => {
    const file = localImageInput.files?.[0];
    if (!file) {
      return;
    }

    void runTask('Load local image', async () => {
      if (uploadedImageUrl) {
        URL.revokeObjectURL(uploadedImageUrl);
        objectUrls.delete(uploadedImageUrl);
      }
      uploadedImageUrl = URL.createObjectURL(file);
      objectUrls.add(uploadedImageUrl);

      const nextPackage: ArtInputPackage = {
        baseImageUrl: uploadedImageUrl,
        meta: { source: file.name, title: currentInput.meta?.title ?? 'Local Image' },
      };
      await applyInputPackage(nextPackage);
      localImageInput.value = '';
    });
  });

  loadManifestUrlButton.addEventListener('click', () => {
    const target = manifestUrlInput.value.trim();
    if (!target) {
      setStatus('error', 'Manifest URL is empty.');
      return;
    }

    void runTask('Load manifest URL', async () => {
      const absoluteManifestUrl = resolveRelativeUrl(target, window.location.href);
      const response = await fetch(absoluteManifestUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as unknown;
      const nextPackage = await loadManifestRecord(payload, absoluteManifestUrl);
      await applyInputPackage(nextPackage);
    });
  });

  manifestFileInput.addEventListener('change', () => {
    const file = manifestFileInput.files?.[0];
    if (!file) {
      return;
    }

    void runTask('Load manifest file', async () => {
      const payload = JSON.parse(await file.text()) as unknown;
      const nextPackage = await loadManifestRecord(payload, window.location.href);
      if (!nextPackage.meta) {
        nextPackage.meta = {};
      }
      nextPackage.meta.source = nextPackage.meta.source ?? file.name;
      await applyInputPackage(nextPackage);
      manifestFileInput.value = '';
    });
  });

  saveSnapshotButton.addEventListener('click', () => {
    const name = snapshotNameInput.value.trim() || `snapshot-${snapshots.length + 1}`;
    const snapshot = createSnapshot(name);
    upsertSnapshot(snapshot);
    snapshotNameInput.value = '';
    setStatus('success', `Snapshot "${snapshot.name}" saved.`);
  });

  exportCurrentButton.addEventListener('click', () => {
    const payload = {
      kind: 'local-flow-params-snapshot',
      version: 1,
      name: snapshotNameInput.value.trim() || 'custom-export',
      createdAt: new Date().toISOString(),
      params: cloneEngineParams(bindings.params),
      segmentation: cloneSegmentation(bindings.segmentation),
      debug: cloneDebug(bindings.debug),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${payload.name}.json`;
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      objectUrls.delete(url);
    }, 0);
    setStatus('success', 'Current parameters exported.');
  });

  importSnapshotFileInput.addEventListener('change', () => {
    const file = importSnapshotFileInput.files?.[0];
    if (!file) {
      return;
    }

    void runTask('Import snapshot', async () => {
      const snapshot = await parseSnapshotFile(file);
      upsertSnapshot(snapshot);
      await applyBundle(snapshot.bundle, {
        label: `Snapshot ${snapshot.name}`,
      });
      importSnapshotFileInput.value = '';
    });
  });

  applySnapshotButton.addEventListener('click', () => {
    const selected = findSelectedSnapshot();
    if (!selected) {
      setStatus('error', 'No snapshot selected.');
      return;
    }

    void runTask(`Apply snapshot "${selected.name}"`, async () => {
      await applyBundle(selected.bundle, { label: selected.name });
    });
  });

  deleteSnapshotButton.addEventListener('click', () => {
    const selected = findSelectedSnapshot();
    if (!selected) {
      setStatus('error', 'No snapshot selected.');
      return;
    }
    const index = snapshots.findIndex((snapshot) => snapshot.id === selected.id);
    if (index >= 0) {
      snapshots.splice(index, 1);
    }
    renderSnapshotList();
    setStatus('success', `Snapshot "${selected.name}" deleted.`);
  });

  rollbackButton.addEventListener('click', () => {
    const previous = rollbackStack.pop();
    rollbackButton.disabled = rollbackStack.length === 0;
    if (!previous) {
      setStatus('error', 'No rollback history.');
      return;
    }

    void runTask('Rollback', async () => {
      await applyBundle(previous, { label: 'Rollback', withRollback: false });
    });
  });

  setAButton.addEventListener('click', () => {
    slotA = createSnapshot(snapshotNameInput.value.trim() || 'Slot A');
    updateABLabels();
    setStatus('success', 'Captured current state into Slot A.');
  });

  setBButton.addEventListener('click', () => {
    slotB = createSnapshot(snapshotNameInput.value.trim() || 'Slot B');
    updateABLabels();
    setStatus('success', 'Captured current state into Slot B.');
  });

  applyAButton.addEventListener('click', () => {
    const target = slotA;
    if (!target) {
      setStatus('error', 'Slot A is empty.');
      return;
    }
    void runTask('Apply Slot A', async () => {
      await applyBundle(target.bundle, { label: 'Slot A' });
      lastAppliedSlot = 'A';
    });
  });

  applyBButton.addEventListener('click', () => {
    const target = slotB;
    if (!target) {
      setStatus('error', 'Slot B is empty.');
      return;
    }
    void runTask('Apply Slot B', async () => {
      await applyBundle(target.bundle, { label: 'Slot B' });
      lastAppliedSlot = 'B';
    });
  });

  toggleABButton.addEventListener('click', () => {
    if (!slotA || !slotB) {
      setStatus('error', 'Need both Slot A and Slot B for toggle.');
      return;
    }
    const targetSlot = lastAppliedSlot === 'A' ? slotB : slotA;
    const targetName = lastAppliedSlot === 'A' ? 'Slot B' : 'Slot A';
    void runTask(`Toggle ${targetName}`, async () => {
      await applyBundle(targetSlot.bundle, { label: targetName });
      lastAppliedSlot = lastAppliedSlot === 'A' ? 'B' : 'A';
    });
  });

  recomputeVisionButton.addEventListener('click', () => {
    void runTask('Recompute maps', async () => {
      await bindings.onRecomputeVision();
      refreshRegionRange();
      setMapsDirty(false);
    });
  });

  resetFlowButton.addEventListener('click', () => {
    bindings.onResetFlow();
    setStatus('success', 'Flow buffer reset.');
  });

  rollbackButton.disabled = true;
  renderSnapshotList();
  updateABLabels();
  syncAllControls();
  updateInputSummary();
  refreshRegionRange();
  setStatus('idle', 'Ready.');

  function refreshRegionRange(): void {
    syncRegionValue();
  }

  return {
    refreshRegionRange,
    applyPreset: async (preset: Preset) => {
      const parsedParams = parseEngineParams(preset.params);
      if (!parsedParams) {
        setStatus('error', 'Preset payload is invalid.');
        return;
      }
      const nextBundle: ParamBundle = {
        params: parsedParams,
        segmentation: cloneSegmentation(bindings.segmentation),
        debug: cloneDebug(bindings.debug),
      };
      await runTask(`Apply preset "${preset.name}"`, async () => {
        await applyBundle(nextBundle, { label: preset.name });
      });
    },
    setStatus,
    dispose: () => {
      disposed = true;
      if (uploadedImageUrl) {
        URL.revokeObjectURL(uploadedImageUrl);
        objectUrls.delete(uploadedImageUrl);
      }
      objectUrls.forEach((url) => {
        URL.revokeObjectURL(url);
      });
      objectUrls.clear();
    },
  };
}

function createNode<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  textContent?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (textContent) {
    node.textContent = textContent;
  }
  return node;
}

function getNode<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector(selector);
  if (!node) {
    throw new Error(`Panel node missing: ${selector}`);
  }
  return node as T;
}

function countStepDecimals(step: number): number {
  const normalized = step.toString();
  const index = normalized.indexOf('.');
  return index >= 0 ? normalized.length - index - 1 : 0;
}

function formatNumber(value: number, precision: number): string {
  if (precision <= 0) {
    return String(Math.round(value));
  }
  return value.toFixed(precision);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function compactValue(value: string): string {
  if (value.length <= 54) {
    return value;
  }
  return `${value.slice(0, 20)}...${value.slice(-30)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveRelativeUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseEngineParams(candidate: unknown): EngineParams | null {
  if (!isRecord(candidate)) {
    return null;
  }
  const keys: Array<keyof EngineParams> = [
    'seed',
    'motionSpeed',
    'turbulence',
    'edgeLock',
    'maskFeather',
    'textureScale',
    'grainAmount',
    'chromaAberration',
    'activeRegionId',
  ];

  const parsed: Partial<EngineParams> = {};
  for (const key of keys) {
    const value = candidate[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    parsed[key] = value;
  }

  return {
    seed: Math.round(parsed.seed as number),
    motionSpeed: parsed.motionSpeed as number,
    turbulence: parsed.turbulence as number,
    edgeLock: parsed.edgeLock as number,
    maskFeather: parsed.maskFeather as number,
    textureScale: parsed.textureScale as number,
    grainAmount: parsed.grainAmount as number,
    chromaAberration: parsed.chromaAberration as number,
    activeRegionId: Math.round(parsed.activeRegionId as number),
  };
}

function parseSegmentation(candidate: unknown): SegmentationConfig | null {
  if (!isRecord(candidate)) {
    return null;
  }
  if (
    typeof candidate.clusters !== 'number' ||
    typeof candidate.edgeThreshold !== 'number' ||
    typeof candidate.edgeDilate !== 'number' ||
    typeof candidate.flowSmoothing !== 'number'
  ) {
    return null;
  }
  return {
    clusters: Math.round(candidate.clusters),
    edgeThreshold: candidate.edgeThreshold,
    edgeDilate: Math.round(candidate.edgeDilate),
    flowSmoothing: Math.round(candidate.flowSmoothing),
  };
}

function parseDebug(candidate: unknown): DebugConfig | null {
  if (!isRecord(candidate)) {
    return null;
  }
  if (
    !isDebugView(candidate.view) ||
    typeof candidate.showFlowArrows !== 'boolean'
  ) {
    return null;
  }
  return {
    view: candidate.view,
    showFlowArrows: candidate.showFlowArrows,
  };
}

function isDebugView(value: unknown): value is DebugView {
  return (
    value === 'final' ||
    value === 'regionMask' ||
    value === 'edgeMask' ||
    value === 'flow' ||
    value === 'confidence' ||
    value === 'leakage'
  );
}

function cloneEngineParams(params: EngineParams): EngineParams {
  return {
    seed: params.seed,
    motionSpeed: params.motionSpeed,
    turbulence: params.turbulence,
    edgeLock: params.edgeLock,
    maskFeather: params.maskFeather,
    textureScale: params.textureScale,
    grainAmount: params.grainAmount,
    chromaAberration: params.chromaAberration,
    activeRegionId: params.activeRegionId,
  };
}

function cloneSegmentation(segmentation: SegmentationConfig): SegmentationConfig {
  return {
    clusters: segmentation.clusters,
    edgeThreshold: segmentation.edgeThreshold,
    edgeDilate: segmentation.edgeDilate,
    flowSmoothing: segmentation.flowSmoothing,
  };
}

function cloneDebug(debug: DebugConfig): DebugConfig {
  return {
    view: debug.view,
    showFlowArrows: debug.showFlowArrows,
  };
}

function cloneInputPackage(source: ArtInputPackage): ArtInputPackage {
  const next: ArtInputPackage = {
    baseImageUrl: source.baseImageUrl,
  };
  if (source.maskPackUrl) {
    next.maskPackUrl = source.maskPackUrl;
  }
  if (source.flowHintUrl) {
    next.flowHintUrl = source.flowHintUrl;
  }
  if (source.meta) {
    next.meta = { ...source.meta };
  }
  return next;
}
