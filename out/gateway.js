"use strict";
/*
 * ============================================================
 *  TimedPS 独立本地网关进程
 * ============================================================
 *  这个文件是一个独立运行的 Node.js 进程，不依赖 VS Code API。
 *  它由插件的 extension.ts 通过 child_process.fork() 启动。
 *
 *  网关做了三件事：
 *    1. 监听本地端口（默认 31234），接收 Trae 发来的请求
 *    2. 把请求原样转发到真实的 DeepSeek API
 *    3. 把 DeepSeek 返回的 usage（token 消耗）解析出来，存到本地文件
 *
 *  同时还提供了一组内部管理接口（/__timedps/*），
 *  供插件读取统计数据、刷新余额、重置记录等。
 *
 *  数据的存储位置由环境变量 TIMEDPS_STORAGE_PATH 决定，
 *  默认在进程工作目录下的 .timedps-data 文件夹里。
 * ============================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url_1 = require("url");
// ============================================================
//  配置常量（全部通过环境变量注入，由 extension.ts 控制）
// ============================================================
const storagePath = process.env.TIMEDPS_STORAGE_PATH || path.join(process.cwd(), '.timedps-data');
const proxyPort = Number(process.env.TIMEDPS_PROXY_PORT || 31234);
const targetApiUrl = process.env.TIMEDPS_TARGET_API_URL || 'https://api.deepseek.com';
const inputPricePerMillion = Number(process.env.TIMEDPS_INPUT_PRICE || 1); // 每百万输入 token 价格（默认 1 元）
const outputPricePerMillion = Number(process.env.TIMEDPS_OUTPUT_PRICE || 2); // 每百万输出 token 价格（默认 2 元）
const cacheHitPricePerMillion = Number(process.env.TIMEDPS_CACHE_HIT_PRICE || 0.1); // 每百万缓存命中 token 价格（默认 0.1 元）
const historyFile = path.join(storagePath, 'history.jsonl'); // 历史记录文件（每行一条 JSON）
const summaryFile = path.join(storagePath, 'summary.json'); // 汇总状态文件
// ============================================================
//  全局运行状态（在网关进程生命周期内常驻内存）
// ============================================================
let summaryState = {
    totalTokens: 0,
    totalCost: 0,
    apiKey: '',
    lastUpdatedAt: 0
};
let currentTurn = null; // 当前正在进行的对话回合
let turnFlushTimer = null; // 延迟写入定时器（等 8 秒无新请求就写入文件）
let activeRequests = 0; // 当前正在处理的请求数
/**
 * 优雅关闭回调函数。
 * 网关进程收到关闭指令后会先 flush 当前回合，再退出。
 */
let requestShutdown;
// ============================================================
//  存储层：确保目录存在、读写汇总文件
// ============================================================
/** 确保数据存储目录存在 */
function ensureStorage() {
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }
}
/** 从 summary.json 恢复上次的汇总状态（进程重启后不掉数据） */
function loadSummary() {
    ensureStorage();
    if (!fs.existsSync(summaryFile)) {
        return;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        summaryState = {
            totalTokens: parsed.totalTokens || 0,
            totalCost: parsed.totalCost || 0,
            officialBalance: parsed.officialBalance,
            apiKey: parsed.apiKey || '',
            lastUpdatedAt: parsed.lastUpdatedAt || 0
        };
    }
    catch (e) { }
}
/** 把当前汇总状态写入 summary.json */
function saveSummary() {
    ensureStorage();
    summaryState.lastUpdatedAt = Date.now();
    fs.writeFileSync(summaryFile, JSON.stringify(summaryState, null, 2), 'utf8');
}
// ============================================================
//  HTTP 工具函数
// ============================================================
/** 返回一个 JSON 响应 */
function writeJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify(data));
}
/** 把 HTTP 请求的 body 完整读出来，返回 Buffer */
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
        req.on('error', reject);
    });
}
/**
 * 安全地取 HTTP 头的字符串值。
 * Node.js 的请求头可能是 string | string[] | undefined，
 * 如果是数组就取第一个元素。
 */
function getHeaderString(value) {
    if (Array.isArray(value)) {
        return value[0] || '';
    }
    return value || '';
}
// ============================================================
//  请求转发：URL 拼接
// ============================================================
/**
 * 根据客户端请求的路径，拼出真实上游的完整 URL。
 *
 * 例如：
 *   targetApiUrl = "https://api.deepseek.com"
 *   reqUrl        = "/v1/chat/completions"
 *   结果          → "https://api.deepseek.com/v1/chat/completions"
 */
function buildTargetUrl(reqUrl) {
    const base = new url_1.URL(targetApiUrl);
    if (!reqUrl) {
        return base;
    }
    // 如果已经是完整 URL 就直接用
    if (/^https?:\/\//.test(reqUrl)) {
        return new url_1.URL(reqUrl);
    }
    const next = new url_1.URL(base.toString());
    const queryIndex = reqUrl.indexOf('?');
    const requestPath = queryIndex >= 0 ? reqUrl.slice(0, queryIndex) : reqUrl;
    const requestSearch = queryIndex >= 0 ? reqUrl.slice(queryIndex) : '';
    const basePath = next.pathname === '/' ? '' : next.pathname.replace(/\/+$/, '');
    const childPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    next.pathname = `${basePath}${childPath}`.replace(/\/{2,}/g, '/');
    next.search = requestSearch;
    return next;
}
// ============================================================
//  请求转发：Header 清洗
// ============================================================
/**
 * 构造转发给上游的请求头。
 * 核心原则：
 *   1. 保留客户端原始请求头
 *   2. 把 host 改成上游域名
 *   3. 删掉可能引起问题的头（content-length 按 body 重新计算）
 */
function buildUpstreamHeaders(req, bodyBuffer, targetUrl) {
    const headers = {
        ...req.headers,
        host: targetUrl.host
    };
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    delete headers['connection'];
    delete headers['proxy-connection'];
    delete headers['accept-encoding'];
    if (bodyBuffer.length > 0) {
        headers['content-length'] = String(bodyBuffer.length);
    }
    return headers;
}
// ============================================================
//  用户提问提取：从请求体里拿到真正的用户问题
// ============================================================
/**
 * 清洗文本，去掉系统提示和 IDE 注入的上下文噪音。
 * 这些内容不是用户的真实提问，不应该出现在侧边栏标题里。
 */
function cleanPromptCandidate(content) {
    return content
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ') // 去掉 system-reminder 整块
        .replace(/<[^>]+>/g, ' ') // 去掉所有 XML/HTML 标签
        .replace(/The user selected the lines[\s\S]*?This may or may not be related to the current task\./gi, ' ')
        .replace(/The user opened the file in the IDE[\s\S]*?(?=(The maximum number of terminals is|$))/gi, ' ')
        .replace(/The maximum number of terminals is[\s\S]*?(?=(# Response Language Settings|$))/gi, ' ')
        .replace(/# Response Language Settings[\s\S]*?Maintain consistency in language throughout the conversation/gi, ' ')
        .replace(/Line Content:\s*`[^`]*`/gi, ' ')
        .replace(/\s+/g, ' ') // 合并多余空白
        .trim();
}
/**
 * 判断一段文本是否为 IDE 注入的上下文噪音，而非用户真实提问。
 * 返回 true 表示这段文本应该被过滤掉。
 */
function isLikelyContextNoise(text) {
    if (!text)
        return true;
    return /^The user opened the file in/i.test(text) ||
        /^The user selected the lines/i.test(text) ||
        /^The maximum number of terminals is/i.test(text) ||
        /^# Response Language Settings/i.test(text) ||
        /^Line Content:/i.test(text);
}
/**
 * 从 messages[].content 里取出完整文本。
 * content 可能是 string，也可能是 [{ type: "text", text: "..." }, ...] 数组。
 */
function getMessageTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((item) => typeof item?.text === 'string' ? item.text : '')
        .filter((text) => !!text)
        .join('\n');
}
/**
 * 从清洗后的 user 消息内容里，提取真正的用户提问。
 *
 * 优先级：
 *   1. 优先提取最后一个 <user_input>...</user_input> 标签里的内容
 *   2. 如果没有标签，就倒序找第一条不是上下文噪音的文本行
 *   3. 实在找不到再退回完整清洗文本
 */
function extractActualUserPrompt(content) {
    const userInputMatches = [...content.matchAll(/<user_input>\s*([\s\S]*?)\s*<\/user_input>/g)];
    for (let i = userInputMatches.length - 1; i >= 0; i--) {
        const candidate = userInputMatches[i][1].trim();
        if (candidate && !isLikelyContextNoise(candidate)) {
            return candidate;
        }
    }
    console.log("user content", content);
    const cleaned = cleanPromptCandidate(content);
    const lines = cleaned
        .split(/\n+/)
        .map(line => line.trim())
        .filter(line => !!line);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!isLikelyContextNoise(lines[i])) {
            return lines[i];
        }
    }
    return cleaned;
}
/**
 * 从 OpenAI Chat Completions 请求体里提取用户提问摘要。
 *
 * 逻辑：
 *   1. 解析 JSON，取出 messages 数组
 *   2. 倒序找到最后一条 role === 'user' 的消息
 *   3. 从这条消息的 content 里提取真正的用户问题
 *   4. 截断到 50 个字符并补上 "..."
 */
function parseUserPromptSnippet(bodyBuffer) {
    try {
        const body = JSON.parse(bodyBuffer.toString('utf8'));
        const messages = body.messages;
        if (!Array.isArray(messages))
            return '';
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role !== 'user')
                continue;
            const content = getMessageTextContent(messages[i].content);
            if (content) {
                const extracted = extractActualUserPrompt(content);
                if (extracted && !isLikelyContextNoise(extracted)) {
                    return extracted.substring(0, 50).replace(/\n/g, ' ') + (extracted.length > 50 ? '...' : '');
                }
            }
        }
    }
    catch (e) { }
    return '';
}
// ============================================================
//  Usage 解析：从上游响应里提取 token 消耗数据
// ============================================================
/**
 * 从 SSE（Server-Sent Events）流式响应里提取 usage。
 * DeepSeek 的流式响应格式：
 *   data: {"choices": [...], "usage": {"prompt_tokens": 100, ...}}
 *   data: [DONE]
 *
 * 注意：usage 通常出现在最后一条 data 里，这里会遍历所有行取最后一条。
 */
function extractUsageFromSSE(text) {
    let usage = null;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') {
            continue;
        }
        try {
            const data = JSON.parse(trimmed.slice(6));
            if (data && data.usage) {
                usage = data.usage;
            }
        }
        catch (e) { }
    }
    return usage;
}
/**
 * 从上游响应体里提取 usage。
 * 支持两种格式：
 *   1. SSE 流（text/event-stream）→ 逐行解析
 *   2. 普通 JSON 响应 → 直接 JSON.parse
 */
function extractUsageFromResponse(contentType, text) {
    if (!text)
        return null;
    if (contentType.includes('text/event-stream')) {
        return extractUsageFromSSE(text);
    }
    try {
        const data = JSON.parse(text);
        return data && data.usage ? data.usage : null;
    }
    catch (e) {
        return extractUsageFromSSE(text);
    }
}
// ============================================================
//  对话回合管理：累加 token + 费用，8 秒无新请求后写入文件
// ============================================================
/**
 * 把一次 API 请求的 usage 累加到当前对话回合。
 *
 * 计费逻辑：
 *   费用 = (未命中缓存的输入 token / 1M) × 输入单价
 *        + (命中缓存的输入 token / 1M)   × 缓存单价
 *        + (输出 token / 1M)             × 输出单价
 */
function updateTurn(usage, userPromptSnippet) {
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || 0;
    const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
    const requestCost = (uncachedPromptTokens / 1000000) * inputPricePerMillion +
        (cachedTokens / 1000000) * cacheHitPricePerMillion +
        (completionTokens / 1000000) * outputPricePerMillion;
    // 累加到全局汇总
    summaryState.totalTokens += (usage.total_tokens || (promptTokens + completionTokens));
    summaryState.totalCost += requestCost;
    saveSummary();
    // 如果还没有当前回合就创建一个
    if (!currentTurn) {
        currentTurn = {
            startTime: new Date().toISOString(),
            userPrompt: userPromptSnippet || 'Agent 内部调用 / 继续生成',
            requestCount: 0,
            uncachedPromptTokens: 0,
            cachedTokens: 0,
            completionTokens: 0,
            totalCost: 0
        };
    }
    else if (userPromptSnippet && currentTurn.userPrompt === 'Agent 内部调用 / 继续生成') {
        // 如果之前还是兜底的默认提示，就用新提取到的真实提问覆盖它
        currentTurn.userPrompt = userPromptSnippet;
    }
    // 累加当前回合的统计数据
    currentTurn.requestCount += 1;
    currentTurn.uncachedPromptTokens += uncachedPromptTokens;
    currentTurn.cachedTokens += cachedTokens;
    currentTurn.completionTokens += completionTokens;
    currentTurn.totalCost += requestCost;
}
/**
 * 把当前回合写入 history.jsonl（一行一条 JSON 记录），然后清空 currentTurn。
 */
function flushTurn() {
    if (!currentTurn)
        return;
    ensureStorage();
    const totalTurnTokens = currentTurn.uncachedPromptTokens + currentTurn.cachedTokens + currentTurn.completionTokens;
    const payload = {
        ...currentTurn,
        totalTokens: totalTurnTokens
    };
    fs.appendFileSync(historyFile, JSON.stringify(payload) + '\n', 'utf8');
    currentTurn = null;
    if (turnFlushTimer) {
        clearTimeout(turnFlushTimer);
        turnFlushTimer = null;
    }
}
/**
 * 请求完成后调用。
 * 当所有正在进行的请求都结束时，等 8 秒再 flush 回合。
 *
 * 为什么等 8 秒？
 *   一次对话里可能有多次 API 调用（工具调用 → 继续生成），
 *   8 秒内没有新请求就认为这个回合结束了，把统计数据写入文件。
 */
function finalizeRequest() {
    activeRequests--;
    if (activeRequests <= 0) {
        activeRequests = 0;
        if (turnFlushTimer) {
            clearTimeout(turnFlushTimer);
        }
        turnFlushTimer = setTimeout(() => {
            flushTurn();
        }, 80000);
    }
}
// ============================================================
//  DeepSeek 官方余额查询
// ============================================================
/**
 * 调用 DeepSeek 官方 /user/balance 接口查询账户余额。
 * 返回 CNY 余额的字符串，失败时返回 null。
 */
function fetchOfficialBalance() {
    return new Promise((resolve) => {
        if (!summaryState.apiKey) {
            resolve(null);
            return;
        }
        const req = https.request({
            hostname: 'api.deepseek.com',
            port: 443,
            path: '/user/balance',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${summaryState.apiKey}`,
                'Accept': 'application/json'
            }
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            res.on('end', () => {
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (json.is_available && Array.isArray(json.balance_infos) && json.balance_infos.length > 0) {
                        const cnyInfo = json.balance_infos.find((item) => item.currency === 'CNY') || json.balance_infos[0];
                        resolve(String(cnyInfo.total_balance));
                        return;
                    }
                }
                catch (e) { }
                resolve(null);
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}
// ============================================================
//  内部控制路由：供插件查询统计数据、刷新余额、重置等
//  路径前缀统一用 /__timedps/ 避免和上游 API 路径冲突
// ============================================================
/**
 * 处理内部控制请求。
 * 返回 true 表示已处理（是内部路由），false 表示不是内部路由，需要走代理转发。
 */
async function handleControlRoute(req, res, pathname) {
    // 健康检查：插件用来判断网关是否在线
    if (pathname === '/__timedps/health') {
        writeJson(res, 200, {
            ok: true,
            pid: process.pid,
            proxyPort: proxyPort,
            targetApiUrl: targetApiUrl,
            apiKeyAvailable: !!summaryState.apiKey,
            lastUpdatedAt: summaryState.lastUpdatedAt
        });
        return true;
    }
    // 读取当前汇总数据（总 token、总费用、官方余额）
    if (pathname === '/__timedps/summary') {
        writeJson(res, 200, {
            totalTokens: summaryState.totalTokens,
            totalCost: summaryState.totalCost,
            officialBalance: summaryState.officialBalance,
            apiKeyAvailable: !!summaryState.apiKey,
            lastUpdatedAt: summaryState.lastUpdatedAt
        });
        return true;
    }
    // 重置所有统计数据和历史记录
    if (pathname === '/__timedps/reset' && req.method === 'POST') {
        summaryState.totalTokens = 0;
        summaryState.totalCost = 0;
        currentTurn = null;
        saveSummary();
        if (fs.existsSync(historyFile)) {
            fs.writeFileSync(historyFile, '', 'utf8');
        }
        writeJson(res, 200, { ok: true });
        return true;
    }
    // 手动设置 API Key（用于余额查询等功能）
    if (pathname === '/__timedps/set-api-key' && req.method === 'POST') {
        const body = await parseRequestBody(req);
        try {
            const parsed = JSON.parse(body.toString('utf8'));
            summaryState.apiKey = (parsed.apiKey || '').trim();
            saveSummary();
            writeJson(res, 200, { ok: true, apiKeyAvailable: !!summaryState.apiKey });
            return true;
        }
        catch (e) {
            writeJson(res, 400, { ok: false, message: 'invalid body' });
            return true;
        }
    }
    // 手动刷新 DeepSeek 官方余额
    if (pathname === '/__timedps/refresh-balance' && req.method === 'POST') {
        const balance = await fetchOfficialBalance();
        if (balance === null) {
            writeJson(res, 400, { ok: false, message: 'api key unavailable or invalid' });
            return true;
        }
        summaryState.officialBalance = balance;
        saveSummary();
        writeJson(res, 200, { ok: true, officialBalance: balance });
        return true;
    }
    // 优雅关闭网关进程（会先 flush 当前回合）
    if (pathname === '/__timedps/shutdown' && req.method === 'POST') {
        writeJson(res, 200, { ok: true });
        setTimeout(() => {
            requestShutdown?.();
        }, 50);
        return true;
    }
    return false;
}
// ============================================================
//  代理转发核心：接收 Trae 请求 → 转发到 DeepSeek → 透传响应
// ============================================================
/**
 * 处理一个代理请求的完整流程：
 *   1. 读取客户端（Trae）发来的请求体
 *   2. 提取 API Key（用于后续余额查询）
 *   3. 提取用户提问摘要
 *   4. 构造转发请求头，发送给上游（DeepSeek）
 *   5. 把上游返回的响应原样透传给客户端
 *   6. 从响应里解析 usage，累加到当前回合
 */
async function handleProxyRequest(req, res) {
    // 标记有一个新请求在处理中
    activeRequests++;
    if (turnFlushTimer) {
        clearTimeout(turnFlushTimer);
        turnFlushTimer = null;
    }
    // 步骤 1：读完请求体
    const bodyBuffer = await parseRequestBody(req);
    // 步骤 2：取 Authorization 头里的 API Key
    const authHeader = getHeaderString(req.headers.authorization);
    if (authHeader) {
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        if (token && token !== summaryState.apiKey) {
            summaryState.apiKey = token;
            saveSummary();
        }
    }
    // 步骤 3：从请求体里提取用户提问摘要
    const userPromptSnippet = parseUserPromptSnippet(bodyBuffer);
    // 步骤 4：拼出上游 URL 和请求头
    const upstreamUrl = buildTargetUrl(req.url);
    const headers = buildUpstreamHeaders(req, bodyBuffer, upstreamUrl);
    const client = upstreamUrl.protocol === 'https:' ? https : http;
    // 步骤 5：发送请求到上游
    const upstreamReq = client.request({
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers: headers
    }, (upstreamRes) => {
        // 把上游的响应状态码和头原样返回给客户端
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        const responseChunks = [];
        // 上游每返回一块数据，就立刻写给客户端（不做缓存延迟）
        upstreamRes.on('data', chunk => {
            const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseChunks.push(bufferChunk);
            res.write(bufferChunk);
        });
        // 上游响应结束时：
        upstreamRes.on('end', () => {
            const responseBody = Buffer.concat(responseChunks);
            const contentEncoding = getHeaderString(upstreamRes.headers['content-encoding']);
            const contentType = getHeaderString(upstreamRes.headers['content-type']);
            // 如果响应没有被压缩，就尝试从中解析 usage
            if (!contentEncoding) {
                const usage = extractUsageFromResponse(contentType, responseBody.toString('utf8'));
                if (usage) {
                    updateTurn(usage, userPromptSnippet);
                }
            }
            res.end();
            finalizeRequest();
        });
        // 上游响应流错误 → 返回 502
        upstreamRes.on('error', () => {
            if (!res.headersSent) {
                res.writeHead(502);
            }
            res.end('Gateway upstream response error');
            finalizeRequest();
        });
    });
    // 上游请求连接失败 → 返回 502
    upstreamReq.on('error', () => {
        if (!res.headersSent) {
            res.writeHead(502);
        }
        res.end('Gateway upstream request error');
        finalizeRequest();
    });
    // 把请求体写给上游
    if (bodyBuffer.length > 0) {
        console.log("user handleProxyRequestcontent", bodyBuffer.toString('utf8'));
        upstreamReq.write(bodyBuffer);
    }
    upstreamReq.end();
}
// ============================================================
//  主函数：启动网关服务
// ============================================================
async function main() {
    // 恢复上次的汇总状态
    loadSummary();
    // 创建 HTTP 服务器
    const server = http.createServer(async (req, res) => {
        try {
            const url = new url_1.URL(req.url || '/', `http://127.0.0.1:${proxyPort}`);
            // 先判断是不是内部控制路由
            const handled = await handleControlRoute(req, res, url.pathname);
            if (handled) {
                return;
            }
            // 不是内部路由就当作代理请求处理
            await handleProxyRequest(req, res);
        }
        catch (e) {
            if (!res.headersSent) {
                res.writeHead(500);
            }
            res.end('Gateway internal error');
        }
    });
    // 开始监听
    server.listen(proxyPort, () => {
        console.log(`TimedPS Gateway listening on http://127.0.0.1:${proxyPort}`);
    });
    // 优雅关闭：先 flush 当前回合，再退出
    const shutdown = () => {
        if (turnFlushTimer) {
            clearTimeout(turnFlushTimer);
            turnFlushTimer = null;
        }
        flushTurn();
        server.close(() => {
            process.exit(0);
        });
        setTimeout(() => process.exit(0), 1000);
    };
    requestShutdown = shutdown;
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
main();
//# sourceMappingURL=gateway.js.map