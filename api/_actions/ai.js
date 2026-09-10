// 動作：AI 智慧菜單辨識（Google Gemini / OpenAI 多模態）
// 兩種模式：
//   1) 店家菜單：單一店家的品項與價格（aiRecognizeMenu）
//   2) 每月菜單：學校內訂菜單，每天日期＋店家＋品項（aiRecognizeMonthlyMenu，每月更新）
import { appError, num, round2 } from '../_lib/util.js';

const PROMPT = `你是菜單文字辨識助手。請辨識這張菜單照片上的「所有」品項（一個都不能漏、不能省略），並標出每個品項的價格與選項。
規則：
1. 只輸出一個 JSON 陣列，不要有任何其他文字、Markdown 或註解。
2. 每個品項是一個物件，格式為：
   {"name":"品項名稱","price":數字,"required":[{"group":"群組名","options":[{"name":"選項","price":加價}]}],"optional":[{"name":"選項","price":加價}]}
3. price 是該品項的「基準價」（新台幣元；有大小份時填最小份的價格）。無法辨識價格時填 0。
4. required 是「必選」選項群組：每個群組只能擇一（例如：大小、甜度、冰塊、辣度、口味、主菜）。群組內 options 的 price 是「相對基準價的加價」，基準選項填 0。若菜單把「便當(大)」「便當(小)」分開列，請整併成一個「便當」，把大小放進 required 的「大小」群組。
5. optional 是「可選」的加價或備註（可多選），例如加飯、加辣、加滷蛋、不加蔥；price 是加價金額（不加價填 0）。
6. 沒有選項時，required 與 optional 都填空陣列 []。
7. 每個品項的選項都是獨立、互不共用的（不要跨品項共用選項）。
8. 忽略照片中的標語、電話、地址等非菜單內容。
9. 若完全沒有辨識到任何品項，輸出空陣列 []。`;

function monthlyPrompt(month) {
  const [year, mon] = month.split('-');
  return `你是學校「每月菜單」文字辨識助手。請辨識這份菜單，找出「每一天」（或星期一到五）提供的餐點與價格。這份菜單的年份月份是 ${year} 年 ${Number(mon)} 月，所有日期都以此為準。
規則：
1. 只輸出一個 JSON 陣列，不要有任何其他文字、Markdown 或註解。
2. 每一天是一個物件，格式為：
   {"date":"YYYY-MM-DD","items":[{"name":"便當種類","price":數字,"dish":"當天菜色"}]}
3. date 的年份一定是 ${year} 年。若菜單只有「星期」而無日期（如「星期一 香酥雞排」），表示每週都一樣，請把 ${year} 年 ${Number(mon)} 月的每個該星期都展開成具體日期。
4. 若菜單是「日期區間」（如 8/31-9/4），請把區間內每個上學日都展開成具體日期（年份 ${year}）。
5. name 是「便當種類」的固定名稱（如「1號便當」「2號便當」「A餐」「B餐」「100元套餐」），不含每天變動的主菜。
6. dish 是「當天菜色」（主菜名稱，如「池上」「香酥雞腿」「排骨」），每天不同就每天列出；沒有主菜資訊時填空字串 ""。
7. price 必須是數字（新台幣元），無法辨識時填 0。
8. 放假/節日（如中秋節、教師節）那天不要產生 items；若完全沒有辨識到資料，輸出空陣列 []。`;
}

// 選項正規化：支援新格式（required 群組 + optional）與舊格式（options 扁平陣列）
// 一律輸出扁平陣列 [{name, price, required, group}]；required=true 表示必選（同 group 內擇一）
function normalizeItemOptions(item) {
  const out = [];
  // 必選群組
  const required = Array.isArray(item?.required) ? item.required : [];
  for (const g of required) {
    const group = String(g?.group || '').trim() || '必選';
    const opts = Array.isArray(g?.options) ? g.options : [];
    for (const o of opts) {
      const name = String(o?.name || '').trim();
      if (!name) continue;
      out.push({ name, price: num(o?.price), required: true, group });
    }
  }
  // 可選
  const optional = Array.isArray(item?.optional) ? item.optional : [];
  for (const o of optional) {
    const name = String(o?.name || '').trim();
    if (!name) continue;
    out.push({ name, price: num(o?.price), required: false, group: '' });
  }
  // 舊格式 options（字串或物件陣列）
  const legacy = Array.isArray(item?.options) ? item.options : [];
  for (const o of legacy) {
    if (typeof o === 'string') {
      const name = o.trim();
      if (name) out.push({ name, price: 0, required: false, group: '' });
      continue;
    }
    const name = String(o?.name || '').trim();
    if (!name) continue;
    out.push({ name, price: num(o?.price), required: Boolean(o?.required), group: String(o?.group || '') });
  }
  return out.slice(0, 30);
}

function normalizeItems(parsed) {
  const list = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed?.menu) ? parsed.menu : (Array.isArray(parsed?.dishes) ? parsed.dishes : [])));
  return list
    .map((item) => ({
      name: String(item?.name || '').trim(),
      price: num(item?.price),
      options: normalizeItemOptions(item),
    }))
    .filter((item) => item.name)
    .slice(0, 150);
}

// 大小變體偵測：'便當(大)'、'便當（小）'、'便當大'、'炒飯 加大' 等
const SIZE_RE = /^(.+?)[\s]*[（(]?\s*(特大|加大|大份|中份|小份|大杯|中杯|小杯|大碗|中碗|小碗|大|中|小)\s*[）)]?$/;

function parseSizeVariant(name) {
  const match = SIZE_RE.exec(name);
  if (!match || !match[1].trim()) return null;
  return { base: match[1].trim(), size: match[2] };
}

// 將「便當(大)」「便當(小)」等大小變體整併為單一品項；大小選項為必選（群組「大小」）
function mergeSizeVariants(items) {
  const groups = new Map(); // base name -> [{ item, size }]
  const standalone = [];
  for (const item of items) {
    const parsed = parseSizeVariant(item.name);
    if (!parsed) { standalone.push(item); continue; }
    if (!groups.has(parsed.base)) groups.set(parsed.base, []);
    groups.get(parsed.base).push({ item, size: parsed.size });
  }
  const out = [...standalone];
  for (const [base, entries] of groups) {
    if (entries.length < 2) {
      out.push(...entries.map((entry) => entry.item));
      continue;
    }
    // 基準價 = 最便宜的變體（通常為小份）；大份的價差作為選項加價
    const basePrice = Math.min(...entries.map((entry) => num(entry.item.price)));
    const sizeOptions = entries
      .slice()
      .sort((a, b) => num(a.item.price) - num(b.item.price))
      .map((entry) => ({ name: entry.size, price: round2(num(entry.item.price) - basePrice), required: true, group: '大小' }));
    // 合併各變體各自的選項（去重；保留其 required/group）
    const extra = [];
    const seen = new Set();
    for (const entry of entries) {
      for (const option of (entry.item.options || [])) {
        const name = typeof option === 'string' ? option : String(option?.name || '').trim();
        const price = typeof option === 'string' ? 0 : num(option?.price);
        const required = typeof option !== 'string' && Boolean(option?.required);
        const group = typeof option !== 'string' ? String(option?.group || '') : '';
        if (!name) continue;
        const key = `${name}:${price}:${required}:${group}`;
        if (seen.has(key)) continue;
        seen.add(key);
        extra.push({ name, price, required, group });
      }
    }
    out.push({ name: base, price: basePrice, options: [...sizeOptions, ...extra] });
  }
  return out;
}

function normalizeMonthly(parsed) {
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.days) ? parsed.days : (Array.isArray(parsed?.entries) ? parsed.entries : []));
  return list
    .map((entry) => ({
      date: String(entry?.date || '').trim(),
      items: (Array.isArray(entry?.items) ? entry.items : [])
        .map((item) => ({
          name: String(item?.name || '').trim(),
          price: num(item?.price),
          dish: String(item?.dish || '').trim(),
        }))
        .filter((item) => item.name)
        .slice(0, 50),
    }))
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && entry.items.length)
    .slice(0, 200);
}

// 將模型回傳文字（可能夾雜 Markdown code fence 或前後雜訊）穩健解析為 JSON
function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json|JSON)?\s*/g, '').replace(/\s*```$/g, '');
  try { return JSON.parse(t); } catch (_) { /* 繼續嘗試擷取子字串 */ }
  const match = t.match(/[\[{][\s\S]*[\]}]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) { /* 最後才拋錯 */ }
  }
  throw new Error('AI 回傳內容無法解析為 JSON');
}

function geminiError(status, message) {
  const m = String(message || '').trim();
  if (status === 401 || status === 403) return 'GEMINI_API_KEY 無效或無權限，請檢查金鑰是否正確。';
  if (status === 404) return `找不到模型（${m || '404'}），請檢查 GEMINI_MODEL 設定。`;
  if (status === 429) return 'Gemini API 配額已用盡或請求過於頻繁（429），請稍後再試或檢查方案與帳單。';
  if (status === 503 || status >= 500) return 'Gemini API 暫時過載，請稍後再試。';
  return `Gemini API 錯誤 (${status})：${m}`;
}

// 預設模型備援鏈：穩定版優先（gemini-3.6/3.5 實測穩定；3.8/3.7 最新但常回 503 過載）
const GEMINI_MODEL_CHAIN = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.7-flash'];

function geminiModels() {
  const custom = String(process.env.GEMINI_MODEL || '').trim();
  if (!custom) return GEMINI_MODEL_CHAIN;
  return [custom, ...GEMINI_MODEL_CHAIN.filter((model) => model !== custom)];
}

async function geminiParse(imageBase64, mimeType, prompt) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  const models = geminiModels();
  let lastError = '';

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
      generationConfig: { response_mime_type: 'application/json' },
    };
    // 過載(503)/限流(429)/5xx 為暫時性錯誤：每個模型最多重試 2 次（退避），再換下一個模型
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
        return extractJson(text);
      }
      let message = '';
      try { const errJson = await res.json(); message = errJson?.error?.message || ''; } catch (_) { /* 忽略 */ }
      // 金鑰錯誤：換模型也沒用，直接拋出
      if (res.status === 401 || res.status === 403) {
        throw new Error(geminiError(res.status, message));
      }
      if ((res.status === 429 || res.status === 503 || res.status >= 500) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      lastError = geminiError(res.status, message);
      break;
    }
  }
  throw new Error(lastError || 'Gemini API 暫時無法使用，請稍後再試。');
}

async function openaiParse(imageBase64, mimeType, prompt) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: '你只輸出合法的 JSON，不輸出任何其他內容。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI API 錯誤 (${res.status})`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content || '';
  return extractJson(text);
}

function validateImage(data) {
  const imageBase64 = String(data.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const mimeType = String(data.mimeType || 'image/jpeg');
  if (!imageBase64) throw appError('INVALID_INPUT', '請先上傳菜單照片或 PDF。');
  if (imageBase64.length > 8 * 1024 * 1024) throw appError('INVALID_INPUT', '檔案過大，請縮小後再試。');
  return { imageBase64, mimeType };
}

async function recognize(imageBase64, mimeType, prompt, normalizer) {
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  if (!hasGemini && !hasOpenAI) {
    throw appError('NO_AI_KEY', '尚未設定 AI 辨識金鑰（GEMINI_API_KEY 或 OPENAI_API_KEY）。');
  }

  let parsed;
  let provider = '';
  if (hasGemini) {
    try {
      parsed = await geminiParse(imageBase64, mimeType, prompt);
      provider = 'gemini';
    } catch (error) {
      if (!hasOpenAI) throw appError('AI_FAILED', `菜單辨識失敗：${error.message}。請檢查 GEMINI_API_KEY 是否有效（或用 GEMINI_MODEL 指定模型），或設定 OPENAI_API_KEY 作為備援。`);
    }
  }
  if (!parsed && hasOpenAI) {
    parsed = await openaiParse(imageBase64, mimeType, prompt);
    provider = 'openai';
  }
  return { provider, result: normalizer(parsed || []) };
}

export const actions = {
  async aiRecognizeMenu(data) {
    const { imageBase64, mimeType } = validateImage(data);
    const { provider, result } = await recognize(imageBase64, mimeType, PROMPT, normalizeItems);
    return { provider, items: mergeSizeVariants(result) };
  },

  async aiRecognizeMonthlyMenu(data) {
    const { imageBase64, mimeType } = validateImage(data);
    const month = String(data.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) throw appError('INVALID_INPUT', '請選擇菜單月份。');
    const { provider, result } = await recognize(imageBase64, mimeType, monthlyPrompt(month), normalizeMonthly);
    return { provider, entries: result };
  },
};
