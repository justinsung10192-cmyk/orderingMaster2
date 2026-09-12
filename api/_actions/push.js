// 動作：推播訂閱管理
import { appError } from '../_lib/util.js';
import { supabase } from '../_lib/db.js';
import { sendPushToClass, pushConfigured } from '../_lib/push.js';

export const actions = {
  async pushSubscribe(data, ctx) {
    const endpoint = String(data.endpoint || '').trim();
    const p256dh = String(data.keys?.p256dh || '').trim();
    const auth = String(data.keys?.auth || '').trim();
    if (!/^https:\/\//.test(endpoint)) throw appError('INVALID_INPUT', '推播訂閱資料不正確。');
    if (!p256dh || !auth) throw appError('INVALID_INPUT', '推播訂閱資料不完整。');
    const deviceLabel = String(data.deviceLabel || '').slice(0, 60);

    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        class_id: ctx.classId,
        user_id: ctx.user.id,
        endpoint,
        p256dh,
        auth,
        device_label: deviceLabel,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    );
    if (error) throw appError('DB_ERROR', '訂閱資料儲存失敗。');
    return { ok: true };
  },

  async pushUnsubscribe(data, ctx) {
    const endpoint = String(data.endpoint || '').trim();
    if (endpoint) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', ctx.user.id);
    }
    return { ok: true };
  },

  // 管理員主動發送全服推播通知
  async adminBroadcast(data, ctx) {
    const title = String(data.title || '訂餐通通知').trim().slice(0, 60) || '訂餐通通知';
    const body = String(data.body || '').trim().slice(0, 200);
    if (!body) throw appError('INVALID_INPUT', '請輸入通知內容。');
    if (!pushConfigured()) throw appError('NOT_CONFIGURED', '伺服器尚未設定推播金鑰，無法發送通知。');
    const result = await sendPushToClass(ctx.classId, { title, body, url: '/' });
    return { ok: true, sent: result.sent, attempted: result.attempted };
  },
};
