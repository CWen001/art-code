# 分布式开发总计划（Session 1 主控版）

## 1. 目标与边界
本阶段只做“组织与计划定版”，不继续扩展实现细节。

统一目标：构建一条可复用生产链路。
1. 用户上传照片/插画。
2. 预处理将输入转换为适合生成式运动的艺术底图与结构化控制图。
3. 运动引擎渲染局部受限流动。

当前仓库已完成第 3 步首版引擎；本计划聚焦并行推进第 2 步与前端工作流。

## 2. 会话角色重定义

## Session 1（主会话）
定位：架构 owner + 集成 owner。
职责：
1. 冻结接口契约与版本规则。
2. 管理合并节奏与冲突裁决。
3. 持续优化核心引擎（leakage、性能、稳定性）。
4. 验收 Session 2/3 交付并发布里程碑。

代码所有权：
- `src/engine/**`
- `src/vision/**`
- `src/types.ts`
- `scripts/validate_*.mjs`

## Session 2（前端与交互）
定位：使用层与操控层。
职责：
1. 重构 UI 信息架构。
2. 参数工作流（保存、加载、A/B 对比、回滚）。
3. 输入管理流程（图片选择、预处理产物选择、状态反馈）。
4. Debug 视图入口与交互一致性。

代码所有权：
- `src/ui/**`
- `src/style.css`
- `src/main.ts`（装配层）

## Session 3（广义预处理）
定位：数据准备与素材工程。
职责：
1. 接收用户上传照片/插画。
2. 用 Nano Banana + Gemini 做风格化与结构增强。
3. 输出适配引擎的标准包（`base + maskPack + flowHint`）。
4. SVG 作为可选路径：只在有收益时启用，不强制。

代码所有权（建议新增）：
- `preprocess/**`
- `scripts/preprocess_*.mjs`
- `docs/preprocess_pipeline.md`

## 3. Session 3 的技术定位（核心）
Session 3 不是“只做 SVG”，而是“预处理总线”。

推荐采用双路径：
1. Raster-first（默认）
- 照片 -> 风格化底图 -> 分区/边缘/流向提取 -> 标准包。
- 优势：保留纹理细节，鲁棒性高。

2. SVG-optional（可选增强）
- 当图像具有清晰几何结构时，附加 SVG 抽象路径。
- 仅将 SVG 结果用于增强 mask/edge，不替代全部底图。

结论：SVG 是增强器，不是主干依赖。

## 4. 跨会话接口契约（冻结）

## 4.1 引擎输入契约（不得破坏）
`src/types.ts` 中保持：
1. `ArtInputPackage.baseImageUrl`
2. `ArtInputPackage.maskPackUrl?`
3. `ArtInputPackage.flowHintUrl?`

## 4.2 预处理标准输出（Session 3 必须产出）
建议统一目录结构：
1. `outputs/<job_id>/base.png`
2. `outputs/<job_id>/mask_region.png`
3. `outputs/<job_id>/mask_edge.png`
4. `outputs/<job_id>/mask_confidence.png`
5. `outputs/<job_id>/flow_hint.png`
6. `outputs/<job_id>/manifest.json`

`manifest.json` 建议字段：
1. `version`
2. `source`
3. `createdAt`
4. `baseImageUrl`
5. `maskPackUrl`
6. `flowHintUrl`
7. `meta`（模型、参数、是否启用 SVG）

## 4.3 Session 2 调用方式（固定）
Session 2 不读取预处理内部步骤，只消费 `manifest.json`。

## 5. 开发顺序与并行关系

阶段 A（并行启动）
1. Session 1：锁接口，出验收口径。
2. Session 2：做完整交互框架与状态管理。
3. Session 3：做预处理 CLI 与产物规范。

阶段 B（第一次集成）
1. 先合并 Session 3 到 Session 1 集成分支。
2. Session 1 完成引擎接入回归。
3. 再合并 Session 2，打通前端完整链路。

阶段 C（验收）
1. 三张基准图回归。
2. leakage、fps、主观视觉一致性联合评估。

## 6. 分支与提交流程
建议分支：
1. `codex/session1-core`
2. `codex/session2-frontend`
3. `codex/session3-preprocess`
4. `codex/integration-v1`（由 Session 1 维护）

合并规则：
1. 子会话只向 `integration-v1` 提 PR。
2. 任何契约改动必须先经 Session 1 批准。
3. 破坏性改动必须附迁移说明。

## 7. 验收标准（当前阶段）

系统级验收：
1. `npm run build` 通过。
2. 前端可加载预处理产物并驱动引擎。
3. 无预处理产物时可回退到原有默认样本。

指标验收：
1. `validate:fps` 可执行并输出明确信息。
2. `validate:leakage` 可对产物进行评估。
3. 每次 PR 附 1 份结果摘要。

## 8. 风险与约束
1. 预处理质量波动会直接影响引擎效果。
2. 强制 SVG 可能造成纹理损失。
3. 模型输出不稳定时要保留 deterministic fallback。
4. API key 仅从本地 `.env` 读取，不写入仓库。

## 9. 可直接发给子会话的启动指令

Session 2 启动指令：
你负责前端与交互层。不要改 `src/engine/**` 和 `src/types.ts`。目标是让用户可选择输入图、加载预处理 manifest、调参、切换 debug 视图并保存参数快照。

Session 3 启动指令：
你负责广义预处理。目标是“照片/插画 -> 风格化底图 -> 结构化控制图 -> manifest 标准包”。技术上使用 Nano Banana + Gemini，SVG 为可选增强路径。不得修改引擎核心，只输出可被 `ArtInputPackage` 消费的产物。

## 10. Session 1 下一步动作清单
1. 在 `main` 上确认该计划为当前唯一执行版本。
2. 创建三个工作分支。
3. 下发 Session 2/3 启动指令。
4. 设置首次集成时间点并锁定验收模板。

## 11. 当前集成状态（2026-02-20）
已完成：
1. Session 2：`src/ui/panel.ts`、`src/main.ts`、`src/style.css` 的交互重构已落地（输入管理、快照、A/B、rollback、debug 快捷入口）。
2. Session 3：`preprocess/**` 与 `scripts/preprocess_*.mjs` 已落地，支持 `manifest.json` 标准包输出、远程模型可选与 deterministic fallback、SVG optional。
3. Session 1：引擎已接入 `mask_pack` 契约解析（新旧字段兼容），并修复 flow hint magnitude 贴图来源。
4. 集成兼容修复：前端 manifest/mask 解析已切换到统一契约解析模块，避免新字段被降级为空包。

已验证：
1. `npm run build` 通过。
2. `npm run preprocess:run -- --input ref/pics/sample_input_a.jpeg --use-remote-models false --enable-svg true --job-id session1_integration_a` 通过。
3. `npm run preprocess:validate -- --manifest outputs/session1_integration_a/manifest.json` 通过。
4. `npm run preprocess:run -- --input ref/pics/sample_input_b.jpeg --enable-svg true --job-id session1_integration_b` 通过（无 key 场景自动 fallback）。
5. `npm run preprocess:validate -- --manifest outputs/session1_integration_b/manifest.json` 通过。

说明：
1. `validate:fps` 与 `validate:leakage` 当前脚本对“参考视频素材”做统计，不代表引擎实时渲染指标，且默认参考素材分别为 24fps 与高泄漏比，不宜作为集成阻断项。
