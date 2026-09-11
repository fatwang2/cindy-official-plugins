/**
 * Web Search · 电子脑 —— Cindy 内置网页搜索意识(cindy + network 槽)。
 *
 * 四条 Provider 路径严格分账:
 * - cindy:Cindy Desktop 主机代办 -> LiteLLM /v1/messages -> 模型原生 Web Search，
 *   使用 Cindy AI 额度；
 * - brave:network 槽 -> Brave，使用用户自己的 Brave Key；
 * - tavily:network 槽 -> Tavily，使用用户自己的 Tavily Key；
 * - search1api:network 槽 -> Search1API，使用用户自己的 Search1API Key。
 *
 * 未指定 Provider 时只读取普通偏好:
 * - cindyAiEnabled 缺省 true -> cindy；
 * - 显式关闭后 -> byoDefaultProvider(缺省 brave)。
 * 任一路失败都原样返回，不跨 Provider fallback，避免静默消耗另一套凭证。
 */

/* global cindy */

var BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
var TAVILY_URL = 'https://api.tavily.com/search';
var SEARCH1API_URL = 'https://api.search1api.com/search';

function clampLimit(n) {
  var v = typeof n === 'number' && isFinite(n) ? Math.floor(n) : 5;
  return Math.min(10, Math.max(1, v));
}

function isByoProvider(value) {
  return value === 'brave' || value === 'tavily' || value === 'search1api';
}

async function readSearchPrefs() {
  var prefs = {
    cindyAiEnabled: true,
    byoDefaultProvider: 'brave',
  };
  var response = await fetch('/kv');
  if (!response.ok) throw new Error('搜索偏好读取失败');
  var kv = await response.json();
  if (!kv || typeof kv !== 'object' || Array.isArray(kv)) {
    throw new Error('搜索偏好格式无效');
  }
  if (typeof kv.cindyAiEnabled === 'boolean') prefs.cindyAiEnabled = kv.cindyAiEnabled;
  if (isByoProvider(kv.byoDefaultProvider)) {
    prefs.byoDefaultProvider = kv.byoDefaultProvider;
  }
  return prefs;
}

/** Cindy AI:主机固定搜索模型、工具与托管凭证，插件只递查询意图。 */
async function searchCindy(query, limit, callId, callerTool) {
  try {
    return await cindy.send({
      type: 'cindy-request',
      kind: 'search_web',
      query: query,
      limit: limit,
      provider: 'cindy',
      callId: callId,
      callerTool: callerTool,
    });
  } catch (e) {
    return { ok: false, message: 'Cindy AI 搜索服务暂时不可用，请稍后再试' };
  }
}

/** Brave:GET + query 参数，Key 由主机注入 X-Subscription-Token。 */
async function searchBrave(query, limit) {
  var url = BRAVE_URL + '?q=' + encodeURIComponent(query) + '&count=' + limit;
  var r = await cindy.fetch({ url: url, headers: { Accept: 'application/json' } });
  if (!r.ok) return r;
  if (r.status !== 200) {
    return { ok: false, message: 'Brave 返回 HTTP ' + r.status + ':' + r.body.slice(0, 200) };
  }
  var data = JSON.parse(r.body);
  var items = (data.web && data.web.results) || [];
  return {
    ok: true,
    provider: 'brave',
    results: items.slice(0, limit).map(function (it) {
      return { title: it.title, url: it.url, snippet: it.description || '' };
    }),
  };
}

/** Tavily BYO:POST JSON，Key 由主机注入 Authorization:Bearer。 */
async function searchTavily(query, limit) {
  var r = await cindy.fetch({
    url: TAVILY_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: query,
      max_results: limit,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
  });
  if (!r.ok) return r;
  if (r.status !== 200) {
    return { ok: false, message: 'Tavily 返回 HTTP ' + r.status + ':' + r.body.slice(0, 200) };
  }
  var data = JSON.parse(r.body);
  var items = data.results || [];
  return {
    ok: true,
    provider: 'tavily',
    results: items.slice(0, limit).map(function (it) {
      return { title: it.title, url: it.url, snippet: it.content || '' };
    }),
  };
}

/** Search1API:POST JSON，Key 由主机注入 Authorization:Bearer，引擎不传走 API 默认。 */
async function searchSearch1api(query, limit) {
  var r = await cindy.fetch({
    url: SEARCH1API_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: query,
      max_results: limit,
      crawl_results: 0,
    }),
  });
  if (!r.ok) return r;
  // Search1API 的公开错误契约把 /search 的 404 定义为“搜索完成但无结果”，
  // 对搜索工具来说应返回空列表，不是服务故障:
  // https://www.search1api.com/docs/essentials/error-handling#treat-a-search-404-as-zero-results
  // 其余状态给用户可直接执行的下一步，不裸抛响应正文或 HTTP 状态码。
  if (r.status === 404) return { ok: true, provider: 'search1api', results: [] };
  if (r.status === 401) {
    return { ok: false, message: 'Search1API API Key 无效。请到插件详情页更新 Key 后重试。' };
  }
  // 公开错误契约中 402 同时覆盖按次付款挑战和账号 credits 不足。
  if (r.status === 402) {
    return {
      ok: false,
      message: 'Search1API 需要完成付款或补充 credits。请前往 Search1API 控制台检查账号余额后重试。',
    };
  }
  if (r.status === 403) {
    return { ok: false, message: 'Search1API 拒绝了请求。请检查账号权限或套餐后重试。' };
  }
  if (r.status === 429) {
    return { ok: false, message: 'Search1API 请求过于频繁。请稍后再试。' };
  }
  if (r.status === 400 || r.status === 422) {
    return { ok: false, message: 'Search1API 未接受本次搜索参数。请换一个搜索关键词后重试。' };
  }
  if (r.status >= 500) {
    return { ok: false, message: 'Search1API 服务暂时不可用。请稍后再试。' };
  }
  if (r.status >= 400 && r.status < 500) {
    return { ok: false, message: 'Search1API 未接受本次请求。请检查账号状态或联系 Search1API 支持。' };
  }
  if (r.status !== 200) {
    return {
      ok: false,
      message: 'Search1API 返回了无法处理的响应。请稍后再试；若问题持续，请联系 Search1API 支持。',
    };
  }

  var data;
  try {
    data = JSON.parse(r.body);
  } catch (_err) {
    return { ok: false, message: 'Search1API 返回了无法解析的响应。请稍后再试。' };
  }
  if (!data || !Array.isArray(data.results)) {
    return { ok: false, message: 'Search1API 返回的结果格式不符合预期。请稍后再试。' };
  }
  return {
    ok: true,
    provider: 'search1api',
    results: data.results.slice(0, limit).map(function (it) {
      return { title: it.title, url: it.link || it.url || '', snippet: it.snippet || '' };
    }),
  };
}

function searchByo(provider, query, limit) {
  if (provider === 'tavily') return searchTavily(query, limit);
  if (provider === 'search1api') return searchSearch1api(query, limit);
  return searchBrave(query, limit);
}

async function searchWeb(args, callId, callerTool) {
  var query = args && typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, message: 'query 不能为空' };
  if (query.length > 2000) return { ok: false, message: 'query 过长(上限 2000 字符)' };
  var limit = clampLimit(args.limit);
  var provider = args && args.provider;

  if (provider !== undefined && provider !== 'cindy' && !isByoProvider(provider)) {
    return { ok: false, message: 'provider 只支持 cindy / brave / tavily / search1api' };
  }
  if (provider === 'cindy') return searchCindy(query, limit, callId, callerTool);
  if (isByoProvider(provider)) return searchByo(provider, query, limit);

  var prefs;
  try {
    prefs = await readSearchPrefs();
  } catch (e) {
    return { ok: false, message: '搜索偏好读取失败，请稍后重试或显式选择搜索源' };
  }
  return prefs.cindyAiEnabled
    ? searchCindy(query, limit, callId, callerTool)
    : searchByo(prefs.byoDefaultProvider, query, limit);
}

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  if (msg.tool !== 'search_web') {
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: '未知工具:' + msg.tool });
    return;
  }
  try {
    var r = await searchWeb(msg.args || {}, msg.callId, msg.tool);
    if (r.ok) {
      cindy.send({
        type: 'tool-result',
        callId: msg.callId,
        ok: true,
        result: {
          provider: r.provider,
          results: r.results,
          note: '经 ' + r.provider + ' 搜索到 ' + r.results.length + ' 条结果',
        },
      });
    } else {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: r.message });
    }
  } catch (err) {
    cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      message: '搜索失败:' + (err && err.message ? err.message : String(err)),
    });
  }
});
