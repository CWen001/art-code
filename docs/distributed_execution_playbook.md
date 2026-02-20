# 分布式开发执行手册（Session 1 主会话）

## 1. 目的
本手册用于把当前项目拆成 3 条可并行推进的开发线。
Session 1 作为主会话负责架构和集成，Session 2 与 Session 3 负责相对独立的前端与工具链工作，最终由 Session 1 统一验收与合并。

## 2. 当前基线
当前已具备可运行首版，关键文件如下。
- `src/engine/renderer.ts`
- `src/engine/passes/maskFlowPass.frag`
- `src/engine/passes/compositePass.frag`
- `src/vision/maskExtractor.ts`
- `src/vision/edgeExtractor.ts`
- `src/vision/flowHint.ts`
- `src/ui/panel.ts`
- `src/main.ts`
- `docs/methodology.md`
- `scripts/validate_leakage.mjs`
- `scripts/validate_fps.mjs`

## 3. 冻结接口（并行开发必须遵守）
### 3.1 类型契约（冻结）
以 `src/types.ts` 为单一真源。
- `ArtInputPackage`
- `EngineParams`
- `SegmentationConfig`
- `DebugConfig`
- `Preset`

原则：Session 2 和 Session 3 不得直接修改这些类型定义。若必须调整，先提交 RFC 给 Session 1。

### 3.2 Renderer 对外契约（冻结）
由 `src/engine/renderer.ts` 提供并保持向后兼容。
- `initialize(): Promise<void>`
- `draw(): void`
- `reloadInput(nextInput: ArtInputPackage): Promise<void>`
- `recomputeVision(): Promise<void>`
- `resetFlow(): void`
- `getRegionCount(): number`
- `getMetrics(): { fps: number; leakageRatio: number }`
- `destroy(): void`

原则：Session 2 和 Session 3 只能通过以上接口调用引擎，不直接读写 shader uniform。

### 3.3 预设契约（冻结）
`src/presets/*.json` 使用如下结构。
- `name: string`
- `params: EngineParams`

## 4. 三会话任务拆分

## Session 1（主会话，核心引擎与集成）
### 目标
压低 leakage、稳定性能、定义集成协议、做最终验收。

### 负责范围
- 引擎内核和视觉解析。
- shader 策略优化。
- 对外接口与版本控制。
- 跨会话冲突解决。

### 文件所有权
- `src/engine/**`
- `src/vision/**`
- `src/types.ts`
- `scripts/validate_*.mjs`

### 本阶段任务
1. leakage 收敛工程。
2. `maskPack` 正式 schema 设计与导入逻辑。
3. 720p 目标性能优化。
4. 合并 Session 2/3 后回归测试。

### 验收标准
1. 在默认样本下，leakage 明显下降并可稳定复现。
2. `npm run build` 必须通过。
3. 不破坏 Session 2/3 对外接口调用。

## Session 2（前端交互工作流）
### 目标
把当前控制台升级成可生产使用的交互面板与输入流程。

### 负责范围
- 信息架构与交互流程。
- 参数管理、预设管理、输入资源管理。
- 响应式布局和 UI 质量。

### 文件所有权
- `src/ui/**`
- `src/style.css`
- `src/main.ts`（仅限 UI 装配层）
- 可新增 `src/ui/components/**`

### 本阶段任务
1. 面板重构为 3 个区块。
2. 参数快照系统。
3. 输入管理器。
4. 一键 reset/recompute/benchmark 入口。
5. 移动端和小屏适配。

### 验收标准
1. UI 可在不改引擎源码的前提下完成完整操作链路。
2. 参数修改即时生效，且不出现卡死或闪烁。
3. 关键路径支持键盘和按钮双操作。

## Session 3（前端可视化与 QA 工具）
### 目标
建立调试可视化、录制导出、质量评估工具链。

### 负责范围
- Debug overlay 和诊断面板。
- 采样与日志导出。
- 验收脚本与文档增强。

### 文件所有权
- `src/ui/debug*`
- `src/ui/inspect*`
- `scripts/**`
- `docs/**`
- 可新增 `src/utils/metrics.ts`

### 本阶段任务
1. Debug HUD。
2. 流场箭头、leakage 热区、region 对比面板。
3. 浏览器端 10 秒采样报告导出。
4. 脚本升级。
5. QA 操作文档。

### 验收标准
1. 能导出一次完整测试报告。
2. 指标与脚本口径一致。
3. 不修改引擎核心渲染代码。

## 5. 并行协作协议
### 5.1 分支策略
- Session 1: `codex/session1-core`
- Session 2: `codex/session2-ui`
- Session 3: `codex/session3-tools`

### 5.2 合并顺序
1. Session 1 先发布基线标记 `baseline-v1`。
2. Session 2 和 Session 3 基于同一基线并行开发。
3. Session 2 先合并到 Session 1 集成分支。
4. Session 3 再合并并处理冲突。
5. Session 1 做最终调参与回归。

### 5.3 冲突处理优先级
1. 接口契约冲突以 Session 1 为准。
2. UI 结构冲突优先保留 Session 2 的布局，Session 3 适配。
3. 指标口径冲突优先保留 Session 3 的测量逻辑，Session 1 校准阈值。

## 6. 集成检查清单（由 Session 1 执行）
1. `npm install`
2. `npm run build`
3. `npm run dev` 手动回归
4. `npm run validate:fps`
5. `npm run validate:leakage`
6. 三张样本图分别测试并截图归档

## 7. 交付定义（DoD）
满足以下条件才算阶段完成。
1. 三个会话代码已合并。
2. 引擎可稳定运行，UI 完整可用，调试工具可输出报告。
3. 文档覆盖安装、运行、调参、排障、验收。
4. 不含破坏性变更，回退路径明确。

## 8. 可直接发给子会话的启动指令

### 给 Session 2 的启动指令
你负责 `Session 2`，目标是重构前端交互层，不修改引擎核心算法。
只改以下区域：`src/ui/**`, `src/style.css`, `src/main.ts`（装配层）。
必须通过 `Renderer` 公开接口调用，不直接修改 shader。
交付：完整控制面板、参数快照、输入管理、响应式布局。

### 给 Session 3 的启动指令
你负责 `Session 3`，目标是前端调试可视化和 QA 工具链，不修改核心渲染路径。
只改以下区域：`src/ui/debug*`, `scripts/**`, `docs/**`, `src/utils/**`（可新增）。
必须与 `validate_fps`、`validate_leakage` 口径一致。
交付：HUD、热区可视化、采样报告导出、QA 文档。

## 9. 建议里程碑
1. D1-D2: Session 2/3 并行开发，Session 1 做 leakage 优化。
2. D3: 合并 Session 2。
3. D4: 合并 Session 3。
4. D5: Session 1 完成集成调参与最终验收。
