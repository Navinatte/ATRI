/**
 * LiteLLM 参数兼容代理
 * 在 VS Code Copilot 与 LiteLLM 网关之间做一层参数清洗，
 * 解决 Copilot 扩展的参数冲突问题。
 *
 * 已知兼容问题:
 *   - claude-opus-4-*: temperature 已弃用，需要移除
 *   claude-sonnet-5: temperature 和 top_p 均已弃用，需要移除
 *   - claude-sonnet/haiku-4-*: temperature 和 top_p 不能同时存在，移除 top_p
 *   - gemini-*: 视觉请求需将图片转 base64 放入 image_url 字段
 *
 * 附加能力:
 *   - 实时统计每次请求的 token 消耗（命中缓存 / 未命中缓存 / 输出）
 *   - 按模型分组累计，实时写出到同级目录 token-usage.html 看板
 *   - 为 Claude 系请求自动注入 system 消息 cache_control 断点（该网关 Claude 渠道
 *     无隐式缓存；固定断点 + 追加式对话实测稳态命中 ~94%，详见 injectCacheControl）
 *
 * 使用方法: node litellm-proxy.js
 * 然后 VS Code 的 custom endpoint URL 指向 http://localhost:3001
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TARGET_HOST = 'ai-office.ztgame.com';
const TARGET_PORT = 443;
const TARGET_PROTOCOL = 'https:';
const PROXY_PORT = 3001;

/** 上游 keep-alive Agent：复用 TLS 连接，减少每次请求的重复握手 */
const UPSTREAM_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 32,
  rejectUnauthorized: false,
});

/** 上游瞬时网络错误（TLS 握手中断 / 连接重置等）的自动重试次数 */
const UPSTREAM_MAX_RETRIES = 2;
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED',
]);

/** 判断是否为可安全重试的瞬时网络错误（实际重试前还会确认响应未回写）。 */
function isTransientNetworkError(err) {
  if (err && TRANSIENT_ERROR_CODES.has(err.code)) return true;
  return /socket disconnected|TLS connection|connection reset|ECONNRESET/i.test(String(err?.message || ''));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_HTML_PATH = path.join(__dirname, 'token-usage.html');
const STATS_DATA_PATH = path.join(__dirname, 'token-usage.json');
const PROMPT_DEBUG_PATH = path.join(__dirname, 'prompt-debug.jsonl');

/** 最近一次 system prompt 的 SHA256，用于检测提示词前缀变化 */
let lastSystemHash = null;
/** 提示词调试日志保留最近条数 */
const PROMPT_LOG_LIMIT = 200;

/**
 * 模型计费费率（美元 / 每百万 token）。
 *   input:  标准输入价
 *   output: 标准输出价
 */
const CACHE_INPUT_DISCOUNT = 0.1;
const CACHE_WRITE_PREMIUM = 1.25;
const PRICING = {
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-fable-5': { input: 10.0, output: 50.0 },
  // Gemini 系列
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.1-pro-preview': { input: 2.0, output: 12.0 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  // GPT 系列
  'gpt-5.6-sol': { input: 5.0, output: 30.0 },
  'gpt-5.6-terra': { input: 2.0, output: 12.0 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
};

/** 统一统计模型名，避免同一模型因供应商前缀被拆分展示。 */
function normalizeModelName(model) {
  return String(model || 'unknown').replace(/^vertex_ai\//i, '');
}

/** 根据模型名匹配费率，兼容带 vertex_ai/ 前缀或大小写差异。 */
function getPricing(model) {
  const key = normalizeModelName(model).toLowerCase();
  return PRICING[key] || null;
}

/**
 * 计算一次请求的费用（美元）。
 * 缓存计费规则（与官方口径对齐）:
 *   - Gemini / Claude: 命中缓存输入按 CACHE_INPUT_DISCOUNT(0.1x) 计费
 *   - Claude: 写缓存(cache_creation)按 CACHE_WRITE_PREMIUM(1.25x) 计费，
 *     其余未命中输入按标准价计费
 *   - 其它模型: 缓存无折扣，全部按标准输入价计费
 */
function calcCost(model, u) {
  const p = getPricing(model);
  if (!p) return 0;
  const base = String(model).replace(/^.*\//, '');
  const supportsCacheDiscount = /^(gemini-|claude-)/i.test(base);
  const readRate = supportsCacheDiscount ? CACHE_INPUT_DISCOUNT : 1;
  const writeRate = /^claude-/i.test(base) ? CACHE_WRITE_PREMIUM : 1;
  // uncached 口径里含写缓存 token，计费时拆开：写缓存按溢价、其余按标准价
  const write = Math.min(Number(u.cacheWrite) || 0, u.uncached);
  const fresh = u.uncached - write;
  const cachedCost = (u.cached / 1e6) * p.input * readRate;
  const writeCost = (write / 1e6) * p.input * writeRate;
  const uncachedCost = (fresh / 1e6) * p.input;
  const outputCost = (u.output / 1e6) * p.output;
  return cachedCost + writeCost + uncachedCost + outputCost;
}

/** 按当前已知费率恢复历史费用，未知模型保留原有金额。 */
function recalculateHistoricalCosts(loadedStats) {
  for (const [model, usage] of Object.entries(loadedStats.models)) {
    if (getPricing(model)) usage.cost = calcCost(model, usage);
  }
  for (const usage of loadedStats.recent) {
    if (getPricing(usage.model)) usage.cost = calcCost(usage.model, usage);
  }
  loadedStats.total.cost = Object.values(loadedStats.models)
    .reduce((sum, usage) => sum + (Number(usage.cost) || 0), 0);
  return loadedStats;
}

const RECENT_LIMIT = 50;

/**
 * 从磁盘加载历史统计；不存在或损坏时返回全新结构。
 * 累计数据跨重启保留，最近明细同样恢复（仍受 RECENT_LIMIT 约束）。
 */
function loadStats() {
  const fresh = {
    startedAt: Date.now(),
    total: { cached: 0, uncached: 0, output: 0, requests: 0, cost: 0 },
    models: Object.create(null),
    recent: [],
  };
  try {
    const raw = fs.readFileSync(STATS_DATA_PATH, 'utf8');
    const saved = JSON.parse(raw);
    // 合并历史累计，并将供应商前缀不同的同一模型归入统一名称
    const models = Object.create(null);
    for (const [model, usage] of Object.entries(saved.models || {})) {
      const normalizedModel = normalizeModelName(model);
      const merged = (models[normalizedModel] ??= {
        cached: 0,
        uncached: 0,
        cacheWrite: 0,
        output: 0,
        cost: 0,
        requests: 0,
        lastTs: 0,
      });
      merged.cached += Number(usage.cached) || 0;
      merged.uncached += Number(usage.uncached) || 0;
      merged.cacheWrite += Number(usage.cacheWrite) || 0;
      merged.output += Number(usage.output) || 0;
      merged.cost += Number(usage.cost) || 0;
      merged.requests += Number(usage.requests) || 0;
      merged.lastTs = Math.max(merged.lastTs, Number(usage.lastTs) || 0);
    }
    return recalculateHistoricalCosts({
      startedAt: saved.startedAt || fresh.startedAt,
      total: { ...fresh.total, ...(saved.total || {}) },
      models,
      recent: Array.isArray(saved.recent)
        ? saved.recent.slice(0, RECENT_LIMIT).map(usage => ({
            ...usage,
            model: normalizeModelName(usage.model),
          }))
        : [],
    });
  } catch {
    return fresh;
  }
}

/**
 * token 统计累加器
 * 结构:
 *   total:  全局汇总 { cached, uncached, output, requests, cost }
 *   models: 各模型 { [model]: { cached, uncached, output, cost, requests, lastTs } }
 *   recent: 最近若干次请求明细，用于看板列表
 */
const stats = loadStats();

/** 把当前统计落盘，供下次启动累加。 */
function saveStats() {
  try {
    fs.writeFileSync(STATS_DATA_PATH, JSON.stringify(stats), 'utf8');
  } catch (err) {
    console.error('[stats] 保存累计数据失败:', err.message);
  }
}

/**
 * 从一份 usage 对象中提取三类口径的 token。
 * 兼容 OpenAI 风格 (prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens)
 * 与 Anthropic 风格 (input_tokens / output_tokens / cache_read_input_tokens)。
 */
function extractUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  // 输出 token
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;

  // 命中缓存的 token
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    0;

  // 写缓存的 token（Claude 首次写入断点前缀时产生，计费有 1.25x 溢价）
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  // 输入总量（用于推算未命中缓存）
  const promptTotal =
    usage.prompt_tokens ??
    (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);

  // 未命中口径包含写缓存 token（保持列内数字加总 = 输入总量），计费时在 calcCost 拆开
  const uncached = Math.max(0, promptTotal - cached);

  return { cached, uncached, cacheWrite, output };
}

/**
 * 把一次请求的 usage 计入统计并刷新看板。
 */
function recordUsage(model, usage) {
  const u = extractUsage(usage);
  if (!u) return;

  const normalizedModel = normalizeModelName(model);
  const cost = calcCost(normalizedModel, u);

  stats.total.cached += u.cached;
  stats.total.uncached += u.uncached;
  stats.total.output += u.output;
  stats.total.cost += cost;
  stats.total.requests += 1;

  const m = (stats.models[normalizedModel] ??= {
    cached: 0,
    uncached: 0,
    output: 0,
    cost: 0,
    requests: 0,
    lastTs: 0,
  });
  m.cached += u.cached;
  m.uncached += u.uncached;
  m.cacheWrite = (m.cacheWrite || 0) + (u.cacheWrite || 0);
  m.output += u.output;
  m.cost += cost;
  m.requests += 1;
  m.lastTs = Date.now();

  stats.recent.unshift({ model: normalizedModel, ...u, cost, ts: Date.now() });
  if (stats.recent.length > RECENT_LIMIT) stats.recent.length = RECENT_LIMIT;

  if (!/embed/i.test(normalizedModel)) {
    console.log(
      `[stats] ${normalizedModel} 命中缓存=${u.cached} 未命中=${u.uncached} 输出=${u.output} 费用=$${cost.toFixed(4)}`
    );
  }

  writeStatsHtml();
  saveStats();
}

/**
 * 从流式 (SSE) 或整段 JSON 响应文本中尽量解析出 usage。
 * 流式响应里 usage 通常出现在最后几个 data: chunk 中。
 */
function parseUsageFromResponse(text) {
  // 先尝试整段 JSON（非流式）
  try {
    const json = JSON.parse(text);
    if (json.usage) return json.usage;
  } catch {
    // 非整段 JSON，按 SSE 逐行扫描
  }

  let found = null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (obj.usage) found = obj.usage; // 取最后一个带 usage 的 chunk
    } catch {
      // 单行无法解析，跳过
    }
  }
  return found;
}

const numberFmt = new Intl.NumberFormat('zh-CN');

/** 费用格式化为美元字符串，按金额大小自动选择小数位。 */
function fmtCost(v) {
  if (v >= 1) return '$' + v.toFixed(2);
  if (v >= 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(6);
}

/** 生成符合蓝色系设计规范的 token 看板 HTML 并写盘。 */
function writeStatsHtml() {
  try {
    fs.writeFileSync(STATS_HTML_PATH, renderStatsHtml(), 'utf8');
  } catch (err) {
    console.error('[stats] 写出看板失败:', err.message);
  }
}

/**
 * 参数清洗：按模型规则移除冲突参数
 *
 * 各模型参数限制（基于 Vertex AI / LiteLLM 错误反馈）:
 *   opus-4-8 / opus-4-7 / opus-5: temperature 和 top_p 均已弃用
 *   opus-4-6:                   temperature 已弃用，top_p 正常
 *   sonnet-5:                   temperature 和 top_p 均已弃用
 *   其它(sunset/haiku):  temperature 和 top_p 不能同时存在
 *   gemini-*:            无需特殊参数清洗，透传即可
 */
function sanitizeParams(json) {
  const model = json.model || 'unknown';
  const isOpus48or47or5 = /opus-(?:4-[87]|5)$/.test(model);
  const isOpus46 = /opus-4-6$/.test(model);
  const isSonnet5 = /sonnet-5$/.test(model);
  const isGemini = /^gemini/i.test(model);

  // 流式请求默认不返回 usage，需显式开启 include_usage 才能在 SSE 末尾拿到统计
  if (json.stream === true) {
    json.stream_options = { ...(json.stream_options || {}), include_usage: true };
  }

  // Gemini 系列无需额外参数清洗，透传即可
  if (isGemini) return json;

  // Opus 4.8 / 4.7 / 5：temperature 和 top_p 都已弃用，全部移除
  if (isOpus48or47or5) {
    if (json.temperature !== undefined) {
      delete json.temperature;
      console.log(`[proxy] 已移除 temperature (model=${model})`);
    }
    if (json.top_p !== undefined) {
      delete json.top_p;
      console.log(`[proxy] 已移除 top_p (model=${model})`);
    }
    return json;
  }

  // Opus 4.6：temperature 已弃用，移除 temperature
  if (isOpus46) {
    if (json.temperature !== undefined) {
      delete json.temperature;
      console.log(`[proxy] 已移除 temperature (model=${model})`);
    }
    return json;
  }

  // Sonnet 5：temperature 和 top_p 均已弃用，全部移除
  if (isSonnet5) {
    if (json.temperature !== undefined) {
      delete json.temperature;
      console.log(`[proxy] 已移除 temperature (model=${model})`);
    }
    if (json.top_p !== undefined) {
      delete json.top_p;
      console.log(`[proxy] 已移除 top_p (model=${model})`);
    }
    return json;
  }

  // 其它模型（Sonnet / Haiku）：temperature 和 top_p 不能同时存在
  if (json.temperature !== undefined && json.top_p !== undefined) {
    delete json.top_p;
    console.log(`[proxy] 已移除 top_p (model=${model}, temperature=${json.temperature})`);
  }

  return json;
}

/**
 * 粗略估算一段文本的 token 数（CJK 字符 ≈ 1 token，其余按 ~3.5 字符/token）。
 * 仅用于日志提示是否达到 Claude 最小可缓存阈值，不参与转发逻辑。
 */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 3.5);
}

/**
 * 为 Claude 系请求自动注入 system 消息的 cache_control 断点。
 *
 * 背景（2026-09 经本代理链路实测）:
 *   - 该网关的 Claude 渠道（vertex_ai/claude-*、无前缀 claude-*）无隐式 prompt 缓存，
 *     不打 cache_control 时同请求连发两次 cached=0
 *   - 断点固定在 system 末尾且永不移动时，追加式对话单轮命中 93%+，累计 88.5%
 *   - 断点若随对话前移（如打在最后一条历史消息上）会触发全量重写，得不偿失
 *
 * 规则:
 *   - 仅对模型名含 claude 的请求生效（Gemini/GPT/GLM 等走隐式缓存或
 *     不认该字段，注入反而可能报未知参数错误）
 *   - 请求中已存在 cache_control（应用自己管理）时不重复注入
 *   - 找最后一条 system/developer 消息打一个断点；无 system 时跳过
 *     （断在每轮变动的消息上会破坏命中）
 *   - system 估算不足 1024 tokens（Sonnet/Opus 最小可缓存阈值）时仅提示，
 *     上游会安全忽略过短断点，不会报错
 */
function injectCacheControl(json) {
  if (!json || !Array.isArray(json.messages)) return json;
  const model = String(json.model || '');
  if (!/claude/i.test(model)) return json;

  // 应用已自带断点则不插手
  for (const m of json.messages) {
    if (JSON.stringify(m.content ?? '').includes('"cache_control"')) return json;
  }

  // 取最后一条 system/developer 消息（litellm 会把 developer 归并为 system）
  let systemMsg = null;
  for (const m of json.messages) {
    if (m.role === 'system' || m.role === 'developer') systemMsg = m;
  }
  if (!systemMsg) {
    console.log(`[cache] ${model}: 无 system 消息，跳过 cache_control 注入`);
    return json;
  }

  const MARK = { type: 'ephemeral' };
  let est = 0;
  if (typeof systemMsg.content === 'string') {
    est = estimateTokens(systemMsg.content);
    systemMsg.content = [{ type: 'text', text: systemMsg.content, cache_control: MARK }];
  } else if (Array.isArray(systemMsg.content) && systemMsg.content.length > 0) {
    est = estimateTokens(systemMsg.content.map(b => (b && typeof b.text === 'string') ? b.text : '').join(''));
    // 打在最后一个 block 上：断点覆盖整个 system 前缀
    systemMsg.content[systemMsg.content.length - 1].cache_control = MARK;
  } else {
    return json;
  }

  console.log(`[cache] ${model}: 已注入 system 断点（估算 ~${est} tokens）`);
  if (est < 1024) {
    console.log(`[cache]   提示: 低于 1024 tokens 最小可缓存阈值，上游可能忽略该断点`);
  }
  return json;
}

/**
 * 截获提示词结构并写入调试日志。
 * 记录每条消息的角色、长度、首尾预览及 system prompt 的 SHA256 哈希，
 * 用于定位提示词前缀微小变化导致上游缓存未命中的问题。
 */
function logPromptStructure(model, json) {
  const messages = json.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  // 构建按角色的消息结构摘要
  const msgSummary = messages.map((m, i) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    const len = content.length;
    return {
      idx: i,
      role: m.role || 'unknown',
      content_len: len,
      preview_head: content.slice(0, 200),
      preview_tail: len > 400 ? content.slice(-200) : null,
    };
  });

  // 计算 system prompt（第一条 system 角色消息）的 SHA256
  const systemMsg = messages.find(m => m.role === 'system');
  const systemContent = systemMsg && typeof systemMsg.content === 'string'
    ? systemMsg.content
    : (systemMsg ? JSON.stringify(systemMsg.content) : '');
  const systemHash = systemContent
    ? crypto.createHash('sha256').update(systemContent, 'utf8').digest('hex')
    : null;

  // 计算完整 messages 数组的结构指纹
  const structureFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(messages.map(m => ({
      role: m.role,
      content_len: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length,
    }))), 'utf8')
    .digest('hex');

  // 检测 system prompt 是否发生变化
  let hashChanged = false;
  if (systemHash) {
    if (lastSystemHash && lastSystemHash !== systemHash) {
      hashChanged = true;
      console.log(`[prompt-debug] *** System Prompt 哈希已变化! ***`);
      console.log(`[prompt-debug]   旧: ${lastSystemHash}`);
      console.log(`[prompt-debug]   新: ${systemHash}`);
    } else if (!lastSystemHash) {
      console.log(`[prompt-debug] 首次记录 System Prompt 哈希: ${systemHash}`);
    }
    lastSystemHash = systemHash;
  }

  const record = {
    ts: new Date().toISOString(),
    model,
    msg_count: messages.length,
    system_hash: systemHash,
    struct_fingerprint: structureFingerprint,
    messages: msgSummary,
    // 额外记录顶层参数（除 messages 外），方便对比 temperature/top_p 等是否变动
    params: Object.fromEntries(
      Object.entries(json).filter(([k]) => k !== 'messages')
    ),
  };

  // 追加写入 JSONL
  try {
    fs.appendFileSync(PROMPT_DEBUG_PATH, JSON.stringify(record) + '\n', 'utf8');
    console.log(`[prompt-debug] 已记录: ${messages.length} 条消息, system_hash=${systemHash ? systemHash.slice(0, 12) : 'N/A'}${hashChanged ? ' (已变更!)' : ''}`);
  } catch (err) {
    console.error('[prompt-debug] 写日志失败:', err.message);
  }

  // 定期截断旧记录，防止文件无限增长
  try {
    const stat = fs.statSync(PROMPT_DEBUG_PATH);
    if (stat.size > 10 * 1024 * 1024) {
      // 超过 10MB 则只保留最近 PROMPT_LOG_LIMIT 条
      const raw = fs.readFileSync(PROMPT_DEBUG_PATH, 'utf8');
      const lines = raw.trim().split('\n');
      if (lines.length > PROMPT_LOG_LIMIT) {
        fs.writeFileSync(
          PROMPT_DEBUG_PATH,
          lines.slice(-PROMPT_LOG_LIMIT).join('\n') + '\n',
          'utf8'
        );
        console.log(`[prompt-debug] 日志已截断，保留最近 ${PROMPT_LOG_LIMIT} 条`);
      }
    }
  } catch {
    // 截断失败不影响主流程
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    // 解析并清洗请求参数
    let modifiedBody = body;
    let reqModel = 'unknown';
    let reqJson = null;
    try {
      reqJson = JSON.parse(body);
      // 参数清洗后注入 Claude system 缓存断点（其余模型原样返回）
      const json = injectCacheControl(sanitizeParams(reqJson));
      reqModel = json.model || 'unknown';
      modifiedBody = JSON.stringify(json);
    } catch {
      // 不是 JSON，透传
    }

    // 输出请求体大小，方便诊断 ECONNRESET 等上游断连问题
    const bodySizeBytes = Buffer.byteLength(modifiedBody);
    const bodySizeKB = (bodySizeBytes / 1024).toFixed(1);
    const bodySizeMB = (bodySizeBytes / (1024 * 1024)).toFixed(2);
    const sizeLabel = bodySizeBytes >= 1024 * 1024 ? `${bodySizeMB} MB` : `${bodySizeKB} KB`;
    console.log(`[proxy] 请求体大小: ${sizeLabel} (${bodySizeBytes} bytes), model=${reqModel}`);

    /** 上游瞬时网络错误自动重试：仅在响应尚未回写给客户端时进行。 */
    const forwardWithRetry = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await forwardOnce();
          return;
        } catch (err) {
          const retryable = isTransientNetworkError(err)
            && !res.headersSent
            && attempt < UPSTREAM_MAX_RETRIES;
          if (!retryable) {
            console.error(`[proxy] 请求失败 (发送阶段): ${err.message}, model=${reqModel}`);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
            } else if (!res.writableEnded) {
              res.end();
            }
            return;
          }
          console.warn(`[proxy] 上游瞬时断连 (第 ${attempt + 1} 次重试): ${err.message}, model=${reqModel}`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    };

    /** 单次转发；网络阶段失败时 reject 以触发重试。 */
    const forwardOnce = () => new Promise((resolve, reject) => {
      const httpModule = TARGET_PROTOCOL === 'https:' ? https : http;

      // 构建转发请求（keep-alive Agent 复用 TLS 连接，减少握手次数）
      const options = {
        hostname: TARGET_HOST,
        port: TARGET_PORT,
        path: req.url,
        method: 'POST',
        agent: UPSTREAM_AGENT,
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers['authorization'] || '',
          'Content-Length': bodySizeBytes,
          'Host': TARGET_HOST,
        },
      };

      const proxyReq = httpModule.request(options, (proxyRes) => {
        // 边转发边收集文本，既保持流式体验，又能在结束时解析 usage
        res.writeHead(proxyRes.statusCode, proxyRes.headers);

        let collected = '';
        const isError = proxyRes.statusCode && proxyRes.statusCode >= 400;

        proxyRes.on('error', (err) => {
          console.error(`[proxy] 上游响应中断: ${err.message}, model=${reqModel}, statusCode=${proxyRes.statusCode}`);
          if (!res.writableEnded) res.end();
          resolve();
        });

        proxyRes.on('data', chunk => {
          collected += chunk.toString('utf8');
          res.write(chunk);
        });

        proxyRes.on('end', () => {
          res.end();
          if (isError) {
            console.error(`[proxy] 上游错误 ${proxyRes.statusCode}:`, collected.slice(0, 500));
          } else {
            const usage = parseUsageFromResponse(collected);
            if (usage) recordUsage(reqModel, usage);
          }
          resolve();
        });
      });

      // 网络阶段失败（DNS/TCP/TLS/断连）交给重试逻辑
      proxyReq.on('error', (err) => reject(err));
      proxyReq.end(modifiedBody);
    });

    forwardWithRetry();
  });
});

/** HTML 转义，避免模型名等内容破坏页面结构。 */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 把时间戳格式化成 HH:mm:ss。 */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 渲染 token 看板 HTML。
 * 配色与控件严格遵循蓝色系视觉设计规范:
 *   主色 #89C2FF / 奶白底 #E6F7FF / 卡片白 #ffffff / 边框 #c5d9ed / 主色深 #5da0e6
 */
function renderStatsHtml() {
  const t = stats.total;
  const promptTotal = t.cached + t.uncached;
  const cacheRate = promptTotal > 0 ? ((t.cached / promptTotal) * 100).toFixed(1) : '0.0';
  const grandTotal = promptTotal + t.output;

  // 各模型行（按总消耗降序）
  const modelRows = Object.entries(stats.models)
    .map(([name, m]) => ({ name, ...m, sum: m.cached + m.uncached + m.output }))
    .sort((a, b) => b.sum - a.sum)
    .map(m => `
        <tr>
          <td class="model-name">${esc(m.name)}</td>
          <td class="num">${numberFmt.format(m.requests)}</td>
          <td class="num cached">${numberFmt.format(m.cached)}</td>
          <td class="num uncached">${numberFmt.format(m.uncached)}</td>
          <td class="num output">${numberFmt.format(m.output)}</td>
          <td class="num total">${numberFmt.format(m.sum)}</td>
          <td class="num cost">${fmtCost(m.cost)}</td>
        </tr>`)
    .join('');

  // 最近请求明细
  const recentRows = stats.recent
    .map(r => `
        <tr>
          <td class="ts">${fmtTime(r.ts)}</td>
          <td class="model-name">${esc(r.model)}</td>
          <td class="num cached">${numberFmt.format(r.cached)}</td>
          <td class="num uncached">${numberFmt.format(r.uncached)}</td>
          <td class="num output">${numberFmt.format(r.output)}</td>
          <td class="num cost">${fmtCost(r.cost)}</td>
        </tr>`)
    .join('');

  const emptyHint = '<tr><td colspan="7" class="empty">暂无数据，等待第一次请求...</td></tr>';
  const emptyRecent = '<tr><td colspan="6" class="empty">暂无记录</td></tr>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="5">
<title>Token 消耗看板</title>
<style>
  :root {
    --primary: #89C2FF;
    --primary-deep: #5da0e6;
    --canvas: #E6F7FF;
    --surface: #ffffff;
    --border: #c5d9ed;
    --text: #2c3e50;
    --text-muted: rgba(44, 62, 80, 0.55);
    --cached: #5da0e6;
    --uncached: #e08a5d;
    --output: #4caf8e;
    --cost: #d4843e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    background: var(--canvas);
    color: var(--text);
    padding: 24px 20px;
    line-height: 1.5;
  }
  .header {
    margin-bottom: 32px;
  }
  .header h1 {
    font-size: 28px;
    font-weight: 600;
    line-height: 1.2;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .header h1::before {
    content: "";
    width: 6px;
    height: 28px;
    background: var(--primary);
    border-radius: 3px;
  }
  .header .meta {
    margin-top: 8px;
    font-size: 12px;
    color: var(--text-muted);
  }
  /* 顶部汇总卡片组 */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 40px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(137, 194, 255, 0.12);
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .card:hover {
    border-color: var(--primary);
    box-shadow: 0 4px 12px rgba(137, 194, 255, 0.25);
  }
  .card .label {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .card .value {
    font-size: 36px;
    font-weight: 600;
    line-height: 1.2;
  }
  .card .unit {
    font-size: 14px;
    color: var(--text-muted);
    margin-left: 4px;
  }
  .card.cached .value { color: var(--cached); }
  .card.uncached .value { color: var(--uncached); }
  .card.output .value { color: var(--output); }
  .card.total .value { color: var(--primary-deep); }
  .card.cost .value { color: var(--cost); }
  /* 区块标题 */
  .section-title {
    font-size: 20px;
    font-weight: 600;
    line-height: 1.3;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-title::before {
    content: "";
    width: 4px;
    height: 18px;
    background: var(--primary);
    border-radius: 2px;
  }
  /* 表格 */
  .table-wrap {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    overflow: hidden;
    margin-bottom: 40px;
    box-shadow: 0 1px 3px rgba(137, 194, 255, 0.12);
  }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    padding: 12px 16px;
    text-align: left;
    font-size: 14px;
  }
  thead th {
    background: rgba(137, 194, 255, 0.12);
    color: var(--text);
    font-weight: 600;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  tbody tr { border-bottom: 1px solid rgba(197, 217, 237, 0.5); }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: rgba(230, 247, 255, 0.6); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .model-name { font-weight: 500; }
  .ts { color: var(--text-muted); font-size: 12px; }
  .cached { color: var(--cached); }
  .uncached { color: var(--uncached); }
  .output { color: var(--output); }
  .total { color: var(--primary-deep); font-weight: 600; }
  .cost { color: var(--cost); font-weight: 600; }
  .empty { text-align: center; color: var(--text-muted); padding: 32px; }
  /* 标签 */
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 9999px;
    font-size: 10px;
    background: rgba(137, 194, 255, 0.15);
    color: var(--primary-deep);
  }
  .footer {
    text-align: center;
    font-size: 10px;
    color: rgba(44, 62, 80, 0.3);
    margin-top: 24px;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>Token 消耗看板</h1>
    <div class="meta">
      首次统计于 ${new Date(stats.startedAt).toLocaleString('zh-CN')} ·
      累计 <span class="badge">${numberFmt.format(t.requests)} 次请求</span> ·
      数据跨重启累计 · 页面每 5 秒自动刷新
    </div>
  </div>

  <div class="cards">
    <div class="card cached">
      <div class="label">命中缓存 (Cached)</div>
      <div class="value">${numberFmt.format(t.cached)}<span class="unit">tokens</span></div>
    </div>
    <div class="card uncached">
      <div class="label">未命中缓存 (Uncached)</div>
      <div class="value">${numberFmt.format(t.uncached)}<span class="unit">tokens</span></div>
    </div>
    <div class="card output">
      <div class="label">输出 (Output)</div>
      <div class="value">${numberFmt.format(t.output)}<span class="unit">tokens</span></div>
    </div>
    <div class="card total">
      <div class="label">总计 (含输入输出)</div>
      <div class="value">${numberFmt.format(grandTotal)}<span class="unit">tokens</span></div>
    </div>
    <div class="card">
      <div class="label">缓存命中率</div>
      <div class="value">${cacheRate}<span class="unit">%</span></div>
    </div>
    <div class="card cost">
      <div class="label">累计费用 (USD)</div>
      <div class="value">${fmtCost(t.cost)}</div>
    </div>
  </div>

  <div class="section-title">各模型消耗</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>模型</th>
          <th class="num">请求数</th>
          <th class="num">命中缓存</th>
          <th class="num">未命中</th>
          <th class="num">输出</th>
          <th class="num">合计</th>
          <th class="num">费用</th>
        </tr>
      </thead>
      <tbody>${modelRows || emptyHint}</tbody>
    </table>
  </div>

  <div class="section-title">最近请求明细</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>时间</th>
          <th>模型</th>
          <th class="num">命中缓存</th>
          <th class="num">未命中</th>
          <th class="num">输出</th>
          <th class="num">费用</th>
        </tr>
      </thead>
      <tbody>${recentRows || emptyRecent}</tbody>
    </table>
  </div>

  <div class="footer">LiteLLM 参数兼容代理 · Token 实时统计</div>
</body>
</html>`;
}

// 启动时先写一份空看板，方便立即打开查看
writeStatsHtml();
saveStats();

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[proxy] LiteLLM 参数兼容代理已启动`);
  console.log(`[proxy] 监听地址: http://127.0.0.1:${PROXY_PORT}`);
  console.log(`[proxy] 上游网关: http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`[proxy] 支持的模型: Claude Opus 4 / Sonnet 4 / Sonnet 5 / Haiku 4 系列 及 Gemini 系列`);
  console.log(`[proxy] 规则: Opus 4/5 / Sonnet 5 -> 移除 temperature & top_p; 其它 -> 冲突时移除 top_p`);
  console.log(`[proxy] Token 看板: ${STATS_HTML_PATH}`);
  console.log(`[proxy] 连接复用: keep-alive Agent 已启用，瞬时断连自动重试 ${UPSTREAM_MAX_RETRIES} 次`);
});
