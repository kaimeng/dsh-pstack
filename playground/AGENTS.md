# Playground 入口

本文件描述 playground 的环境、流程概览和硬约束。

## 环境

- 使用真实 DSH Web 会话，Linux 与 macOS 是 playground worker 运行时支持的平台；其他平台先运行 `playground:doctor` 确认。
- 每个 worker 使用独立 home、浏览器 profile、证据目录和隔离工作区；worker 不携带 Git/GitHub 凭证。
- 真实模型选择由用户确认；RunRecord 记录实际路由、DSH 版本、上游 revision 和配置 hash。
- `raw/base` 观察原生 DSH；`raw/<capability-environment>` 只作为可选能力对照；`adapted` 验证适配实现。

## 文档指针

| 文档 | 职责 |
| --- | --- |
| [docs/raw-probes.md](./docs/raw-probes.md) | raw 能力用例提取规则、probe 契约、inventory 和排除规则 |
| [docs/raw.md](./docs/raw.md) | raw 目录文件职责、生成器和 dsh.md/dsh.zh.md/dsh-evidence 边界 |
| [docs/adapted.md](./docs/adapted.md) | adapted 适配验证规则、环境矩阵和特殊环境处理 |
| [docs/workflow.md](./docs/workflow.md) | 阶段、命令、批次、交接条件和增量流程 |
| [docs/worker.md](./docs/worker.md) | worker 隔离、prepare/bootstrap/run/stop 和就绪缓存 |
| [docs/evidence-analysis.md](./docs/evidence-analysis.md) | 证据分析输入、输出、阶段隔离和 index 格式 |
| [docs/evidence-redaction.md](./docs/evidence-redaction.md) | 证据脱敏和提交门 |

## 流程概览

1. 生成 raw 树，准备 `raw` worker。
2. 运行 raw probe，collect，生成 raw 分析。
3. 根据 raw 分析更新当前阶段的 dsh.md、适配代码和生成树，build 后运行 adapted。
4. 运行 adapted probe，collect 并分析。
5. 通过后更新 README/兼容表并停在 release-ready；特殊环境只在用户明确指定时运行。

具体命令、阶段入口和交接条件见 [docs/workflow.md](./docs/workflow.md)。

## 硬约束

- 阶段隔离按 [docs/raw-probes.md](./docs/raw-probes.md) 和 [docs/evidence-analysis.md](./docs/evidence-analysis.md) 执行。
- `prepare → bootstrap → run-batch → collect` 必须在同一个长期存活的 background job 中串行执行，shell 保持到 collect 结束。
- dsh.md 的分离、修改和描述边界见 [docs/workflow.md](./docs/workflow.md#dshmd)。
- `scripts/generate-pstack.mjs --target port|raw` 是唯一生成器。
