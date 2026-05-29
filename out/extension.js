"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const httpProxy = require("http-proxy");
const treeProvider_1 = require("./treeProvider");
let proxyServer;
let statusBarItem;
let refreshStatusBarItem;
let outputChannel;
let treeProvider;
let totalTokens = 0;
let totalCost = 0;
let apiKey = '';
let officialBalance = undefined;
let globalStoragePath = '';
// 保存原始的 request 方法
const originalHttpsRequest = https.request;
let currentTurn = null;
let turnFlushTimer = null;
let activeRequests = 0;
function logDebug(msg) {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${msg}`;
    console.log(`[TimedPS Debug] ${logMsg}`);
    if (outputChannel) {
        outputChannel.appendLine(`[Debug] ${logMsg}`);
    }
}
function flushTurn() {
    if (!currentTurn)
        return;
    const timeStr = currentTurn.startTime.toLocaleString();
    outputChannel.appendLine(`==================================================`);
    outputChannel.appendLine(`💬 [${timeStr}] 对话回合 (包含 ${currentTurn.requestCount} 次 API 请求)`);
    if (currentTurn.userPrompt) {
        outputChannel.appendLine(`👤 提问: ${currentTurn.userPrompt}`);
    }
    outputChannel.appendLine(`--------------------------------------------------`);
    outputChannel.appendLine(`📊 Token 消耗明细:`);
    outputChannel.appendLine(`  - 输入 (未命中缓存): ${currentTurn.uncachedPromptTokens.toLocaleString()} tokens`);
    outputChannel.appendLine(`  - 输入 (命中缓存)  : ${currentTurn.cachedTokens.toLocaleString()} tokens`);
    outputChannel.appendLine(`  - 输出 (模型生成)  : ${currentTurn.completionTokens.toLocaleString()} tokens`);
    outputChannel.appendLine(`--------------------------------------------------`);
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const currencySymbol = config.get('currencySymbol', '¥');
    const totalTokens = currentTurn.uncachedPromptTokens + currentTurn.cachedTokens + currentTurn.completionTokens;
    outputChannel.appendLine(`💰 回合总计: ${totalTokens.toLocaleString()} tokens | 预估费用: ${currencySymbol}${currentTurn.totalCost.toFixed(4)}`);
    outputChannel.appendLine(``);
    try {
        const logFile = path.join(globalStoragePath, 'history.jsonl');
        const logEntry = {
            ...currentTurn,
            timeStr: timeStr,
            totalTokens: totalTokens
        };
        fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n', 'utf8');
        if (treeProvider) {
            treeProvider.refresh();
        }
    }
    catch (e) {
        console.error('保存日志失败:', e);
    }
    currentTurn = null;
    if (turnFlushTimer) {
        clearTimeout(turnFlushTimer);
        turnFlushTimer = null;
    }
}
function activate(context) {
    console.log('AI Usage Tracker is now active!');
    globalStoragePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(globalStoragePath)) {
        fs.mkdirSync(globalStoragePath, { recursive: true });
    }
    totalTokens = context.globalState.get('totalTokens', 0);
    totalCost = context.globalState.get('totalCost', 0);
    apiKey = context.globalState.get('apiKey', '');
    officialBalance = context.globalState.get('officialBalance');
    outputChannel = vscode.window.createOutputChannel('AI Usage Log');
    treeProvider = new treeProvider_1.UsageTreeProvider(globalStoragePath);
    vscode.window.registerTreeDataProvider('ai-usage-tracker-tree', treeProvider);
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'ai-usage-tracker.showUsage';
    context.subscriptions.push(statusBarItem);
    refreshStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    refreshStatusBarItem.text = '$(sync)';
    refreshStatusBarItem.tooltip = '手动刷新官方余额';
    refreshStatusBarItem.command = 'ai-usage-tracker.refreshBalance';
    context.subscriptions.push(refreshStatusBarItem);
    updateStatusBar();
    statusBarItem.show();
    refreshStatusBarItem.show();
    const showCmd = vscode.commands.registerCommand('ai-usage-tracker.showUsage', () => {
        outputChannel.show();
        const config = vscode.workspace.getConfiguration('aiUsageTracker');
        const currencySymbol = config.get('currencySymbol', '¥');
        vscode.window.showInformationMessage(`当前本地预估费用为: ${currencySymbol}${totalCost.toFixed(4)}，官方余额为: ${officialBalance !== undefined ? currencySymbol + officialBalance : '未知'}`);
    });
    const resetCmd = vscode.commands.registerCommand('ai-usage-tracker.resetUsage', async () => {
        totalTokens = 0;
        totalCost = 0;
        await context.globalState.update('totalTokens', 0);
        await context.globalState.update('totalCost', 0);
        try {
            const logFile = path.join(globalStoragePath, 'history.jsonl');
            if (fs.existsSync(logFile)) {
                fs.writeFileSync(logFile, '', 'utf8');
            }
        }
        catch (e) { }
        treeProvider.refresh();
        updateStatusBar();
        vscode.window.showInformationMessage('AI Token 消耗及费用记录已重置。');
    });
    const refreshCmd = vscode.commands.registerCommand('ai-usage-tracker.refreshBalance', async () => {
        if (!apiKey) {
            vscode.window.showWarningMessage('尚未拦截到 API Key，请先在 Trae 中与 AI 进行一次对话。');
            return;
        }
        refreshStatusBarItem.text = '$(sync~spin)';
        try {
            const balance = await fetchDeepSeekBalance(apiKey);
            if (balance !== null) {
                officialBalance = balance;
                await context.globalState.update('officialBalance', officialBalance);
                updateStatusBar();
                vscode.window.showInformationMessage(`获取成功！官方可用余额: ${balance}`);
            }
            else {
                vscode.window.showErrorMessage('获取余额失败，可能是 API Key 失效或网络问题。');
            }
        }
        catch (e) {
            vscode.window.showErrorMessage(`获取余额异常: ${e}`);
        }
        finally {
            refreshStatusBarItem.text = '$(sync)';
        }
    });
    const refreshTreeCmd = vscode.commands.registerCommand('ai-usage-tracker.refreshTree', () => {
        treeProvider.refresh();
    });
    const setApiKeyCmd = vscode.commands.registerCommand('ai-usage-tracker.setApiKey', async () => {
        const input = await vscode.window.showInputBox({
            prompt: '请输入你的 DeepSeek API Key (sk-...)',
            placeHolder: 'sk-...',
            value: apiKey
        });
        if (input !== undefined) {
            apiKey = input.trim();
            await context.globalState.update('apiKey', apiKey);
            vscode.window.showInformationMessage('API Key 已保存！');
            vscode.commands.executeCommand('ai-usage-tracker.refreshBalance');
        }
    });
    context.subscriptions.push(showCmd, resetCmd, refreshCmd, refreshTreeCmd, setApiKeyCmd);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aiUsageTracker.currencySymbol') ||
            e.affectsConfiguration('aiUsageTracker.targetApiUrl') ||
            e.affectsConfiguration('aiUsageTracker.proxyPort')) {
            updateStatusBar();
            startProxyServer(context);
        }
    }));
    // 启动代理服务器
    startProxyServer(context);
}
function updateStatusBar() {
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const currencySymbol = config.get('currencySymbol', '¥');
    let text = `$(server-environment)`;
    if (officialBalance !== undefined) {
        text += ` ${currencySymbol}${officialBalance}`;
    }
    else {
        text += ` 获取中...`;
    }
    statusBarItem.text = text;
    statusBarItem.tooltip = "DeepSeek 官方余额 (点击查看单次消耗日志与详情)";
}
function fetchDeepSeekBalance(token) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.deepseek.com',
            port: 443,
            path: '/user/balance',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        };
        const req = originalHttpsRequest(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.is_available && json.balance_infos && json.balance_infos.length > 0) {
                        const cnyInfo = json.balance_infos.find((b) => b.currency === 'CNY') || json.balance_infos[0];
                        resolve(cnyInfo.total_balance);
                    }
                    else {
                        resolve(null);
                    }
                }
                catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}
function handleUsage(context, usage, userPromptSnippet) {
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    // DeepSeek V3 特有的 cache hit 字段
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || 0;
    const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const inputPrice = config.get('inputPricePerMillion', 3);
    const outputPrice = config.get('outputPricePerMillion', 6);
    const cacheHitPrice = config.get('cacheHitPricePerMillion', 0.025);
    const currencySymbol = config.get('currencySymbol', '¥');
    // 计算当次请求的费用 (每百万 Token)
    const requestCost = (uncachedPromptTokens / 1000000) * inputPrice +
        (cachedTokens / 1000000) * cacheHitPrice +
        (completionTokens / 1000000) * outputPrice;
    // 更新全局状态
    totalTokens += (usage.total_tokens || (promptTokens + completionTokens));
    totalCost += requestCost;
    // 持久化保存
    context.globalState.update('totalTokens', totalTokens);
    context.globalState.update('totalCost', totalCost);
    // 更新 UI
    updateStatusBar();
    // 记录合并日志逻辑
    if (!currentTurn) {
        currentTurn = {
            startTime: new Date(),
            userPrompt: userPromptSnippet || 'Agent 内部调用 / 继续生成',
            requestCount: 0,
            uncachedPromptTokens: 0,
            cachedTokens: 0,
            completionTokens: 0,
            totalCost: 0
        };
    }
    else {
        // 只要当前记录的 userPrompt 是默认的，且这次提取到了有效的 snippet，就更新它
        if (userPromptSnippet && currentTurn.userPrompt === 'Agent 内部调用 / 继续生成') {
            currentTurn.userPrompt = userPromptSnippet;
        }
    }
    // 累加本次 API 请求的数据到当前回合
    currentTurn.requestCount += 1;
    currentTurn.uncachedPromptTokens += uncachedPromptTokens;
    currentTurn.cachedTokens += cachedTokens;
    currentTurn.completionTokens += completionTokens;
    currentTurn.totalCost += requestCost;
}
function startProxyServer(context) {
    if (proxyServer) {
        proxyServer.close();
    }
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const port = config.get('proxyPort', 31234);
    const targetUrlStr = config.get('targetApiUrl', 'https://api.deepseek.com');
    const proxy = httpProxy.createProxyServer({
        target: targetUrlStr,
        changeOrigin: true,
        secure: false, // 忽略自签名证书错误
        selfHandleResponse: true // 允许我们自己处理响应
    });
    proxy.on('proxyReq', function (proxyReq, req, res, options) {
        // 由于代理的流式特性，最靠谱的方法是直接获取客户端请求的原始 body，而不是在发送给目标端时拦截。
        // 为了不破坏代理的 pipe，我们在 req 上注册一个非消费型的数据监听
        let requestBodyBuffer = '';
        req.on('data', (chunk) => {
            requestBodyBuffer += chunk.toString();
        });
        req.on('end', () => {
            try {
                const reqBody = JSON.parse(requestBodyBuffer);
                const messages = reqBody.messages;
                if (messages && messages.length > 0) {
                    for (let i = messages.length - 1; i >= 0; i--) {
                        if (messages[i].role === 'user') {
                            let contentStr = '';
                            if (typeof messages[i].content === 'string') {
                                contentStr = messages[i].content;
                            }
                            else if (Array.isArray(messages[i].content)) {
                                const textPart = messages[i].content.find((p) => p.type === 'text' || p.text);
                                if (textPart && textPart.text)
                                    contentStr = textPart.text;
                            }
                            if (contentStr) {
                                const snippet = contentStr.substring(0, 50).replace(/\n/g, ' ') + (contentStr.length > 50 ? '...' : '');
                                req.userPromptSnippet = snippet;
                                logDebug(`[Proxy] 成功拦截到 User Prompt: ${snippet}`);
                            }
                            break;
                        }
                    }
                }
            }
            catch (e) {
                // 非 JSON 请求或解析错误
            }
        });
    });
    proxy.on('proxyRes', function (proxyRes, req, res) {
        let buffer = '';
        let requestUsage = null;
        // 我们需要延迟获取 userPromptSnippet，因为 req.on('end') 可能是异步后触发的
        let userPromptSnippet = '';
        // 直接透传非 200 响应
        if (proxyRes.statusCode && (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300)) {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
            return;
        }
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.on('data', function (chunk) {
            // 将数据直接写给客户端
            res.write(chunk);
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('data: ') && trimmedLine !== 'data: [DONE]') {
                    try {
                        const jsonStr = trimmedLine.slice(6);
                        const data = JSON.parse(jsonStr);
                        if (data.usage) {
                            requestUsage = data.usage;
                        }
                    }
                    catch (e) { }
                }
            }
        });
        proxyRes.on('end', function () {
            // 延迟提取 userPromptSnippet，确保 req 已经 end 且解析完毕
            setTimeout(() => {
                userPromptSnippet = req.userPromptSnippet || '';
                logDebug(`[Proxy] 响应结束，最终提取的 Prompt: ${userPromptSnippet || '为空'}`);
                if (buffer.trim().startsWith('{')) {
                    try {
                        const data = JSON.parse(buffer);
                        if (data.usage) {
                            requestUsage = data.usage;
                        }
                    }
                    catch (e) { }
                }
                if (requestUsage) {
                    handleUsage(context, requestUsage, userPromptSnippet);
                }
                activeRequests--;
                if (activeRequests <= 0) {
                    activeRequests = 0;
                    if (turnFlushTimer)
                        clearTimeout(turnFlushTimer);
                    turnFlushTimer = setTimeout(() => {
                        flushTurn();
                    }, 8000);
                }
                res.end();
            }, 100); // 100ms 足够让 req 的 end 回调执行完毕
        });
    });
    proxy.on('error', function (err, req, res) {
        console.error('代理请求错误:', err);
        if (res && !res.headersSent) {
            res.writeHead(502);
        }
        res.end('Proxy Error');
        activeRequests--;
    });
    proxyServer = http.createServer((req, res) => {
        try {
            activeRequests++;
            if (turnFlushTimer) {
                clearTimeout(turnFlushTimer);
                turnFlushTimer = null;
            }
            if (req.headers.authorization || req.headers.Authorization) {
                const authHeader = (req.headers.authorization || req.headers.Authorization);
                const token = authHeader.replace(/^Bearer\s+/i, '').trim();
                if (token && token !== apiKey) {
                    apiKey = token;
                    context.globalState.update('apiKey', apiKey);
                }
            }
            // 拦截请求体
            let requestBodyBuffer = '';
            // 重要：因为 proxy.web 也会消耗 req 流，我们要么在它之前读取完毕，
            // 要么拦截 proxyReq。对于 http-proxy，最稳妥的方法是监听 proxyReq 事件。
            proxy.web(req, res);
        }
        catch (error) {
            console.error('代理服务错误:', error);
            if (!res.headersSent) {
                res.writeHead(500);
            }
            res.end('Internal Server Error');
            activeRequests--;
        }
    });
    proxyServer.listen(port, () => {
        logDebug(`AI Proxy Server 正在监听 http://localhost:${port}`);
    });
}
function deactivate() {
}
//# sourceMappingURL=extension.js.map