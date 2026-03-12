# Session 3 预处理管线（广义预处理）

本文档定义 Session 3 的标准产物、执行入口与运行策略，目标是将用户上传的照片/插画转换为引擎可消费的标准包。

## 1. 目标

输入：照片或插画。  
输出：`base + maskPack + flowHint` 标准包，满足 `ArtInputPackage` 契约。

固定输出目录结构：

1. `outputs/<job_id>/base.png`
2. `outputs/<job_id>/mask_region.png`
3. `outputs/<job_id>/mask_edge.png`
4. `outputs/<job_id>/mask_confidence.png`
5. `outputs/<job_id>/flow_hint.png`
6. `outputs/<job_id>/mask_pack.json`
7. `outputs/<job_id>/manifest.json`
8. `outputs/<job_id>/structure.svg`（可选，仅启用 SVG 且收益明确时）

## 2. 执行入口

```bash
npm run preprocess:run -- --input <your-image-file>
```

常用参数：

- `--output-root outputs` 输出根目录
- `--job-id custom_id` 自定义 job id
- `--width 1280 --height 1280` 预处理尺寸上限
- `--clusters 10 --edge-threshold 0.18 --edge-dilate 2 --flow-smoothing 2`
- `--enable-svg true|false`
- `--use-remote-models true|false`
- `--style-preset balanced|graphic|texture`
- `--style-prompt "<text>"`
- `--gemini-model <model_id>`

检查产物一致性：

```bash
npm run preprocess:validate -- --manifest outputs/<job_id>/manifest.json
```

## 3. Nano Banana + Gemini 策略

### 3.1 Nano Banana（风格化底图）

- 当 `--use-remote-models=true` 且配置了 `NANO_BANANA_API_URL` 时，调用远程风格化接口。
- 远程不可用时，自动回退到本地 deterministic 风格化算法（颜色重映射 + 对比/饱和 + 量化 + 轻噪声）。
- 回退信息写入 `manifest.meta.model.nanoBanana.reason`。

环境变量：

- `NANO_BANANA_API_URL`
- `NANO_BANANA_API_KEY`（可选，按服务端鉴权方式）
- `NANO_BANANA_MODEL`（可选）

### 3.2 Gemini（结构增强）

- 当 `--use-remote-models=true` 且配置了 `GEMINI_API_KEY`，调用 Gemini 生成结构参数建议：
  - `clusters`
  - `edgeThreshold`
  - `edgeDilate`
  - `flowSmoothing`
  - `enableSvg`
- 远程不可用时，自动回退到本地几何启发式（边缘密度、线性几何偏置、梯度能量）。
- 回退信息写入 `manifest.meta.model.gemini.reason`。

环境变量：

- `GEMINI_API_KEY`
- `GEMINI_MODEL`（可选，默认 `gemini-2.0-flash`）

## 4. SVG-optional 规则

SVG 不是主干依赖，仅在以下条件同时满足时启用：

1. CLI 开启 `--enable-svg=true`
2. 结构阶段判断输入存在明显几何直线收益（模型建议或启发式判断）
3. 实际从边缘图中提取到稳定线段

启用后：

- 产出 `structure.svg`
- 对 `mask_edge.png` 进行额外一次轻度强化（dilate）
- 所有行为在 `manifest.meta.svg` 中记录

## 5. Manifest 契约

`manifest.json` 核心字段：

- `version`
- `source`
- `createdAt`
- `baseImageUrl`（例如 `./base.png`）
- `maskPackUrl`（例如 `./mask_pack.json`）
- `flowHintUrl`（例如 `./flow_hint.png`）
- `meta`（模型模式、参数、SVG 是否启用等）

其中 `mask_pack.json` 提供三张 mask 地址：

- `regionMaskUrl`
- `edgeMaskUrl`
- `confidenceUrl`

契约参考：

- `/Users/cwen/Library/CloudStorage/OneDrive-个人/NEW_DSC/NDS_2026/generative_art/docs/contracts/preprocess_manifest.schema.json`
- `/Users/cwen/Library/CloudStorage/OneDrive-个人/NEW_DSC/NDS_2026/generative_art/docs/contracts/mask_pack.schema.json`

## 6. 与前端/引擎衔接

Session 2/引擎仅需消费 `manifest.json`，不依赖预处理内部步骤。  
当前产物字段已与 `ArtInputPackage` 对齐：

- `baseImageUrl`
- `maskPackUrl`
- `flowHintUrl`
