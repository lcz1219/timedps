import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class UsageTreeProvider implements vscode.TreeDataProvider<UsageItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<UsageItem | undefined | void> = new vscode.EventEmitter<UsageItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<UsageItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private globalStoragePath: string) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    private get currencySymbol(): string {
        return vscode.workspace.getConfiguration('aiUsageTracker').get<string>('currencySymbol', '¥');
    }

    getTreeItem(element: UsageItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: UsageItem): Thenable<UsageItem[]> {
        if (!element) {
            // Root level: Flat list of all turns (latest first)
            return Promise.resolve(this.getAllTurns());
        } else if (element.type === 'turn') {
            // Children of Turn: Details
            return Promise.resolve(this.getDetails(element.turnData!));
        }
        return Promise.resolve([]);
    }

    private getHistory(): any[] {
        const logFile = path.join(this.globalStoragePath, 'history.jsonl');
        if (!fs.existsSync(logFile)) return [];
        try {
            const content = fs.readFileSync(logFile, 'utf8');
            return content.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    try {
                        return JSON.parse(line);
                    } catch (e) {
                        return null;
                    }
                })
                .filter(item => item !== null);
        } catch (e) {
            return [];
        }
    }

    private getAllTurns(): UsageItem[] {
        const history = this.getHistory();
        
        // Sort by time descending
        history.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

        return history.map(turn => {
            const dateObj = new Date(turn.startTime);
            const dateStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()} ${dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
            const prompt = turn.userPrompt || 'Agent 内部调用 / 继续生成';
            
            const costStr = `${this.currencySymbol}${turn.totalCost.toFixed(4)}`;
            const tokensStr = `${(turn.totalTokens / 1000).toFixed(1)}k`;

            const item = new UsageItem(
                prompt,
                vscode.TreeItemCollapsibleState.Collapsed,
                'turn',
                undefined,
                turn
            );
            
            // 扁平化 UI 核心：使用 description 显示关键副标题
            item.description = `${dateStr} | 耗资: ${costStr}`;
            
            // 使用 tooltip 提供富文本的 Markdown 悬浮卡片
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`**提问:** ${prompt}\n\n`);
            tooltip.appendMarkdown(`---\n\n`);
            tooltip.appendMarkdown(`- **预估费用:** ${costStr}\n`);
            tooltip.appendMarkdown(`- **总 Tokens:** ${turn.totalTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`  - 命中缓存: ${turn.cachedTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`  - 未命中缓存: ${turn.uncachedPromptTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`  - 输出生成: ${turn.completionTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`- **API 请求:** ${turn.requestCount} 次\n`);
            tooltip.appendMarkdown(`- **时间:** ${dateObj.toLocaleString()}\n`);
            item.tooltip = tooltip;

            return item;
        });
    }

    private getDetails(turn: any): UsageItem[] {
        return [
            new UsageItem(`预估费用: ${this.currencySymbol}${turn.totalCost.toFixed(4)}`, vscode.TreeItemCollapsibleState.None, 'detail-cost'),
            new UsageItem(`总 Tokens: ${turn.totalTokens.toLocaleString()}`, vscode.TreeItemCollapsibleState.None, 'detail-token'),
            new UsageItem(`命中缓存: ${turn.cachedTokens.toLocaleString()}`, vscode.TreeItemCollapsibleState.None, 'detail-cache-hit'),
            new UsageItem(`未命中缓存: ${turn.uncachedPromptTokens.toLocaleString()}`, vscode.TreeItemCollapsibleState.None, 'detail-cache-miss'),
            new UsageItem(`输出生成: ${turn.completionTokens.toLocaleString()}`, vscode.TreeItemCollapsibleState.None, 'detail-output'),
            new UsageItem(`请求次数: ${turn.requestCount}`, vscode.TreeItemCollapsibleState.None, 'detail-request')
        ];
    }
}

export class UsageItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'date' | 'turn' | 'detail' | 'detail-cost' | 'detail-token' | 'detail-cache-hit' | 'detail-cache-miss' | 'detail-output' | 'detail-request',
        public readonly date?: string,
        public readonly turnData?: any
    ) {
        super(label, collapsibleState);
        
        // 使用更具语义化的扁平化内置图标
        if (type === 'turn') {
            this.iconPath = new vscode.ThemeIcon('comment-discussion');
        } else if (type === 'detail-cost') {
            this.iconPath = new vscode.ThemeIcon('credit-card');
        } else if (type === 'detail-token') {
            this.iconPath = new vscode.ThemeIcon('symbol-event');
        } else if (type === 'detail-cache-hit') {
            this.iconPath = new vscode.ThemeIcon('history');
        } else if (type === 'detail-cache-miss') {
            this.iconPath = new vscode.ThemeIcon('cloud-download');
        } else if (type === 'detail-output') {
            this.iconPath = new vscode.ThemeIcon('output');
        } else if (type === 'detail-request') {
            this.iconPath = new vscode.ThemeIcon('pulse');
        } else {
            this.iconPath = new vscode.ThemeIcon('circle-small-filled');
        }
    }
}
