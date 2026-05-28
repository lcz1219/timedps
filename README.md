# AI Usage Tracker (VS Code / Trae 插件)

这个插件通过在本地启动一个轻量级的 HTTP 代理服务器，拦截并转发对第三方大模型 API (如 DeepSeek) 的请求，从而实时统计和展示 Token 消耗和预估费用。

## 如何使用

1. **安装并启用插件**：在 Trae 或 VS Code 中加载本插件。
2. **状态栏查看**：在编辑器右下角的的状态栏中，你会看到一个类似于 `$(pulse) 0 Tokens ($0.0000)` 的显示。
3. **配置 Trae API**：
   - 打开 Trae 的设置页面（Settings）。
   - 找到第三方模型（如 DeepSeek）的配置项。
   - 将 **API Base URL** (或类似的端点配置) 修改为本地代理地址，默认是：`http://localhost:31234` (如果是完整的路径，可能是 `http://localhost:31234/v1` 等，根据你的实际请求路径补充)。
4. **测试对话**：
   - 现在你可以在 Trae 中与 AI 进行对话，所有的请求都会通过本地的 31234 端口。
   - 每次对话结束后，插件会从返回的响应流 (SSE) 或普通 JSON 中解析出 `usage.total_tokens`，并实时累加显示在状态栏中。

## 插件配置项 (Settings)

你可以在编辑器的设置中 (Search: `aiUsageTracker`) 修改以下配置：
- `aiUsageTracker.proxyPort`: 本地代理服务监听的端口号，默认 `31234`。
- `aiUsageTracker.targetApiUrl`: 真实要转发过去的目标 API 基础地址，默认 `https://api.deepseek.com`。如果你使用其他服务商，请修改为对应的地址。

## 插件命令 (Commands)

按下 `Cmd + Shift + P` (Mac) 或 `Ctrl + Shift + P` (Win) 打开命令面板，输入 `AI Usage` 可以找到以下命令：
- **AI Usage: Show Details**：弹出弹窗查看当前的 Token 总消耗和预估金额。
- **AI Usage: Reset Usage**：将当前的消耗记录重置为 0。

## 备注
该插件会将历史记录保存在 VS Code/Trae 的 `globalState` 本地存储中，关闭编辑器不会丢失数据。
