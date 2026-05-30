"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const net = require("net");
const treeProvider_1 = require("./treeProvider");
let statusBarItem;
let refreshStatusBarItem;
let outputChannel;
let treeProvider;
let totalTokens = 0;
let totalCost = 0;
let apiKey = '';
let officialBalance = undefined;
let globalStoragePath = '';
let gatewayProcess;
let gatewayPort = 31234;
let gatewayPollTimer;
let gatewayConnected = false;
let gatewayConflictShown = false;
function logDebug(msg) {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}`;
    console.log(`[TimedPS] ${line}`);
    if (outputChannel) {
        outputChannel.appendLine(line);
    }
}
function formatTokens(tokens) {
    if (tokens >= 1000000) {
        return `${(tokens / 1000000).toFixed(2)}M`;
    }
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
}
function readJsonResponse(pathName, method = 'GET', body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : '';
        const req = http.request({
            hostname: '127.0.0.1',
            port: gatewayPort,
            path: pathName,
            method: method,
            headers: payload ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            } : undefined
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    const parsed = text ? JSON.parse(text) : {};
                    if ((res.statusCode || 500) >= 400) {
                        reject(new Error(parsed.message || `HTTP ${res.statusCode}`));
                        return;
                    }
                    resolve(parsed);
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}
async function updateFromGateway() {
    try {
        const summary = await readJsonResponse('/__timedps/summary');
        totalTokens = summary.totalTokens || 0;
        totalCost = summary.totalCost || 0;
        officialBalance = summary.officialBalance;
        gatewayConnected = true;
        updateStatusBar();
        treeProvider.refresh();
    }
    catch (e) {
        gatewayConnected = false;
        updateStatusBar();
        logDebug(`读取网关数据失败: ${e}`);
    }
}
function isPortOpen(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port: port });
        const done = (result) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(800);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}
async function getGatewayState() {
    try {
        await readJsonResponse('/__timedps/health');
        return 'healthy';
    }
    catch (e) { }
    return await isPortOpen(gatewayPort) ? 'occupied' : 'free';
}
async function waitForGatewayReady(retryCount = 8) {
    for (let i = 0; i < retryCount; i++) {
        try {
            await readJsonResponse('/__timedps/health');
            return true;
        }
        catch (e) {
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
    return false;
}
function updateStatusBar() {
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const currencySymbol = config.get('currencySymbol', '¥');
    if (!gatewayConnected) {
        statusBarItem.text = '$(warning) 网关未连接';
        statusBarItem.tooltip = 'TimedPS 本地网关未连接';
        return;
    }
    let text = `$(graph) ${formatTokens(totalTokens)} · ${currencySymbol}${totalCost.toFixed(4)}`;
    if (officialBalance !== undefined) {
        text += ` | $(server-environment) ${currencySymbol}${officialBalance}`;
    }
    statusBarItem.text = text;
    statusBarItem.tooltip = '点击查看单次消耗日志与详情';
}
async function startGateway(context) {
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    gatewayPort = config.get('proxyPort', 31234);
    const targetApiUrl = config.get('targetApiUrl', 'https://api.deepseek.com');
    const inputPrice = config.get('inputPricePerMillion', 1);
    const outputPrice = config.get('outputPricePerMillion', 2);
    const cacheHitPrice = config.get('cacheHitPricePerMillion', 0.1);
    const state = await getGatewayState();
    if (state === 'healthy') {
        gatewayConnected = true;
        gatewayConflictShown = false;
        logDebug(`复用已存在的 TimedPS 网关: 127.0.0.1:${gatewayPort}`);
        await updateFromGateway();
        return;
    }
    if (state === 'occupied') {
        gatewayConnected = false;
        updateStatusBar();
        logDebug(`端口 ${gatewayPort} 已被其他进程占用，TimedPS 网关无法启动`);
        if (!gatewayConflictShown) {
            gatewayConflictShown = true;
            vscode.window.showErrorMessage(`TimedPS 无法启动：端口 ${gatewayPort} 已被其他进程占用。请先关闭占用该端口的程序，或修改插件端口配置。`);
        }
        return;
    }
    const gatewayLog = path.join(globalStoragePath, 'gateway.log');
    const outFd = fs.openSync(gatewayLog, 'a');
    gatewayProcess = cp.spawn(process.execPath, [path.join(context.extensionPath, 'out', 'gateway.js')], {
        cwd: context.extensionPath,
        env: {
            ...process.env,
            TIMEDPS_STORAGE_PATH: globalStoragePath,
            TIMEDPS_PROXY_PORT: String(gatewayPort),
            TIMEDPS_TARGET_API_URL: targetApiUrl,
            TIMEDPS_INPUT_PRICE: String(inputPrice),
            TIMEDPS_OUTPUT_PRICE: String(outputPrice),
            TIMEDPS_CACHE_HIT_PRICE: String(cacheHitPrice)
        },
        detached: true,
        stdio: ['ignore', outFd, outFd]
    });
    gatewayProcess.unref();
    gatewayConflictShown = false;
    logDebug(`已尝试启动独立网关进程，端口: ${gatewayPort}`);
    const ready = await waitForGatewayReady();
    if (ready) {
        gatewayConnected = true;
        updateStatusBar();
        await updateFromGateway();
        return;
    }
    gatewayConnected = false;
    updateStatusBar();
    logDebug(`网关启动后未通过健康检查，请查看 ${gatewayLog}`);
    vscode.window.showErrorMessage(`TimedPS 网关启动失败，请查看日志文件: ${gatewayLog}`);
}
async function stopGateway() {
    if (gatewayPollTimer) {
        clearInterval(gatewayPollTimer);
        gatewayPollTimer = undefined;
    }
    try {
        await readJsonResponse('/__timedps/shutdown', 'POST');
    }
    catch (e) { }
    if (gatewayProcess && !gatewayProcess.killed) {
        try {
            gatewayProcess.kill();
        }
        catch (e) { }
    }
    gatewayProcess = undefined;
    gatewayConnected = false;
}
async function activate(context) {
    globalStoragePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(globalStoragePath)) {
        fs.mkdirSync(globalStoragePath, { recursive: true });
    }
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
    const showCmd = vscode.commands.registerCommand('ai-usage-tracker.showUsage', async () => {
        await updateFromGateway();
        outputChannel.show();
        const config = vscode.workspace.getConfiguration('aiUsageTracker');
        const currencySymbol = config.get('currencySymbol', '¥');
        vscode.window.showInformationMessage(`当前总 Tokens: ${formatTokens(totalTokens)}，本地预估费用: ${currencySymbol}${totalCost.toFixed(4)}，官方余额: ${officialBalance !== undefined ? currencySymbol + officialBalance : '未知'}`);
    });
    const resetCmd = vscode.commands.registerCommand('ai-usage-tracker.resetUsage', async () => {
        try {
            await readJsonResponse('/__timedps/reset', 'POST');
            await updateFromGateway();
            vscode.window.showInformationMessage('AI Token 消耗及费用记录已重置。');
        }
        catch (e) {
            vscode.window.showErrorMessage(`重置失败: ${e}`);
        }
    });
    const refreshCmd = vscode.commands.registerCommand('ai-usage-tracker.refreshBalance', async () => {
        refreshStatusBarItem.text = '$(sync~spin)';
        try {
            const result = await readJsonResponse('/__timedps/refresh-balance', 'POST');
            officialBalance = result.officialBalance;
            updateStatusBar();
            vscode.window.showInformationMessage(`获取成功！官方可用余额: ${officialBalance}`);
        }
        catch (e) {
            vscode.window.showErrorMessage(`获取余额失败: ${e}`);
        }
        finally {
            refreshStatusBarItem.text = '$(sync)';
        }
    });
    const refreshTreeCmd = vscode.commands.registerCommand('ai-usage-tracker.refreshTree', async () => {
        await updateFromGateway();
    });
    const setApiKeyCmd = vscode.commands.registerCommand('ai-usage-tracker.setApiKey', async () => {
        const input = await vscode.window.showInputBox({
            prompt: '请输入你的 DeepSeek API Key (sk-...)',
            placeHolder: 'sk-...',
            value: apiKey
        });
        if (input !== undefined) {
            apiKey = input.trim();
            try {
                await readJsonResponse('/__timedps/set-api-key', 'POST', { apiKey: apiKey });
                vscode.window.showInformationMessage('API Key 已保存！');
            }
            catch (e) {
                vscode.window.showErrorMessage(`保存 API Key 失败: ${e}`);
            }
        }
    });
    // 打开网关运行日志文件
    const showGatewayLogCmd = vscode.commands.registerCommand('ai-usage-tracker.showGatewayLog', async () => {
        const logPath = path.join(globalStoragePath, 'gateway.log');
        if (!fs.existsSync(logPath)) {
            vscode.window.showWarningMessage('网关日志文件尚未生成，请先触发一次 AI 对话');
            return;
        }
        const doc = await vscode.workspace.openTextDocument(logPath);
        await vscode.window.showTextDocument(doc);
    });
    context.subscriptions.push(showCmd, resetCmd, refreshCmd, refreshTreeCmd, setApiKeyCmd, showGatewayLogCmd);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aiUsageTracker.proxyPort') ||
            e.affectsConfiguration('aiUsageTracker.targetApiUrl') ||
            e.affectsConfiguration('aiUsageTracker.inputPricePerMillion') ||
            e.affectsConfiguration('aiUsageTracker.outputPricePerMillion') ||
            e.affectsConfiguration('aiUsageTracker.cacheHitPricePerMillion')) {
            void stopGateway().then(() => startGateway(context));
        }
        if (e.affectsConfiguration('aiUsageTracker.currencySymbol')) {
            updateStatusBar();
        }
    }));
    await startGateway(context);
    setTimeout(() => {
        void updateFromGateway();
    }, 1000);
    gatewayPollTimer = setInterval(() => {
        void updateFromGateway();
    }, 3000);
}
function deactivate() {
    void stopGateway();
}
//# sourceMappingURL=extension.js.map