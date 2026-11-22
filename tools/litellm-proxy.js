/**
 * LiteLLM 参数兼容代理
 * 在 VS Code Copilot 与 LiteLLM 网关之间做一层参数清洗，
 * 解决 Copilot 扩展的参数冲突问题。
 *
 * 已知兼容问题:
 *   - claude-opus-*: temperature 已弃用，需要移除（兼容带日期/版本后缀的模型名）
 *   - claude-sonnet-5: temperature 和 top_p 均已弃用，需要移除
 *   - claude-sonnet/haiku-4-*: temperature 和 top_p 不能同时存在，移除 top_p
 *   - gemini-*: 视觉请求需将图片转 base64 放入 image_url 字段
 *   - gemini-*: 工具调用回放需带 thought_signature，缺失时补占位签名兜底
 *
 * 附加能力:
 *   - 实时统计每次请求的 token 消耗（命中缓存 / 未命中缓存 / 输出）
 *   - 费用优先采用上游实报值（x-litellm-response-cost 响应头 / 流式 usage.cost），
 *     缺失时按本地兜底费率表估算
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
const PROXY_PORT = Number(process.env.PROXY_PORT) || 3001;

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
 *   input:     标准输入价
 *   output:    标准输出价
 *   cacheRead: 可选的缓存命中单价（缺省按 input 或 input×0.1 推导）
 */
const CACHE_INPUT_DISCOUNT = 0.1;
const CACHE_WRITE_PREMIUM = 1.25;

/**
 * 兜底费率表（仅在拿不到上游费用时用于估算）。
 * 数值由上游 x-litellm-response-cost-input / -output 响应头反推得出，会随网关调价漂移。
 * 上游实报费用（响应头或 usage.cost）优先于本表。
 */
const PRICING = {
  'claude-opus-5-5': { input: 4.0, output: 20.0 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-fable-5-2': { input: 8.0, output: 40.0 },
  // Gemini 系列
  'gemini-4-argon': { input: 2.0, output: 10.0 },
  // GPT 系列（上游对这类模型的输入侧几乎不计费，实测输入单价 ≈ 0）
  'gpt-6-sol': { input: 0, output: 10.0 },
  'gpt-6-astra': { input: 0, output: 50.0 },
  'gpt-6.1-sol': { input: 0, output: 10.0 },
  'gpt-6.1-terra': { input: 0, output: 5.0 },
  'gpt-6-luna': { input: 0, output: 0.5 },
  'gpt-5.6-sol': { input: 0, output: 20.0 },
  'gpt-5.6-terra': { input: 0, output: 12.0 },
  'gpt-5.6-luna': { input: 0, output: 1.2 },
  // 同一批模型的 global.openai.* 别名，输出价与上面一致
  'global.openai.gpt-6-sol': { input: 0, output: 10.0 },
  'global.openai.gpt-6-astra': { input: 0, output: 50.0 },
  'global.openai.gpt-6.1-sol': { input: 0, output: 10.0 },
  'global.openai.gpt-6.1-terra': { input: 0, output: 5.0 },
  'global.openai.gpt-6-luna': { input: 0, output: 0.5 },
  'global.openai.gpt-5.6-sol': { input: 0, output: 20.0 },
  'global.openai.gpt-5.6-terra': { input: 0, output: 12.0 },
  'global.openai.gpt-5.6-luna': { input: 0, output: 1.2 },
  // 其它
  'deepseek-flash': { input: 0.15, output: 0.6, cacheRead: 0 },
  'deepseek-v4-pro': { input: 0.66, output: 1.98 },
  'kimi-k3': { input: 2.14, output: 15.0 },
  'kimi-k3.1-pro': { input: 2.0, output: 10.0 },
  'glm-5.3': { input: 1.19, output: 4.18 },
  'glm-5.3-flash': { input: 0.12, output: 0.42 },
  'glm-5.3-flashx': { input: 0.3, output: 1.04 },
  'minimax-m3': { input: 0.3, output: 1.2 },
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
 *   - 若费率表给出 cacheRead（如 deepseek 缓存命中近乎免费），优先使用该单价
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
  const cacheReadPrice = Number.isFinite(p.cacheRead) ? p.cacheRead : p.input * readRate;
  const cachedCost = (u.cached / 1e6) * cacheReadPrice;
  const writeCost = (write / 1e6) * p.input * writeRate;
  const uncachedCost = (fresh / 1e6) * p.input;
  const outputCost = (u.output / 1e6) * p.output;
  return cachedCost + writeCost + uncachedCost + outputCost;
}

/**
 * 按当前费率表重算"本地估算"部分的费用，上游实报费用保持不变。
 * 旧版统计数据只有 cost 字段（全部来自本地估算），首次加载时按现行费率迁移重算；
 * 已经区分口径的数据不再重算，避免把上游实报的 token 重复计入估算。
 */
function recalculateHistoricalCosts(loadedStats) {
  for (const [model, usage] of Object.entries(loadedStats.models)) {
    if (usage.needsEstimateRecalc) {
      delete usage.needsEstimateRecalc;
      const pricing = getPricing(model);
      usage.costEstimated = pricing ? calcCost(model, usage) : 0;
    }
    usage.costUpstream = Number(usage.costUpstream) || 0;
    usage.costEstimated = Number(usage.costEstimated) || 0;
    usage.cost = usage.costUpstream + usage.costEstimated;
  }
  const models = Object.values(loadedStats.models);
  loadedStats.total.costUpstream = models.reduce((sum, usage) => sum + usage.costUpstream, 0);
  loadedStats.total.costEstimated = models.reduce((sum, usage) => sum + usage.costEstimated, 0);
  loadedStats.total.cost = models.reduce((sum, usage) => sum + usage.cost, 0);
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
    total: { cached: 0, uncached: 0, output: 0, requests: 0, cost: 0, costUpstream: 0, costEstimated: 0 },
    keySpend: 0,
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
        costUpstream: 0,
        costEstimated: 0,
        requests: 0,
        lastTs: 0,
      });
      merged.cached += Number(usage.cached) || 0;
      merged.uncached += Number(usage.uncached) || 0;
      merged.cacheWrite += Number(usage.cacheWrite) || 0;
      merged.output += Number(usage.output) || 0;
      merged.cost += Number(usage.cost) || 0;
      merged.costUpstream += Number(usage.costUpstream) || 0;
      merged.costEstimated += Number(usage.costEstimated) || 0;
      // 旧版数据没有费用口径拆分，标记为需按现行费率重算
      if (usage.costUpstream === undefined && usage.costEstimated === undefined) {
        merged.needsEstimateRecalc = true;
      }
      merged.requests += Number(usage.requests) || 0;
      merged.lastTs = Math.max(merged.lastTs, Number(usage.lastTs) || 0);
    }
    return recalculateHistoricalCosts({
      startedAt: saved.startedAt || fresh.startedAt,
      total: { ...fresh.total, ...(saved.total || {}) },
      keySpend: Number(saved.keySpend) || 0,
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
 *   total:   全局汇总 { cached, uncached, output, requests, cost, costUpstream, costEstimated }
 *   keySpend: 上游返回的密钥累计消费（x-litellm-key-spend）
 *   models:  各模型 { [model]: { cached, uncached, cacheWrite, output, cost, costUpstream, costEstimated, requests, lastTs } }
 *   recent:  最近若干次请求明细 { model, cached, uncached, output, cost, costFrom, ts }
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
 * @param {string} model 请求的模型名
 * @param {object} usage 上游返回的 usage 对象
 * @param {number} [upstreamCost] 上游实报费用（响应头 / usage.cost），命中时优先采信
 */
function recordUsage(model, usage, upstreamCost) {
  const u = extractUsage(usage);
  if (!u) return;

  const normalizedModel = normalizeModelName(model);
  const reported = Number(upstreamCost);
  const fromUpstream = Number.isFinite(reported) && reported > 0;
  const cost = fromUpstream ? reported : calcCost(normalizedModel, u);

  stats.total.cached += u.cached;
  stats.total.uncached += u.uncached;
  stats.total.output += u.output;
  stats.total.cost += cost;
  if (fromUpstream) {
    stats.total.costUpstream = (stats.total.costUpstream || 0) + cost;
  } else {
    stats.total.costEstimated = (stats.total.costEstimated || 0) + cost;
  }
  stats.total.requests += 1;

  const m = (stats.models[normalizedModel] ??= {
    cached: 0,
    uncached: 0,
    output: 0,
    cost: 0,
    costUpstream: 0,
    costEstimated: 0,
    requests: 0,
    lastTs: 0,
  });
  m.cached += u.cached;
  m.uncached += u.uncached;
  m.cacheWrite = (m.cacheWrite || 0) + (u.cacheWrite || 0);
  m.output += u.output;
  m.cost += cost;
  if (fromUpstream) {
    m.costUpstream = (m.costUpstream || 0) + cost;
  } else {
    m.costEstimated = (m.costEstimated || 0) + cost;
  }
  m.requests += 1;
  m.lastTs = Date.now();

  stats.recent.unshift({
    model: normalizedModel,
    ...u,
    cost,
    costFrom: fromUpstream ? 'upstream' : 'estimated',
    ts: Date.now(),
  });
  if (stats.recent.length > RECENT_LIMIT) stats.recent.length = RECENT_LIMIT;

  if (!/embed/i.test(normalizedModel)) {
    console.log(
      `[stats] ${normalizedModel} 命中缓存=${u.cached} 未命中=${u.uncached} 输出=${u.output} 费用=$${cost.toFixed(4)} (${fromUpstream ? '上游实报' : '本地估算'})`
    );
  }

  writeStatsHtml();
  saveStats();
}

/**
 * 从流式 (SSE) 或整段 JSON 响应文本中尽量解析出 usage 与上游费用。
 *   - OpenAI 格式流式的最后一个 chunk 会带 usage（可能含 cost 字段）
 *   - Anthropic 格式流式的 usage 出现在 message_start / message_delta 中，不带费用
 * @returns {{usage: object, cost: number} | null}
 */
function parseUsageFromResponse(text) {
  const pick = (usage) => {
    if (!usage) return null;
    // LiteLLM 在 OpenAI 格式流式 usage 中会追加 cost 字段
    return { usage, cost: Number(usage.cost) || 0 };
  };

  // 先尝试整段 JSON（非流式）
  try {
    const json = JSON.parse(text);
    if (json.usage) return pick(json.usage);
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
      if (obj.usage) found = pick(obj.usage) ?? found; // 取最后一个带 usage 的 chunk
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
 *   opus-*:                     temperature 已弃用（全系移除）
 *   opus-4-7 / opus-4-8 / opus-5+: 追加移除 top_p
 *   sonnet-5:                   temperature 和 top_p 均已弃用
 *   其它(sunset/haiku):  temperature 和 top_p 不能同时存在
 *   gemini-*:            无需特殊参数清洗，透传即可
 *
 * 注意：模型名可能带日期或版本后缀（如 claude-opus-4-8-20251101-v1:0），
 * 因此匹配时不能用 `$` 锚定，需用 `\b` 或前缀匹配。
 */
function sanitizeParams(json) {
  const model = json.model || 'unknown';
  const isOpus = /opus/i.test(model);
  const isOpusNoTopP = /opus-(?:4-[789]|[5-9])/i.test(model);
  const isSonnet5 = /sonnet-5\b/i.test(model);
  const isGemini = /^gemini/i.test(model);

  // 流式请求默认不返回 usage，需显式开启 include_usage 才能在 SSE 末尾拿到统计
  if (json.stream === true) {
    json.stream_options = { ...(json.stream_options || {}), include_usage: true };
  }

  // Gemini 系列无需额外参数清洗，透传即可
  if (isGemini) return json;

  // Opus 全系：temperature 已弃用，移除；4.7/4.8/5+ 同时移除 top_p
  if (isOpus) {
    if (json.temperature !== undefined) {
      delete json.temperature;
      console.log(`[proxy] 已移除 temperature (model=${model})`);
    }
    if (isOpusNoTopP && json.top_p !== undefined) {
      delete json.top_p;
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
    }
    return json;
  }

  // 其它模型（Sonnet / Haiku）：temperature 和 top_p 不能同时存在
  if (json.temperature !== undefined && json.top_p !== undefined) {
    delete json.top_p;
  }

  return json;
}

/**
 * Gemini thought signature（思维签名）占位值。
 * Google 文档给出的“跳过校验”占位串，缺失真签名时用它兜底，
 * 代价是模型会丢失该轮的工具调用思考上下文（详见 injectThoughtSignatures）。
 */
const DUMMY_THOUGHT_SIGNATURE = Buffer.from('skip_thought_signature_validator').toString('base64');

/**
 * Gemini 工具调用的思维签名兼容处理
 *
 * 背景（实测结论）:
 *   - Gemini 3/4 回放 functionCall 历史时必须原样带回 thoughtSignature，否则 400。
 *   - 该签名不属于 OpenAI 规范字段，网关响应里放在
 *     `message.provider_specific_fields.reasoning_details`（或 delta 顶层 reasoning_details），
 *     而请求侧只认 assistant 消息顶层的 `reasoning_details`，且 `text` 必须等于工具名。
 *   - 只有“末尾悬空”的那批 functionCall 会被校验：即最后一条带 tool_calls 的 assistant
 *     之后全是 tool 结果（或没有后续消息）时才需要签名；后面接了新的 user 消息就不再校验。
 *
 * 因此这里做两件事:
 *   1. 把 provider_specific_fields.reasoning_details 提升到顶层，
 *      修复“客户端原样回传响应对象仍然 400”的问题；
 *   2. 缺失签名时补占位签名，避免整条请求失败（机器人自己会回传真签名，这里只是兜底）。
 */
function injectThoughtSignatures(json) {
  const model = String(json?.model || '');
  // 只有 Gemini 系模型校验 thought signature
  if (!/gemini/i.test(model)) return json;

  const messages = json.messages;
  if (!Array.isArray(messages) || messages.length === 0) return json;

  // 1) 签名从 provider_specific_fields 提升到消息顶层
  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant') continue;
    const nested = msg.provider_specific_fields?.reasoning_details;
    if (!Array.isArray(nested) || nested.length === 0) continue;
    const own = msg.reasoning_details;
    if (!Array.isArray(own) || own.length === 0) {
      msg.reasoning_details = nested;
      console.log(`[proxy] 已把 provider_specific_fields.reasoning_details 提升到顶层 (model=${model})`);
    }
  }

  // 2) 只处理末尾悬空的 functionCall 段
  let targetIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) return json;

  const tail = messages.slice(targetIndex + 1);
  const dangling = tail.length === 0 || tail.every(m => m?.role === 'tool');
  if (!dangling) return json;

  const target = messages[targetIndex];
  const firstToolName = target.tool_calls[0]?.function?.name || 'tool';
  const entries = Array.isArray(target.reasoning_details) ? target.reasoning_details : [];
  const signed = entries.find(e => e && typeof e.signature === 'string' && e.signature);

  if (!signed) {
    target.reasoning_details = [{
      type: 'tool',
      text: firstToolName,
      signature: DUMMY_THOUGHT_SIGNATURE,
    }];
    console.log(
      `[proxy] 已补占位 thought_signature (model=${model}, tool=${firstToolName})，该轮工具思考上下文将丢失`
    );
    return json;
  }

  // 网关按 text 匹配工具名，名称不一致同样会 400
  if (signed.type === 'tool' && signed.text !== firstToolName) {
    signed.text = firstToolName;
    console.log(`[proxy] 已修正 thought_signature 的 text -> ${firstToolName} (model=${model})`);
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
      // 参数清洗 → Gemini 思维签名兼容 → Claude system 缓存断点（其余模型原样返回）
      const json = injectCacheControl(injectThoughtSignatures(sanitizeParams(reqJson)));
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
        // LiteLLM 非流式响应会带上权威费用；流式时该头在生成前发出，恒为 0
        const headerCost = Number(proxyRes.headers['x-litellm-response-cost']) || 0;
        // 该密钥在上游的累计消费，可用于核对本地累计是否偏离
        const keySpend = Number(proxyRes.headers['x-litellm-key-spend']);
        if (Number.isFinite(keySpend) && keySpend > 0) stats.keySpend = keySpend;

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
            const parsed = parseUsageFromResponse(collected);
            // 上游实报优先：usage.cost（OpenAI 流式）> 响应头（非流式）；都没有则本地估算
            if (parsed) recordUsage(reqModel, parsed.usage, parsed.cost || headerCost);
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
          <td class="num cost" title="上游实报 ${fmtCost(m.costUpstream || 0)} · 本地估算 ${fmtCost(m.costEstimated || 0)}">${fmtCost(m.cost)}</td>
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
          <td class="num cost" title="${r.costFrom === 'upstream' ? '上游实报' : '本地估算'}">${fmtCost(r.cost)}</td>
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
  .card .note {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 6px;
    white-space: nowrap;
  }
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
      上游密钥累计消费 <span class="badge">${fmtCost(stats.keySpend || 0)}</span> ·
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
      <div class="note">上游实报 ${fmtCost(t.costUpstream || 0)} · 本地估算 ${fmtCost(t.costEstimated || 0)}</div>
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
  console.log(`[proxy] Token 看板: ${STATS_HTML_PATH}`);
});
