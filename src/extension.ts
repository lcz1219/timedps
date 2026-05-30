import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as net from 'net';
import { UsageTreeProvider } from './treeProvider';

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let treeProvider: UsageTreeProvider;
let totalTokens = 0;
let totalCost = 0;
let apiKey = '';
let officialBalance: string | undefined = undefined;
let globalStoragePath = '';
let gatewayProcess: cp.ChildProcess | undefined;
let gatewayPort = 31234;
let gatewayPollTimer: NodeJS.Timeout | undefined;
let gatewayConnected = false;
let gatewayConflictShown = false;
let usageQuickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;
let usageQuickPickVisible = false;
let usageQuickPickRefreshing = false;
const usageRefreshButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.green')),
    tooltip: '刷新官方余额'
};
const usageRefreshSpinningButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green')),
    tooltip: '正在刷新官方余额'
};

interface GatewaySummary {
    totalTokens: number;
    totalCost: number;
    officialBalance?: string;
    apiKeyAvailable?: boolean;
    lastUpdatedAt?: number;
}

function logDebug(msg: string) {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}`;
    console.log(`[TimedPS] ${line}`);
    if (outputChannel) {
        outputChannel.appendLine(line);
    }
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
        return `${(tokens / 1000000).toFixed(2)}M`;
    }
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
}

// 同步 QuickPick 顶部按钮和标题状态，让刷新中的反馈更明显一点
function updateUsageQuickPickActions() {
    if (!usageQuickPick) {
        return;
    }
    usageQuickPick.buttons = [usageQuickPickRefreshing ? usageRefreshSpinningButton : usageRefreshButton];
    usageQuickPick.title = usageQuickPickRefreshing ? 'AI Usage · 刷新中' : 'AI Usage';
}

// 生成浮动统计面板的数据项
function getUsageQuickPickItems(): vscode.QuickPickItem[] {
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const currencySymbol = config.get<string>('currencySymbol', '¥');
    const gatewayStatus = gatewayConnected ? '已连接' : '未连接';
    const balanceText = officialBalance !== undefined ? `${currencySymbol}${officialBalance}` : '未知';
    return [
        {
            label: `$(graph) 总 Tokens`,
            description: formatTokens(totalTokens),
            detail: '累计使用量'
        },
        {
            label: `$(credit-card) 预估费用`,
            description: `${currencySymbol}${totalCost.toFixed(4)}`,
            detail: '本地统计'
        },
        {
            label: `$(server-environment) 官方余额`,
            description: balanceText,
            detail: 'DeepSeek 账户余额'
        },
        {
            label: `$(pulse) 网关状态`,
            description: gatewayStatus,
            detail: `代理端口 ${gatewayPort}`
        }
    ];
}

function readJsonResponse<T>(pathName: string, method: string = 'GET', body?: any): Promise<T> {
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
            const chunks: Buffer[] = [];
            res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    const parsed = text ? JSON.parse(text) : {};
                    if ((res.statusCode || 500) >= 400) {
                        reject(new Error(parsed.message || `HTTP ${res.statusCode}`));
                        return;
                    }
                    resolve(parsed as T);
                } catch (e) {
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
        const summary = await readJsonResponse<GatewaySummary>('/__timedps/summary');
        totalTokens = summary.totalTokens || 0;
        totalCost = summary.totalCost || 0;
        officialBalance = summary.officialBalance;
        gatewayConnected = true;
        updateStatusBar();
        treeProvider.refresh();
    } catch (e) {
        gatewayConnected = false;
        updateStatusBar();
        logDebug(`读取网关数据失败: ${e}`);
    }
}

function isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port: port });
        const done = (result: boolean) => {
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

async function getGatewayState(): Promise<'healthy' | 'occupied' | 'free'> {
    try {
        await readJsonResponse('/__timedps/health');
        return 'healthy';
    } catch (e) {}
    return await isPortOpen(gatewayPort) ? 'occupied' : 'free';
}

async function waitForGatewayReady(retryCount: number = 8): Promise<boolean> {
    for (let i = 0; i < retryCount; i++) {
        try {
            await readJsonResponse('/__timedps/health');
            return true;
        } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
    return false;
}

function updateStatusBar() {
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const currencySymbol = config.get<string>('currencySymbol', '¥');
    if (!gatewayConnected) {
        statusBarItem.text = '$(warning) 网关未连接';
        statusBarItem.tooltip = 'TimedPS 本地网关未连接';
        return;
    }
    let text = `$(graph) ${formatTokens(totalTokens)} · ${currencySymbol}${totalCost.toFixed(4)}`;
    if (officialBalance !== undefined) {
        text += `  ${currencySymbol}${officialBalance}`;
    }
    statusBarItem.text = text;
    statusBarItem.tooltip = '点击查看详情';
}

async function startGateway(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    gatewayPort = config.get<number>('proxyPort', 31234);
    const targetApiUrl = config.get<string>('targetApiUrl', 'https://api.deepseek.com');
    const inputPrice = config.get<number>('inputPricePerMillion', 1);
    const outputPrice = config.get<number>('outputPricePerMillion', 2);
    const cacheHitPrice = config.get<number>('cacheHitPricePerMillion', 0.1);

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
    } catch (e) {}
    if (gatewayProcess && !gatewayProcess.killed) {
        try {
            gatewayProcess.kill();
        } catch (e) {}
    }
    gatewayProcess = undefined;
    gatewayConnected = false;
}

export async function activate(context: vscode.ExtensionContext) {
    globalStoragePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(globalStoragePath)) {
        fs.mkdirSync(globalStoragePath, { recursive: true });
    }

    outputChannel = vscode.window.createOutputChannel('AI Usage Log');

    treeProvider = new UsageTreeProvider(globalStoragePath);
    vscode.window.registerTreeDataProvider('ai-usage-tracker-tree', treeProvider);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'ai-usage-tracker.showUsage';
    context.subscriptions.push(statusBarItem);

    updateStatusBar();
    statusBarItem.show();

    const showCmd = vscode.commands.registerCommand('ai-usage-tracker.showUsage', async () => {
        await updateFromGateway();
        if (usageQuickPick && usageQuickPickVisible) {
            usageQuickPickVisible = false;
            usageQuickPick.hide();
            return;
        }
        if (!usageQuickPick) {
            // QuickPick 会以悬浮层方式显示，比打开一个编辑器标签更接近卡片效果
            usageQuickPick = vscode.window.createQuickPick();
            usageQuickPick.title = 'AI Usage';
            usageQuickPick.placeholder = '点击状态栏可再次隐藏，右上角按钮用于刷新官方余额';
            usageQuickPick.ignoreFocusOut = false;
            usageQuickPick.matchOnDescription = true;
            usageQuickPick.matchOnDetail = true;
            updateUsageQuickPickActions();
            usageQuickPick.onDidHide(() => {
                usageQuickPickVisible = false;
            });
            usageQuickPick.onDidTriggerButton(async (button) => {
                if (button !== usageRefreshButton && button !== usageRefreshSpinningButton) {
                    return;
                }
                usageQuickPickRefreshing = true;
                updateUsageQuickPickActions();
                usageQuickPick!.busy = true;
                try {
                    const result = await readJsonResponse<{ officialBalance: string }>('/__timedps/refresh-balance', 'POST');
                    officialBalance = result.officialBalance;
                    updateStatusBar();
                    usageQuickPick!.items = getUsageQuickPickItems();
                } catch (e) {
                    vscode.window.showErrorMessage(`获取余额失败: ${e}`);
                } finally {
                    usageQuickPickRefreshing = false;
                    updateUsageQuickPickActions();
                    usageQuickPick!.busy = false;
                }
            });
        }
        usageQuickPick.items = getUsageQuickPickItems();
        usageQuickPickVisible = true;
        usageQuickPick.show();
    });

    const resetCmd = vscode.commands.registerCommand('ai-usage-tracker.resetUsage', async () => {
        try {
            await readJsonResponse('/__timedps/reset', 'POST');
            await updateFromGateway();
            vscode.window.showInformationMessage('AI Token 消耗及费用记录已重置。');
        } catch (e) {
            vscode.window.showErrorMessage(`重置失败: ${e}`);
        }
    });

    const refreshCmd = vscode.commands.registerCommand('ai-usage-tracker.refreshBalance', async () => {
        usageQuickPickRefreshing = true;
        updateUsageQuickPickActions();
        try {
            const result = await readJsonResponse<{ officialBalance: string }>('/__timedps/refresh-balance', 'POST');
            officialBalance = result.officialBalance;
            updateStatusBar();
            if (usageQuickPick && usageQuickPickVisible) {
                usageQuickPick.items = getUsageQuickPickItems();
            }
            vscode.window.showInformationMessage(`获取成功！官方可用余额: ${officialBalance}`);
        } catch (e) {
            vscode.window.showErrorMessage(`获取余额失败: ${e}`);
        } finally {
            usageQuickPickRefreshing = false;
            updateUsageQuickPickActions();
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
            } catch (e) {
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

    // 方案六：点击侧边栏历史记录回合，弹出详情 QuickPick 查看完整摘要
    // const showTurnDetailCmd = vscode.commands.registerCommand('ai-usage-tracker.showTurnDetail', (turnData: any) => {
    //     if (!turnData) return;
    //     const config = vscode.workspace.getConfiguration('aiUsageTracker');
    //     const currencySymbol = config.get<string>('currencySymbol', '¥');
    //     const dateStr = new Date(turnData.startTime).toLocaleString();
    //     const prompt = turnData.userPrompt || 'Agent 内部调用 / 继续生成';
    //     const costStr = `${currencySymbol}${(turnData.totalCost || 0).toFixed(4)}`;

    //     const quickPick = vscode.window.createQuickPick();
    //     quickPick.title = '对话详情';
    //     quickPick.placeholder = prompt.length > 80 ? prompt.substring(0, 80) + '...' : prompt;
    //     quickPick.ignoreFocusOut = true;
    //     quickPick.matchOnDescription = false;
    //     quickPick.matchOnDetail = false;

    //     quickPick.items = [
    //         {
    //             label: `$(question) 完整提问`,
    //             description: '',
    //             detail: prompt
    //         },
    //         {
    //             label: `$(calendar) 时间`,
    //             description: dateStr,
    //             detail: ''
    //         },
    //         {
    //             label: `$(credit-card) 费用`,
    //             description: costStr,
    //             detail: ''
    //         },
    //         {
    //             label: `$(symbol-number) 总 Tokens`,
    //             description: `${(turnData.totalTokens || 0).toLocaleString()}`,
    //             detail: ''
    //         },
    //         {
    //             label: `$(arrow-up) 未命中缓存`,
    //             description: `${(turnData.uncachedPromptTokens || 0).toLocaleString()} tokens`,
    //             detail: ''
    //         },
    //         {
    //             label: `$(database) 命中缓存`,
    //             description: `${(turnData.cachedTokens || 0).toLocaleString()} tokens`,
    //             detail: ''
    //         },
    //         {
    //             label: `$(sparkle) 输出生成`,
    //             description: `${(turnData.completionTokens || 0).toLocaleString()} tokens`,
    //             detail: ''
    //         },
    //         {
    //             label: `$(pulse) API 请求次数`,
    //             description: `${turnData.requestCount || 0} 次`,
    //             detail: ''
    //         }
    //     ];

    //     quickPick.onDidAccept(() => {
    //         quickPick.hide();
    //     });

    //     // quickPick.show();
    // });

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

export function deactivate() {
    void stopGateway();
}
