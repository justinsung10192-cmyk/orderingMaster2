// 動作：AI 智慧菜單辨識（Google Gemini / OpenAI 多模態）
// 兩種模式：
//   1) 店家菜單：單一店家的品項與價格（aiRecognizeMenu）
//   2) 每月菜單：學校內訂菜單，每天日期＋店家＋品項（aiRecognizeMonthlyMenu，每月更新）
import { appError, num } from '../_lib/util.js';

const PROMPT = `你是菜單文字辨識助手。請辨識這張菜單照片上的所有「品項名稱」與「價格」。
規則：
1. 只輸出一個 JSON 陣列，不要有任何其他文字、Markdown 或註解。
2. 每個品項是一個物件，格式為：
   {"name":"品項名稱","price":數字,"options":["選項1","選項2"]}
3. price 必須是數字（新台幣元，整數或小數皆可），無法辨識價格時填 0。
4. options 是該品項可選擇的客製選項（如甜度、冰塊、加料、辣度等）的字串陣列；沒有選項時為空陣列 []。
5. 忽略照片中的標語、電話、地址等非菜單內容。
6. 若完全沒有辨識到任何品項，輸出空陣列 []。`;

const MONTHLY_PROMPT = `你是學校「每月菜單」文字辨識助手。請辨識這份菜單，找出「每一天」（或星期一到五）提供的餐點與價格。
規則：
1. 只輸出一個 JSON 陣列，不要有任何其他文字、Markdown 或註解。
2. 每一天是一個物件，格式為：
   {"date":"YYYY-MM-DD","items":[{"name":"餐點名稱","price":數字,"options":["選項"]}]}
3. date 用西元 YYYY-MM-DD。若菜單只有「星期」而無日期（如「星期一 香酥雞排」），表示每週都一樣，請把當月份每個該星期都展開成具體日期。
4. 若菜單是「日期區間」（如 8/31-9/4），請把區間內每個上學日都展開成具體日期。
5. 若有多種價位/編號（如 1號/2號/3號、A餐/B餐、100元/85元/75元），items 要分開列出，名稱帶上編號或餐名（如「1號 池上」）。
6. price 必須是數字（新台幣元），無法辨識時填 0；options 是客製選項字串陣列，沒有則為空陣列 []。
7. 放假/節日（如中秋節、教師節）那天不要產生 items；若完全沒有辨識到資料，輸出空陣列 []。`;

function normalizeItems(parsed) {
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
  return list
    .map((item) => ({
      name: String(item?.name || '').trim(),
      price: num(item?.price),
      options: (Array.isArray(item?.options) ? item.options : []).map((option) => String(option).trim()).filter(Boolean).slice(0, 30),
    }))
    .filter((item) => item.name)
    .slice(0, 100);
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
          options: (Array.isArray(item?.options) ? item.options : []).map((option) => String(option).trim()).filter(Boolean).slice(0, 30),
        }))
        .filter((item) => item.name)
        .slice(0, 50),
    }))
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && entry.items.length)
    .slice(0, 200);
}

async function geminiParse(imageBase64, mimeType, prompt) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  // 預設 gemini-3.7-flash（gemini-1.5 / 2.0 / 2.5 均已停用），可透過 GEMINI_MODEL 覆寫
  const model = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
    generationConfig: { response_mime_type: 'application/json' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini API 錯誤 (${res.status})`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return JSON.parse(text);
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
  return JSON.parse(text);
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
    return { provider, items: result };
  },

  async aiRecognizeMonthlyMenu(data) {
    const { imageBase64, mimeType } = validateImage(data);
    const { provider, result } = await recognize(imageBase64, mimeType, MONTHLY_PROMPT, normalizeMonthly);
    return { provider, entries: result };
  },
};
