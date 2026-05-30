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
            // 根节点：今日汇总 + 日期分组
            return Promise.resolve(this.getRootItems());
        } else if (element.type === 'summary') {
            // 今日汇总的子节点
            return Promise.resolve(this.getSummaryDetails(element.summaryData!));
        } else if (element.type === 'date') {
            // 日期分组下的对话记录
            return Promise.resolve(this.getDateGroupTurns(element.date!));
        } else if (element.type === 'turn') {
            // 对话回合下的 Token 详情拆分
            return Promise.resolve(this.getDetails(element.turnData!));
        }
        return Promise.resolve([]);
    }

    // ============================================================
    //  数据读取：从 history.jsonl 加载所有历史记录
    // ============================================================

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

    // ============================================================
    //  方案一：日期分组逻辑
    // ============================================================

    /**
     * 判断一条记录属于哪个日期分组
     * 返回：'今天' | '昨天' | '本周' | '更早'
     */
    private getDateCategory(dateStr: string): string {
        const date = new Date(dateStr);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayStart = new Date(todayStart.getTime() - 86400000);
        // 本周：过去 7 天内（不含今天和昨天）
        const weekStart = new Date(todayStart.getTime() - 6 * 86400000);

        if (date >= todayStart) return '今天';
        if (date >= yesterdayStart) return '昨天';
        if (date >= weekStart) return '本周';
        return '更早';
    }

    /**
     * 获取某个日期分组下的所有对话记录（按时间倒序）
     */
    private getDateGroupTurns(category: string): UsageItem[] {
        const history = this.getHistory();
        const turns: UsageItem[] = [];

        for (const turn of history) {
            if (this.getDateCategory(turn.startTime) !== category) continue;
            const item = this.buildTurnItem(turn);
            turns.push(item);
        }

        // 按时间倒序
        turns.sort((a, b) => new Date(b.turnData!.startTime).getTime() - new Date(a.turnData!.startTime).getTime());
        return turns;
    }

    // ============================================================
    //  方案三：今日汇总
    // ============================================================

    /**
     * 计算今日汇总数据
     */
    private getTodaySummaryData(): { turns: number; tokens: number; cost: number } | null {
        const history = this.getHistory();
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        let turns = 0;
        let tokens = 0;
        let cost = 0;

        for (const turn of history) {
            if (new Date(turn.startTime) >= todayStart) {
                turns++;
                tokens += turn.totalTokens || 0;
                cost += turn.totalCost || 0;
            }
        }

        return turns > 0 ? { turns, tokens, cost } : null;
    }

    /**
     * 今日汇总节点的子节点（展开后显示详细拆分）
     */
    private getSummaryDetails(data: { turns: number; tokens: number; cost: number }): UsageItem[] {
        const items = [
            new UsageItem(`对话轮数`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`总 Tokens`, vscode.TreeItemCollapsibleState.None, 'detail'),
            new UsageItem(`预估费用`, vscode.TreeItemCollapsibleState.None, 'detail')
        ];
        items[0].description = `${data.turns} 轮`;
        items[1].description = `${data.tokens.toLocaleString()} tokens`;
        items[2].description = `${this.currencySymbol}${data.cost.toFixed(4)}`;
        items[0].iconPath = new vscode.ThemeIcon('comment-discussion');
        items[1].iconPath = new vscode.ThemeIcon('symbol-number');
        items[2].iconPath = new vscode.ThemeIcon('credit-card');
        return items;
    }

    // ============================================================
    //  根节点构建：今日汇总 → 日期分组 → 空状态
    // ============================================================

    /**
     * 构建根级别的树节点列表
     * 顺序：今日汇总 → 今天 → 昨天 → 本周 → 更早
     * 如果没有任何历史记录，显示引导提示
     */
    private getRootItems(): UsageItem[] {
        const history = this.getHistory();

        // 空状态引导
        if (history.length === 0) {
            const emptyItem = new UsageItem(
                '还没有对话记录',
                vscode.TreeItemCollapsibleState.None,
                'detail'
            );
            emptyItem.description = '发起一次 AI 对话后，这里会显示消耗统计';
            emptyItem.iconPath = new vscode.ThemeIcon('info');
            emptyItem.tooltip = '在 Trae 中发起 AI 对话后，TimedPS 会自动统计 Token 消耗并显示在这里';
            return [emptyItem];
        }

        const items: UsageItem[] = [];

        // 今日汇总（可折叠，展开看详情）
        const todaySummary = this.getTodaySummaryData();
        if (todaySummary) {
            const summaryItem = new UsageItem(
                '今日汇总',
                vscode.TreeItemCollapsibleState.Collapsed,
                'summary',
                undefined,
                undefined,
                todaySummary
            );
            const tokensStr = this.formatTokens(todaySummary.tokens);
            summaryItem.description = `${todaySummary.turns} 轮 · ${tokensStr} · ${this.currencySymbol}${todaySummary.cost.toFixed(4)}`;
            summaryItem.iconPath = new vscode.ThemeIcon('graph');
            summaryItem.tooltip = `今日共 ${todaySummary.turns} 轮对话，消耗 ${todaySummary.tokens.toLocaleString()} tokens，预估费用 ${this.currencySymbol}${todaySummary.cost.toFixed(4)}`;
            items.push(summaryItem);
        }

        // 日期分组（按固定顺序）
        const categories = ['今天', '昨天', '本周', '更早'];
        // 统计每个分组里有多少条记录
        const categoryCounts: Record<string, number> = {};
        for (const turn of history) {
            const cat = this.getDateCategory(turn.startTime);
            categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
        }

        for (const cat of categories) {
            const count = categoryCounts[cat] || 0;
            if (count === 0) continue;

            const dateItem = new UsageItem(
                cat,
                vscode.TreeItemCollapsibleState.Expanded,
                'date',
                cat
            );
            dateItem.description = `${count} 轮对话`;
            dateItem.iconPath = new vscode.ThemeIcon('calendar');

            // 计算该分组的费用合计
            const catTurns = history.filter(t => this.getDateCategory(t.startTime) === cat);
            const catCost = catTurns.reduce((sum, t) => sum + (t.totalCost || 0), 0);
            const catTokens = catTurns.reduce((sum, t) => sum + (t.totalTokens || 0), 0);
            dateItem.tooltip = `${cat}共 ${count} 轮 · ${this.formatTokens(catTokens)} · ${this.currencySymbol}${catCost.toFixed(4)}`;

            items.push(dateItem);
        }

        return items;
    }

    // ============================================================
    //  构建单条对话回合节点（含方案六 command + 方案七 费用颜色图标）
    // ============================================================

    /**
     * 把一条 turn 数据构建成 UsageItem
     * 包含：问题摘要、日期时间、费用、command（点击查看详情）、费用颜色图标
     */
    private buildTurnItem(turn: any): UsageItem {
        const dateObj = new Date(turn.startTime);
        const dateStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()} ${dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
        const prompt = turn.userPrompt || 'Agent 内部调用 / 继续生成';
        const summary = this.getPromptSummary(prompt);

        const costStr = `${this.currencySymbol}${turn.totalCost.toFixed(4)}`;
        const tokensStr = this.formatTokens(turn.totalTokens || 0);
        const requestCountStr = `${turn.requestCount} 次`;

        const item = new UsageItem(
            summary,
            vscode.TreeItemCollapsibleState.Collapsed,
            'turn',
            undefined,
            turn
        );

        // 扁平化 UI：description 显示日期 + tokens + 费用
        item.description = `${dateStr} · ${tokensStr} · ${costStr}`;

        // 方案六：点击回合直接查看完整摘要
        item.command = {
            command: 'ai-usage-tracker.showTurnDetail',
            title: '查看对话详情',
            arguments: [turn]
        };

        // 方案七：根据费用阈值切换图标颜色标识
        const cost = turn.totalCost || 0;
        if (cost >= 0.5) {
            item.iconPath = new vscode.ThemeIcon('flame');        // 高消费：火苗
        } else if (cost >= 0.1) {
            item.iconPath = new vscode.ThemeIcon('warning');      // 中等消费：警告
        } else {
            item.iconPath = new vscode.ThemeIcon('comment');      // 低消费：普通对话气泡
        }

        // tooltip 悬浮卡片（Markdown 格式）
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
    }

    // ============================================================
    //  Token 详细拆分（点击展开回合后显示的子节点）
    // ============================================================

    private getDetails(turn: any): UsageItem[] {
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

    // ============================================================
    //  工具函数
    // ============================================================

    /**
     * 格式化 Token 数量显示
     * >= 100 万 → "1.23M"
     * >= 1000   → "12.3k"
     * < 1000    → 原样显示
     */
    private formatTokens(tokens: number): string {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(2)}M`;
        }
        if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}k`;
        }
        return tokens.toString();
    }

    /**
     * 从用户问题中提取摘要标题
     */
    private getPromptSummary(prompt: string): string {
        if (!prompt) return 'Agent 内部调用 / 继续生成';
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
        if (!cleaned) return 'Agent 内部调用 / 继续生成';
        const sentence = cleaned.split(/[。！？\n]/)[0].trim() || cleaned;
        return sentence.length > 28 ? `${sentence.substring(0, 28)}...` : sentence;
    }
}

export class UsageItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'date' | 'turn' | 'detail' | 'summary',
        public readonly date?: string,
        public readonly turnData?: any,
        public readonly summaryData?: { turns: number; tokens: number; cost: number }
    ) {
        super(label, collapsibleState);
        if (type === 'summary') {
            this.iconPath = new vscode.ThemeIcon('graph');
        } else if (type === 'date') {
            this.iconPath = new vscode.ThemeIcon('calendar');
        } else if (type === 'turn') {
            this.iconPath = new vscode.ThemeIcon('comment');
        } else {
            this.iconPath = new vscode.ThemeIcon('dash');
        }
    }
}
