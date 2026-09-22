// 動作：RFID 卡片感應（等同掃碼核銷）與卡片管理
// D1 Mini + RC522 感應到的卡片 UID 透過此模組解析成「座號 → 餐點資訊」。
import { appError, sid, randomCode } from '../_lib/util.js';
import { findOne, listRows, listRowsIn, insertRow, deleteRows, supabase, getAppSetting, setAppSetting } from '../_lib/db.js';
import { resolveContext } from './verification.js';

// 同張卡在 X 毫秒內不重複處理（卡未移走只記一次）
const DEBOUNCE_MS = 2500;
// 最近 X 毫秒內有活動（感應/心跳）即視為裝置在線
const HEARTBEAT_WINDOW_MS = 45000;

// 讀取或產生裝置密鑰（D1 Mini 韌體需填入同一密鑰）
async function ensureDeviceSecret(classId) {
  const secret = await getAppSetting(classId, 'rfid_device_secret');
  if (secret) return secret;
  const generated = randomCode(16);
  await setAppSetting(classId, 'rfid_device_secret', generated);
  return generated;
}

async function verifyDeviceSecret(classId, secret) {
  if (!secret || typeof secret !== 'string') return false;
  const row = await findOne('app_settings', { class_id: classId, key: 'rfid_device_secret' });
  return Boolean(row && row.value && row.value === secret);
}

// 記錄裝置最後活動時間（感應或心跳都算）
function touchLastSeen(classId) {
  return supabase.from('app_settings').upsert(
    { class_id: classId, key: 'rfid_last_seen', value: String(Date.now()) },
    { onConflict: 'class_id,key' },
  );
}

async function isDeviceOnline(classId) {
  const t = await getAppSetting(classId, 'rfid_last_seen');
  return Boolean(t && Date.now() - Number(t) < HEARTBEAT_WINDOW_MS);
}

// UID 正規化：去空白、去冒號/減號/逗號、轉大寫
function normalizeUid(uid) {
  return String(uid || '').trim().toUpperCase().replace(/[\s:,-]/g, '');
}

export const actions = {
  // 管理員：RFID 設定（裝置密鑰；首次呼叫自動產生，不依賴卡片表）
  async rfidGetConfig(data, ctx) {
    const secret = await ensureDeviceSecret(ctx.classId);
    const deviceOnline = await isDeviceOnline(ctx.classId);
    return { secret, enabled: true, deviceOnline };
  },

  // 管理員：已綁定卡片列表（含座號、姓名）
  async rfidListCards(data, ctx) {
    const cards = await listRows('rfid_cards', { classId: ctx.classId });
    const userIds = [...new Set(cards.map((c) => c.user_id))];
    const users = userIds.length ? await listRowsIn('users', 'id', userIds, { classId: ctx.classId }) : [];
    const userById = new Map(users.map((u) => [String(u.id), u]));
    return {
      cards: cards.map((c) => {
        const u = userById.get(String(c.user_id));
        return {
          id: sid(c.id),
          uid: c.uid,
          userId: sid(c.user_id),
          seatNo: u?.seat_no || '',
          studentNo: u?.student_no || '',
          name: u?.student_name || '已刪除帳號',
        };
      }),
    };
  },

  // 管理員：開始註冊（先選座號，再感應新卡片完成綁定）
  async rfidStartRegister(data, ctx) {
    const raw = String(data.seatNo || '').trim();
    if (!raw) throw appError('INVALID_INPUT', '請輸入座號或學號。');
    const candidates = [raw];
    if (/^\d+$/.test(raw)) {
      const padded = raw.padStart(2, '0');
      if (padded !== raw) candidates.push(padded);
    }
    let student = null;
    for (const no of candidates) {
      student = await findOne('users', { seat_no: no }, ctx.classId);
      if (student) break;
      student = await findOne('users', { student_no: no }, ctx.classId);
      if (student) break;
    }
    if (!student) throw appError('NOT_FOUND', '找不到此座號／學號的同學。');

    await supabase.from('rfid_pending').upsert(
      { class_id: ctx.classId, user_id: student.id, seat_no: student.seat_no, created_at: new Date().toISOString() },
      { onConflict: 'class_id' },
    );
    return { ok: true, seatNo: student.seat_no, name: student.student_name };
  },

  // 管理員：取消註冊
  async rfidCancelRegister(data, ctx) {
    await deleteRows('rfid_pending', { class_id: ctx.classId });
    return { ok: true };
  },

  // 管理員：移除卡片綁定
  async rfidUnregisterCard(data, ctx) {
    const uid = normalizeUid(data.uid);
    if (!uid) throw appError('INVALID_INPUT', '請提供卡片 UID。');
    await deleteRows('rfid_cards', { class_id: ctx.classId, uid });
    return { ok: true };
  },

  // 裝置（D1 Mini）：感應卡片 → 執行綁定或解析使用者。需裝置密鑰。
  async rfidScan(data, ctx) {
    const uid = normalizeUid(data.uid);
    if (!uid) throw appError('INVALID_INPUT', '卡片 UID 為空。');
    const classId = String(data.stationId || '').trim();
    if (!classId) throw appError('INVALID_INPUT', '缺少站台（班級）識別碼。');
    if (!(await verifyDeviceSecret(classId, data.secret))) throw appError('FORBIDDEN', '裝置密鑰不正確。');

    // 並行：記錄在線 + 去抖檢查 + 待註冊 + 卡片綁定（一次往返）
    const [, recentRes, pending, card] = await Promise.all([
      touchLastSeen(classId),
      supabase.from('rfid_events').select('created_at').eq('class_id', classId).eq('uid', uid).order('id', { ascending: false }).limit(1),
      findOne('rfid_pending', { class_id: classId }),
      findOne('rfid_cards', { class_id: classId, uid }),
    ]);

    // 去抖：同張卡在 DEBOUNCE_MS 內不重複處理（卡未移走只記一次）
    const recent = recentRes && recentRes.data;
    if (!recentRes.error && recent && recent[0]) {
      const age = Date.now() - new Date(recent[0].created_at).getTime();
      if (age < DEBOUNCE_MS) return { ok: true, duplicate: true, uid };
    }

    // 1) 有「待註冊」→ 綁定這張卡片
    if (pending) {
      await supabase.from('rfid_cards').upsert(
        { class_id: classId, uid, user_id: pending.user_id, registered_at: new Date().toISOString() },
        { onConflict: 'class_id,uid' },
      );
      await deleteRows('rfid_pending', { class_id: classId });
      const student = await findOne('users', { id: Number(pending.user_id) }, classId);
      await insertRow('rfid_events', {
        class_id: classId, uid, user_id: pending.user_id,
        seat_no: pending.seat_no, student_name: student?.student_name || '', kind: 'registered',
      });
      return { ok: true, type: 'registered', uid, seatNo: pending.seat_no, name: student?.student_name || '' };
    }

    // 2) 一般掃描 → 解析使用者
    if (!card) {
      await insertRow('rfid_events', { class_id: classId, uid, kind: 'unknown' });
      throw appError('NOT_FOUND', '未綁定的卡片。');
    }
    const student = await findOne('users', { id: Number(card.user_id) }, classId);
    if (!student) throw appError('NOT_FOUND', '卡片對應的帳號不存在。');
    await insertRow('rfid_events', {
      class_id: classId, uid, user_id: card.user_id,
      seat_no: student.seat_no, student_name: student.student_name, kind: 'scan',
    });
    return { ok: true, type: 'scanned', uid, seatNo: student.seat_no, name: student.student_name };
  },

  // 裝置（D1 Mini）：心跳，回報裝置仍在線。需裝置密鑰。
  async rfidHeartbeat(data, ctx) {
    const classId = String(data.stationId || '').trim();
    if (!classId) throw appError('INVALID_INPUT', '缺少站台（班級）識別碼。');
    if (!(await verifyDeviceSecret(classId, data.secret))) throw appError('FORBIDDEN', '裝置密鑰不正確。');
    await touchLastSeen(classId);
    return { ok: true };
  },

  // 管理員（手機）：輪詢最新感應事件，附上完整核銷內容與裝置在線狀態
  async rfidPoll(data, ctx) {
    const sinceId = Number(data.sinceId) || 0;
    const [events, lastSeen] = await Promise.all([
      listRows('rfid_events', { classId: ctx.classId, order: 'id', orderAscending: false, limit: 10 }),
      getAppSetting(ctx.classId, 'rfid_last_seen'),
    ]);
    const fresh = events.filter((e) => Number(e.id) > sinceId).sort((a, b) => Number(a.id) - Number(b.id));
    let lastId = sinceId;
    const out = [];
    for (const e of fresh) {
      if (Number(e.id) > lastId) lastId = Number(e.id);
      const item = { id: sid(e.id), kind: e.kind, uid: e.uid || '', seatNo: e.seat_no || '', studentName: e.student_name || '', createdAt: e.created_at };
      if (e.kind === 'scan' && e.user_id) {
        try { item.context = await resolveContext(ctx.classId, e.user_id); } catch (_) { /* 略 */ }
      }
      out.push(item);
    }
    return {
      events: out,
      lastId: sid(lastId),
      deviceOnline: Boolean(lastSeen && Date.now() - Number(lastSeen) < HEARTBEAT_WINDOW_MS),
    };
  },
};
