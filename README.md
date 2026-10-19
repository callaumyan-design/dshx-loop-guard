# dshx-loop-guard

> Detects and stops agent loops — the same tool call returning the same result again and again — mainly for small local models.

防止 agent（主要是本地小模型）陷入「反复调用同一个工具」的死循环。只挂 DSH 公开的 `agent/request`、`tools/pre-execute`、`tools/post-execute` 事件，不改 agent 主循环。

## 判定规则（按 agent、按轮计数）

1. 调用指纹 = 工具名 + 参数（键顺序无关）；
2. 同一调用连续得到**完全相同**的结果：第 `warnAt` 次在结果后附加提醒，第 `stopAt` 次直接拒绝；
3. 同一调用一轮内执行满 `hardLimit` 次（不论结果）后拒绝；
4. 一轮工具调用总数超过 `maxCallsPerTurn` 时拒绝（0 = 不限）；
5. 一轮被拒绝 `maxDenials` 次后中止本轮。

改完文件再跑同一条测试命令不算循环：结果变了，计数就清零。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `providers` | `['local']` | 只对这些 provider 生效；空数组 = 所有模型 |
| `warnAt` | `3` | |
| `stopAt` | `5` | |
| `hardLimit` | `12` | |
| `maxCallsPerTurn` | `0` | |
| `maxDenials` | `3` | |

## 安装

```sh
# Web profile
dsh plugin --profile web add github:callaumyan-design/dshx-loop-guard
# Desktop（用 DSH Desktop 自带的 dsh 命令，先从托盘完全退出 Desktop）
dsh plugin --profile desktop add github:callaumyan-design/dshx-loop-guard
```

安装后重启 DSH。卸载：`dsh plugin --profile <profile> remove dshx-loop-guard`。

## 兼容性

在 DeepSeek Harness 0.2.0-rc.2（desktop / web profile）上开发和使用。纯 JavaScript，无构建步骤，无安装脚本。

## License

MIT
