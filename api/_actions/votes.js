// 動作：下週店家許願投票（每人每週 3 票）
import { appError, sid, num, nextWeekLabel } from '../_lib/util.js';
import { findOne, listRows, insertRow, deleteRows, countRows, listStoresForClass } from '../_lib/db.js';

export const VOTES_PER_WEEK = 3;

async function tallyVotes(classId, weekLabel) {
  const votes = await listRows('votes', { classId, filters: { week_label: weekLabel } });
  const tally = {};
  votes.forEach((vote) => {
    tally[String(vote.store_id)] = (tally[String(vote.store_id)] || 0) + 1;
  });
  return { tally, total: votes.length };
}

export const actions = {
  async getVotes(data, ctx) {
    const weekLabel = String(data.weekLabel || nextWeekLabel());
    const myVotes = await listRows('votes', { classId: ctx.classId, filters: { user_id: ctx.user.id, week_label: weekLabel } });
    const { tally } = await tallyVotes(ctx.classId, weekLabel);
    const stores = (await listStoresForClass(ctx.classId)).map((store) => ({
      storeId: sid(store.id),
      name: store.name,
      isActive: Boolean(store.is_active),
    }));
    return {
      weekLabel,
      votesPerWeek: VOTES_PER_WEEK,
      myVotes: myVotes.map((vote) => String(vote.store_id)),
      tally,
      stores,
    };
  },

  async castVote(data, ctx) {
    const weekLabel = String(data.weekLabel || nextWeekLabel());
    const store = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    if (!store.is_active) throw appError('CLOSED', '此店家已停用。');

    const existing = await findOne('votes', { class_id: ctx.classId, user_id: ctx.user.id, store_id: store.id, week_label: weekLabel });
    if (existing) throw appError('DUPLICATE', '你已投過這家店。');

    const myCount = await countRows('votes', { class_id: ctx.classId, user_id: ctx.user.id, week_label: weekLabel });
    if (myCount >= VOTES_PER_WEEK) throw appError('LIMIT', `每週只能投 ${VOTES_PER_WEEK} 票。`);

    await insertRow('votes', { class_id: ctx.classId, user_id: ctx.user.id, store_id: store.id, week_label: weekLabel });
    const { tally } = await tallyVotes(ctx.classId, weekLabel);
    return { ok: true, myVotes: [store.id].map(String), tally, remaining: VOTES_PER_WEEK - myCount - 1 };
  },

  async removeVote(data, ctx) {
    const weekLabel = String(data.weekLabel || nextWeekLabel());
    const store = await findOne('stores', { id: Number(data.storeId) }, ctx.classId);
    if (!store) throw appError('NOT_FOUND', '店家不存在。');
    await deleteRows('votes', { class_id: ctx.classId, user_id: ctx.user.id, store_id: store.id, week_label: weekLabel });
    const { tally } = await tallyVotes(ctx.classId, weekLabel);
    const myVotes = await listRows('votes', { classId: ctx.classId, filters: { user_id: ctx.user.id, week_label: weekLabel } });
    return { ok: true, myVotes: myVotes.map((vote) => String(vote.store_id)), tally, remaining: VOTES_PER_WEEK - myVotes.length };
  },
};
