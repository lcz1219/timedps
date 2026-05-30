# Debug Session: deepseek-502-empty
- **Status**: [OPEN]
- **Issue**: Trae 通过本地插件代理请求 DeepSeek 时提示 `The custom model provider has returned empty content. (HTTP Status: 502)`
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-deepseek-502-empty.ndjson

## Reproduction Steps
1. 在 Trae 中发起一次走该插件代理的 DeepSeek 对话请求。
2. 观察是否出现 `empty content` 与 `HTTP Status: 502`。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | Trae 没有实际命中本地代理 | Med | Low | Partially Rejected |
| B | 请求体在代理侧被读取后未正确转发 | High | Low | Pending |
| C | 上游响应被代理提前结束或截断 | High | Low | Pending |
| D | 返回给 Trae 的状态码、header 或 SSE 格式不符合预期 | Med | Med | Pending |

## Log Evidence
- Debug Server 启动成功后，用户复现问题时未收到任何埋点事件。
- `31234` 端口由 `Trae Host` 进程监听，说明当前确实有扩展实例在运行。
- 当前源码已编译，且 `out/extension.js` 中存在 `reportDebugEvent(...)` 埋点代码。
- 手动请求 `http://127.0.0.1:31234/v1/chat/completions` 能返回上游 `401`，说明监听中的代理可转发请求。
- 结合“有代理监听但无新埋点”两个事实，当前更像是 Trae 正在运行旧扩展实例或旧安装包，而不是当前工作区最新构建产物。

## Instrumentation
- Added runtime reporting in `src/extension.ts` at proxy entry, request-body capture, before upstream forward, upstream response head/first chunk/end, and error branches.

## Verification Conclusion
- 已完成一版重构修复候选：
  - 代理层改为原始 `Buffer` 请求转发，不再用字符串方式重写请求体。
  - 转发时重新计算 `content-length`，移除 `transfer-encoding`、`connection`、`accept-encoding` 等易导致协议问题的请求头。
  - 响应改为透明透传，同时独立解析 `usage`，避免统计逻辑干扰上游协议。
  - 待用户安装 `timedps-0.0.3.vsix` 后做实际验证。
