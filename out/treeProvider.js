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
            const costStr = `${this.currencySymbol}${turn.totalCost.toFixed(4)}`;
            const tokensStr = `${(turn.totalTokens / 1000).toFixed(1)}k`;
            const item = new UsageItem(prompt, vscode.TreeItemCollapsibleState.Collapsed, 'turn', undefined, turn);
            // 扁平化 UI 核心：使用 description 显示关键副标题
            item.description = `${dateStr} | ${costStr}`;
            // 使用 tooltip 提供富文本的 Markdown 悬浮卡片
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`** 提问:** ${prompt}\n\n`);
            tooltip.appendMarkdown(`---\n\n`);
            tooltip.appendMarkdown(`- ** 费用:** ${costStr}\n`);
            tooltip.appendMarkdown(`- ** 总 Tokens:** ${turn.totalTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`  - 命中缓存: ${turn.cachedTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`  - 未命中缓存: ${turn.uncachedPromptTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`  - 输出生成: ${turn.completionTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`- ** API 请求:** ${turn.requestCount} 次\n`);
            tooltip.appendMarkdown(`- ** 时间:** ${dateObj.toLocaleString()}\n`);
            item.tooltip = tooltip;
            return item;
        });
    }
    getDetails(turn) {
        return [
            new UsageItem(` 费用: ${this.currencySymbol}${turn.totalCost.toFixed(4)}`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(` 总 Tokens: ${turn.totalTokens.toLocaleString()}`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`  - 未命中缓存: ${turn.uncachedPromptTokens.toLocaleString()}`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`  - 命中缓存: ${turn.cachedTokens.toLocaleString()}`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`  - 输出生成: ${turn.completionTokens.toLocaleString()}`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(` API 请求次数: ${turn.requestCount}`, vscode.TreeItemCollapsibleState.None, 'detail')
        ];
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
            this.iconPath = new vscode.ThemeIcon('comment-discussion');
        }
        else {
            this.iconPath = new vscode.ThemeIcon('circle-small-filled');
        }
    }
}
exports.UsageItem = UsageItem;
//# sourceMappingURL=treeProvider.js.map