// 動作：AI 智慧菜單辨識（Google Gemini 1.5 Flash / OpenAI GPT-4o-mini 多模態）
// 上傳圖片 → Base64 → 多模態 API → 嚴格結構化 JSON，供管理者預覽微調後寫入。
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

async function recognizeWithGemini(imageBase64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
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
  return normalizeItems(JSON.parse(text));
}

async function recognizeWithOpenAI(imageBase64, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: '你只輸出合法的 JSON，不輸出任何其他內容。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
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
  return normalizeItems(JSON.parse(text));
}

export const actions = {
  async aiRecognizeMenu(data) {
    const imageBase64 = String(data.imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
    const mimeType = String(data.mimeType || 'image/jpeg');
    if (!imageBase64) throw appError('INVALID_INPUT', '請先上傳菜單照片。');
    if (imageBase64.length > 8 * 1024 * 1024) throw appError('INVALID_INPUT', '圖片過大，請壓縮後再試。');

    const hasGemini = Boolean(process.env.GEMINI_API_KEY);
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
    if (!hasGemini && !hasOpenAI) {
      throw appError('NO_AI_KEY', '尚未設定 AI 辨識金鑰（GEMINI_API_KEY 或 OPENAI_API_KEY）。');
    }

    let items;
    let provider = '';
    if (hasGemini) {
      try {
        items = await recognizeWithGemini(imageBase64, mimeType);
        provider = 'gemini';
      } catch (error) {
        if (!hasOpenAI) throw appError('AI_FAILED', `菜單辨識失敗：${error.message}`);
      }
    }
    if (!items && hasOpenAI) {
      items = await recognizeWithOpenAI(imageBase64, mimeType);
      provider = 'openai';
    }
    if (!items) items = [];

    return { provider, items };
  },
};
