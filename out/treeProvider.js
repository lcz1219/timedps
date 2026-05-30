"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsageItem = exports.UsageTreeProvider = void 0;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
class UsageTreeProvider {
    globalStoragePath;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(globalStoragePath) {
        this.globalStoragePath = globalStoragePath;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    get currencySymbol() {
        return vscode.workspace.getConfiguration('aiUsageTracker').get('currencySymbol', '¥');
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            // Root level: Flat list of all turns (latest first)
            return Promise.resolve(this.getAllTurns());
        }
        else if (element.type === 'turn') {
            // Children of Turn: Details
            return Promise.resolve(this.getDetails(element.turnData));
        }
        return Promise.resolve([]);
    }
    getHistory() {
        const logFile = path.join(this.globalStoragePath, 'history.jsonl');
        if (!fs.existsSync(logFile))
            return [];
        try {
            const content = fs.readFileSync(logFile, 'utf8');
            return content.split('\n')
                .filter(line => line.trim())
                .map(line => {
                try {
                    return JSON.parse(line);
                }
                catch (e) {
                    return null;
                }
            })
                .filter(item => item !== null);
        }
        catch (e) {
            return [];
        }
    }
    getAllTurns() {
        const history = this.getHistory();
        // Sort by time descending
        history.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
        return history.map(turn => {
            const dateObj = new Date(turn.startTime);
            const dateStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()} ${dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            const prompt = turn.userPrompt || 'Agent 内部调用 / 继续生成';
            const summary = this.getPromptSummary(prompt);
            const costStr = `${this.currencySymbol}${turn.totalCost.toFixed(4)}`;
            const requestCountStr = `${turn.requestCount} 次`;
            const item = new UsageItem(summary, vscode.TreeItemCollapsibleState.Collapsed, 'turn', undefined, turn);
            // 扁平化 UI 核心：使用 description 显示关键副标题
            item.description = `${dateStr} · ${costStr}`;
            // 使用 tooltip 提供富文本的 Markdown 悬浮卡片
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`**问题摘要**\n\n${prompt}\n\n`);
            tooltip.appendMarkdown(`---\n\n`);
            tooltip.appendMarkdown(`| 指标 | 数值 |\n`);
            tooltip.appendMarkdown(`| --- | --- |\n`);
            tooltip.appendMarkdown(`| 时间 | ${dateObj.toLocaleString()} |\n`);
            tooltip.appendMarkdown(`| 费用 | ${costStr} |\n`);
            tooltip.appendMarkdown(`| 总 Tokens | ${turn.totalTokens.toLocaleString()} |\n`);
            tooltip.appendMarkdown(`| 未命中缓存 | ${turn.uncachedPromptTokens.toLocaleString()} |\n`);
            tooltip.appendMarkdown(`| 命中缓存 | ${turn.cachedTokens.toLocaleString()} |\n`);
            tooltip.appendMarkdown(`| 输出生成 | ${turn.completionTokens.toLocaleString()} |\n`);
            tooltip.appendMarkdown(`| API 请求 | ${requestCountStr} |\n`);
            item.tooltip = tooltip;
            return item;
        });
    }
    getDetails(turn) {
        const items = [
            new UsageItem(`费用`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`总 Tokens`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`未命中缓存`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`命中缓存`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`输出生成`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`API 请求次数`, vscode.TreeItemCollapsibleState.None, 'detail')
        ];
        items[0].description = `${this.currencySymbol}${turn.totalCost.toFixed(4)}`;
        items[1].description = `${turn.totalTokens.toLocaleString()} tokens`;
        items[2].description = `${turn.uncachedPromptTokens.toLocaleString()} tokens`;
        items[3].description = `${turn.cachedTokens.toLocaleString()} tokens`;
        items[4].description = `${turn.completionTokens.toLocaleString()} tokens`;
        items[5].description = `${turn.requestCount} 次`;
        items[0].iconPath = new vscode.ThemeIcon('credit-card');
        items[1].iconPath = new vscode.ThemeIcon('symbol-number');
        items[2].iconPath = new vscode.ThemeIcon('arrow-up');
        items[3].iconPath = new vscode.ThemeIcon('database');
        items[4].iconPath = new vscode.ThemeIcon('sparkle');
        items[5].iconPath = new vscode.ThemeIcon('pulse');
        return items;
    }
    getPromptSummary(prompt) {
        if (!prompt)
            return 'Agent 内部调用 / 继续生成';
        const cleaned = prompt
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/The user selected the lines[\s\S]*?This may or may not be related to the current task\./gi, ' ')
            .replace(/The user opened the file in the IDE[\s\S]*?(?=(The maximum number of terminals is|$))/gi, ' ')
            .replace(/The maximum number of terminals is[\s\S]*?(?=(# Response Language Settings|$))/gi, ' ')
            .replace(/# Response Language Settings[\s\S]*?Maintain consistency in language throughout the conversation/gi, ' ')
            .replace(/Line Content:\s*`[^`]*`/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleaned)
            return 'Agent 内部调用 / 继续生成';
        const sentence = cleaned.split(/[。！？\n]/)[0].trim() || cleaned;
        return sentence.length > 28 ? `${sentence.substring(0, 28)}...` : sentence;
    }
}
exports.UsageTreeProvider = UsageTreeProvider;
class UsageItem extends vscode.TreeItem {
    label;
    collapsibleState;
    type;
    date;
    turnData;
    constructor(label, collapsibleState, type, date, turnData) {
        super(label, collapsibleState);
        this.label = label;
        this.collapsibleState = collapsibleState;
        this.type = type;
        this.date = date;
        this.turnData = turnData;
        if (type === 'date') {
            this.iconPath = new vscode.ThemeIcon('calendar');
        }
        else if (type === 'turn') {
            this.iconPath = new vscode.ThemeIcon('comment');
        }
        else {
            this.iconPath = new vscode.ThemeIcon('dash');
        }
    }
}
exports.UsageItem = UsageItem;
//# sourceMappingURL=treeProvider.js.map