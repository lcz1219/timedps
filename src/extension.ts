import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { UsageTreeProvider } from './treeProvider';

let proxyServer: http.Server | undefined;
let statusBarItem: vscode.StatusBarItem;
let refreshStatusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let treeProvider: UsageTreeProvider;
let totalTokens = 0;
let totalCost = 0;
let apiKey = '';
let officialBalance: string | undefined = undefined;
let globalStoragePath = '';

interface TurnData {
    startTime: Date;
    userPrompt: string;
    requestCount: number;
    uncachedPromptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    totalCost: number;
}

let currentTurn: TurnData | null = null;
let turnFlushTimer: NodeJS.Timeout | null = null;
let activeRequests = 0; // 新增：记录当前正在进行的 API 请求数量

function flushTurn() {
    if (!currentTurn) return;
    
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
    const currencySymbol = config.get<string>('currencySymbol', '¥');
    
    const totalTokens = currentTurn.uncachedPromptTokens + currentTurn.cachedTokens + currentTurn.completionTokens;
    outputChannel.appendLine(`💰 回合总计: ${totalTokens.toLocaleString()} tokens | 预估费用: ${currencySymbol}${currentTurn.totalCost.toFixed(4)}`);
    outputChannel.appendLine(``);
    
    // 持久化存储到本地 JSONL 文件中
    try {
        const logFile = path.join(globalStoragePath, 'history.jsonl');
        const logEntry = {
            ...currentTurn,
            timeStr: timeStr,
            totalTokens: totalTokens
        };
        fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n', 'utf8');
        // 触发侧边栏刷新
        if (treeProvider) {
            treeProvider.refresh();
        }
    } catch (e) {
        console.error('保存日志失败:', e);
    }
    
    currentTurn = null;
    if (turnFlushTimer) {
        clearTimeout(turnFlushTimer);
        turnFlushTimer = null;
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Usage Tracker is now active!');

    // 确保全局存储目录存在
    globalStoragePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(globalStoragePath)) {
        fs.mkdirSync(globalStoragePath, { recursive: true });
    }

    // 1. 从本地存储加载之前保存的数据
    totalTokens = context.globalState.get<number>('totalTokens', 0);
    totalCost = context.globalState.get<number>('totalCost', 0);
    apiKey = context.globalState.get<string>('apiKey', '');
    officialBalance = context.globalState.get<string>('officialBalance');
    
    // 初始化 Output Channel
    outputChannel = vscode.window.createOutputChannel('AI Usage Log');
    
    // 初始化 TreeView
    treeProvider = new UsageTreeProvider(globalStoragePath);
    vscode.window.registerTreeDataProvider('ai-usage-tracker-tree', treeProvider);
    
    // 2. 创建并配置状态栏项
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'ai-usage-tracker.showUsage';
    context.subscriptions.push(statusBarItem);
    
    // 创建刷新按钮状态栏
    refreshStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    refreshStatusBarItem.text = '$(sync)';
    refreshStatusBarItem.tooltip = '手动刷新官方余额';
    refreshStatusBarItem.command = 'ai-usage-tracker.refreshBalance';
    context.subscriptions.push(refreshStatusBarItem);
    
    updateStatusBar();
    statusBarItem.show();
    refreshStatusBarItem.show();

    // 3. 注册命令
    const showCmd = vscode.commands.registerCommand('ai-usage-tracker.showUsage', () => {
        outputChannel.show(); // 移除 true，强制获取焦点并弹出面板
        const config = vscode.workspace.getConfiguration('aiUsageTracker');
        const currencySymbol = config.get<string>('currencySymbol', '¥');
        vscode.window.showInformationMessage(`当前 AI Token 消耗: ${totalTokens} Tokens. 本地预估费用: ${currencySymbol}${totalCost.toFixed(4)}`);
    });

    const resetCmd = vscode.commands.registerCommand('ai-usage-tracker.resetUsage', async () => {
        totalTokens = 0;
        totalCost = 0;
        await context.globalState.update('totalTokens', 0);
        await context.globalState.update('totalCost', 0);
        // 清空本地持久化文件
        try {
            const logFile = path.join(globalStoragePath, 'history.jsonl');
            if (fs.existsSync(logFile)) {
                fs.writeFileSync(logFile, '', 'utf8');
            }
        } catch(e) {}
        treeProvider.refresh();
        updateStatusBar();
        vscode.window.showInformationMessage('AI Token 消耗及费用记录已重置。');
    });

    const refreshCmd = vscode.commands.registerCommand('ai-usage-tracker.refreshBalance', async () => {
        if (!apiKey) {
            vscode.window.showWarningMessage('尚未拦截到 API Key，请先在 Trae 中与 AI 进行一次对话。');
            return;
        }
        
        refreshStatusBarItem.text = '$(sync~spin)'; // 显示加载动画
        try {
            const balance = await fetchDeepSeekBalance(apiKey);
            if (balance !== null) {
                officialBalance = balance;
                await context.globalState.update('officialBalance', officialBalance);
                updateStatusBar();
                vscode.window.showInformationMessage(`获取成功！官方可用余额: ${balance}`);
            } else {
                vscode.window.showErrorMessage('获取余额失败，可能是 API Key 失效或网络问题。');
            }
        } catch (e) {
            vscode.window.showErrorMessage(`获取余额异常: ${e}`);
        } finally {
            refreshStatusBarItem.text = '$(sync)';
        }
    });

    const refreshTreeCmd = vscode.commands.registerCommand('ai-usage-tracker.refreshTree', () => {
        treeProvider.refresh();
    });

    context.subscriptions.push(showCmd, resetCmd, refreshCmd, refreshTreeCmd);

    // 4. 启动代理服务器
    startProxyServer(context);

    // 5. 监听配置变化并重启代理服务及更新 UI
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aiUsageTracker.proxyPort') || e.affectsConfiguration('aiUsageTracker.targetApiUrl')) {
            startProxyServer(context);
        }
        if (e.affectsConfiguration('aiUsageTracker.currencySymbol')) {
            updateStatusBar();
        }
    }));
}

function updateStatusBar() {
    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const currencySymbol = config.get<string>('currencySymbol', '¥');
    
    let text = `$(pulse) 预估: ${currencySymbol}${totalCost.toFixed(4)}`;
    if (officialBalance !== undefined) {
        text += ` | 官方: ${currencySymbol}${officialBalance}`;
    }
    
    statusBarItem.text = text;
    statusBarItem.tooltip = "点击查看单次消耗日志与详情";
}

function fetchDeepSeekBalance(token: string): Promise<string | null> {
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
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.is_available && json.balance_infos && json.balance_infos.length > 0) {
                        // 尝试获取 CNY 的余额
                        const cnyInfo = json.balance_infos.find((b: any) => b.currency === 'CNY') || json.balance_infos[0];
                        resolve(cnyInfo.total_balance);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

function startProxyServer(context: vscode.ExtensionContext) {
    // 确保旧的服务器被关闭
    if (proxyServer) {
        proxyServer.close();
    }

    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const port = config.get<number>('proxyPort', 31234);
    const targetUrlStr = config.get<string>('targetApiUrl', 'https://api.deepseek.com');

    proxyServer = http.createServer((req, res) => {
        try {
            // 请求开始，增加计数，并清除防抖定时器
            activeRequests++;
            if (turnFlushTimer) {
                clearTimeout(turnFlushTimer);
                turnFlushTimer = null;
            }

            // 拦截并保存 API Key
            if (req.headers.authorization) {
                const token = req.headers.authorization.replace('Bearer ', '').trim();
                if (token && token !== apiKey) {
                    apiKey = token;
                    context.globalState.update('apiKey', apiKey);
                }
            }

            const targetUrl = new URL(req.url || '', targetUrlStr);
            
            // 配置请求转发选项
            const options: https.RequestOptions = {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
                path: targetUrl.pathname + targetUrl.search,
                method: req.method,
                headers: {
                    ...req.headers,
                    host: targetUrl.hostname // 替换 host，否则目标服务器可能会拒绝
                }
            };

            const proxyReq = https.request(options, (proxyRes) => {
                // 转发响应头
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

                let buffer = '';
                let requestUsage: any = null; // 记录最后一次提取到的完整 usage 对象
                
                let requestBodyBuffer = '';
                req.on('data', chunk => requestBodyBuffer += chunk.toString());

                let userPromptSnippet = '';

                req.on('end', () => {
                    try {
                        const reqBody = JSON.parse(requestBodyBuffer);
                        const messages = reqBody.messages;
                        if (messages && messages.length > 0) {
                            // 倒序查找最后一个 user 的消息，提取作为摘要
                            for (let i = messages.length - 1; i >= 0; i--) {
                                if (messages[i].role === 'user') {
                                    let contentStr = '';
                                    if (typeof messages[i].content === 'string') {
                                        contentStr = messages[i].content;
                                    } else if (Array.isArray(messages[i].content)) {
                                        // 多模态输入情况
                                        const textPart = messages[i].content.find((p: any) => p.type === 'text' || p.text);
                                        if (textPart && textPart.text) contentStr = textPart.text;
                                    }
                                    userPromptSnippet = contentStr.substring(0, 50).replace(/\n/g, ' ') + (contentStr.length > 50 ? '...' : '');
                                    break;
                                }
                            }
                        }
                    } catch(e) {
                        // 忽略解析错误
                    }
                });

                proxyRes.on('data', (chunk) => {
                    // 1. 将数据转发给原始请求方
                    res.write(chunk);
                    
                    // 2. 解析使用量数据
                    buffer += chunk.toString();
                    
                    // SSE 数据以 \n\n 或者 \n 分隔
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // 保留未完整接收的最后一行

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ') && trimmedLine !== 'data: [DONE]') {
                            try {
                                const jsonStr = trimmedLine.slice(6);
                                const data = JSON.parse(jsonStr);
                                if (data.usage) {
                                    requestUsage = data.usage; // 保存最终的 usage 对象
                                }
                            } catch (e) {
                                // 忽略解析错误，可能 chunk 还不完整
                            }
                        }
                    }
                });

                proxyRes.on('end', () => {
                    // 处理非流式的普通 JSON 响应
                    if (buffer.trim().startsWith('{')) {
                        try {
                            const data = JSON.parse(buffer);
                            if (data.usage) {
                                requestUsage = data.usage;
                            }
                        } catch (e) {
                            // 忽略解析错误
                        }
                    }
                    
                    // 如果这次请求获取到了 usage，则进行费用计算
                    if (requestUsage) {
                        handleUsage(context, requestUsage, userPromptSnippet);
                    }
                    
                    finalizeRequest();
                    res.end();
                });
            });

            // 转发客户端请求的 body 到目标服务器
            req.pipe(proxyReq);

            const finalizeRequest = () => {
                activeRequests--;
                if (activeRequests <= 0) {
                    activeRequests = 0;
                    if (turnFlushTimer) clearTimeout(turnFlushTimer);
                    // 只有当所有请求都结束，且过了 8 秒后，才视为这一个回合彻底结束
                    turnFlushTimer = setTimeout(() => {
                        flushTurn();
                    }, 8000);
                }
            };

            proxyReq.on('error', (err) => {
                console.error('代理请求错误:', err);
                if (!res.headersSent) {
                    res.writeHead(500);
                }
                finalizeRequest();
                res.end('Proxy Error');
            });
            
            req.on('error', (err) => {
                finalizeRequest();
            });
        } catch (error) {
            console.error('代理服务错误:', error);
            if (!res.headersSent) {
                res.writeHead(500);
            }
            res.end('Internal Server Error');
        }
    });

    proxyServer.listen(port, () => {
        console.log(`AI Proxy Server 正在监听 http://localhost:${port}`);
        console.log(`目标转发地址为: ${targetUrlStr}`);
    });
}

function handleUsage(context: vscode.ExtensionContext, usage: any, userPromptSnippet: string) {
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    // DeepSeek V3 特有的 cache hit 字段
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || 0;
    const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);

    const config = vscode.workspace.getConfiguration('aiUsageTracker');
    const inputPrice = config.get<number>('inputPricePerMillion', 1.0);
    const outputPrice = config.get<number>('outputPricePerMillion', 2.0);
    const cacheHitPrice = config.get<number>('cacheHitPricePerMillion', 0.1);
    const currencySymbol = config.get<string>('currencySymbol', '¥');

    // 计算当次请求的费用 (每百万 Token)
    const requestCost = 
        (uncachedPromptTokens / 1000000) * inputPrice +
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
    } else if (userPromptSnippet && currentTurn.userPrompt === 'Agent 内部调用 / 继续生成') {
        // 如果第一轮没提取到 userPrompt，后续轮次提取到了则补充
        currentTurn.userPrompt = userPromptSnippet;
    }

    // 累加本次 API 请求的数据到当前回合
    currentTurn.requestCount += 1;
    currentTurn.uncachedPromptTokens += uncachedPromptTokens;
    currentTurn.cachedTokens += cachedTokens;
    currentTurn.completionTokens += completionTokens;
    currentTurn.totalCost += requestCost;
    
    // 注意：不再在这里设置定时器，定时器统由 finalizeRequest 控制
}

export function deactivate() {
    if (proxyServer) {
        proxyServer.close();
    }
}
