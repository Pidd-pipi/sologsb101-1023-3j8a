/**
 * 工位调度核心（scheduler.ts）
 *
 * 不变量（全部在 IndexedDB 跨表事务内完成，多标签窗口并发也成立）：
 *  1. 一个任务必须同时拿到「揉捻机 + 焙火炉」两类工位才进入 HELD，绝不占一半；
 *  2. 按 seq（提交先后）FIFO 分配，队头不满足时后到者一律等待（队头阻塞，不许插队）；
 *  3. HELD 占用带 30s 租约：本窗口 10s 心跳续租；页面关闭 pagehide 立即释放，
 *     僵死占用由 5s 清扫兜底超时释放——都回 QUEUED 并保留原 seq（原队位）；
 *  4. 保存失败 → FAILED，释放工位、保留原队位，由操作人显式「重试」；
 *  5. 只要存在任何未确认的 HELD，confirm 之外的工序推进一律被闸门拦截（见 gating.ts）。
 *
 * 会话模型：提交调度单的浏览器窗口是「等候会话」；每个窗口只把自己会话名下的
 * QUEUED 提升为 HELD（客户端认领）。窗口关闭后单子成为无主 QUEUED，在调度台
 * 「重试」即可被任意窗口重新认领，名次不变。
 */
import { db, createId, ID_PREFIX, nowIso } from './db';
import {
  ACTIVE_DISPATCH_STATES,
  DISPATCH_TASK_KINDS,
  LEASE_TTL_MS,
  type DispatchOrder,
  type DispatchOrderDraft,
  type DispatchReason,
  type DispatchState,
  type Workstation,
  type WorkstationKind,
} from '../types/dispatch';

/** 当前窗口会话 id：每个浏览器标签窗口实例一份，页面生命周期内不变 */
export const SESSION_ID = `s-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
/** 会话短标签（调度台识别占用来自哪个窗口） */
export const SESSION_LABEL = SESSION_ID.slice(-6);

/** 跨窗口通知通道：不搬运数据，只通知「调度状态变了，各窗口立刻跑一轮调度」 */
const CHANNEL_NAME = 'gbtearock-dispatch';
type ChannelMessage = { type: 'dispatch-changed'; at: string; from: string };
let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}
function notifyChanged(): void {
  // 带上发送方会话：BroadcastChannel 语义上消息不回发给发送者，
  // 但部分 polyfill / 测试桩会回环，订阅端统一按 from 过滤自我消息。
  const payload: ChannelMessage = { type: 'dispatch-changed', at: nowIso(), from: SESSION_ID };
  // 延迟到下一个宏任务派发：保证发起方当前的 IndexedDB 事务 / await 链完全结束后，
  // 其他窗口才收到通知并重跑调度（真实 BroadcastChannel 也是宏任务异步）。
  const dispatch = (): void => {
    try {
      getChannel()?.postMessage(payload);
    } catch {
      // 通道关闭 / 不支持时忽略：IndexedDB 轮询清扫仍会兜底
    }
  };
  if (typeof globalThis.setTimeout === 'function') {
    globalThis.setTimeout(dispatch, 0);
  } else {
    dispatch();
  }
}
/** 订阅其他窗口的调度变更（返回退订函数）；忽略本窗口自己发出的通知 */
export function subscribeDispatchChanged(handler: () => void): () => void {
  const ch = getChannel();
  if (!ch) return () => undefined;
  const listener = (event: MessageEvent<ChannelMessage>) => {
    if (event.data?.type === 'dispatch-changed' && event.data.from !== SESSION_ID) handler();
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}

/* ------------------------------- 纯函数工具 ------------------------------- */

/** 活跃（未终结）调度单，按提交序号排序 */
export function sortActiveOrders(orders: DispatchOrder[]): DispatchOrder[] {
  return orders
    .filter((order) => ACTIVE_DISPATCH_STATES.includes(order.state))
    .sort((a, b) => a.seq - b.seq || a.submittedAt.localeCompare(b.submittedAt));
}

/** 容量统计：按工位类型统计启用中的工位数 */
export function capacityOf(workstations: Workstation[]): Record<WorkstationKind, number> {
  return {
    roller: workstations.filter((ws) => ws.kind === 'roller' && ws.enabled).length,
    oven: workstations.filter((ws) => ws.kind === 'oven' && ws.enabled).length,
  };
}

/** 当前 HELD 已占用容量 */
function usedCapacityOf(orders: DispatchOrder[]): Record<WorkstationKind, number> {
  return orders
    .filter((order) => order.state === 'HELD')
    .reduce(
      (acc, order) => {
        acc.roller += order.rollerNeeded;
        acc.oven += order.ovenNeeded;
        return acc;
      },
      { roller: 0, oven: 0 },
    );
}

/* ------------------------------- 事务内原语 ------------------------------- */

interface PromotionResult {
  promoted: DispatchOrder[];
  expired: DispatchOrder[];
}

/**
 * 一轮调度（必须在 rw 事务内调用）：
 * 1) 清扫租约超时的 HELD → 无主 QUEUED（保留 seq）；
 * 2) FIFO + 队头阻塞地把「属于本会话」的队首 QUEUED 提升为 HELD。
 */
async function promoteInTransaction(sessionId: string, now: number): Promise<PromotionResult> {
  const result: PromotionResult = { promoted: [], expired: [] };
  const [workstations, orders] = await Promise.all([db.workstations.toArray(), db.dispatchOrders.toArray()]);

  // 1) 超时清扫：任何会话的 HELD 租约过期都释放回队（无主，等待调度台重试）
  for (const order of orders) {
    if (order.state === 'HELD' && Date.parse(order.leaseExpiresAt) <= now) {
      const released: DispatchOrder = {
        ...order,
        state: 'QUEUED',
        ownerSessionId: '',
        heldWorkstationIds: [],
        heldAt: '',
        leaseExpiresAt: '',
        reason: 'lease_expired',
        stateChangedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      await db.dispatchOrders.put(released);
      Object.assign(order, released);
      result.expired.push(released);
    }
  }

  // 2) FIFO 提升
  const capacity = capacityOf(workstations);
  const used = usedCapacityOf(orders);
  const freeWorkstations = (kind: WorkstationKind, need: number): Workstation[] => {
    const heldIds = new Set(
      orders.filter((o) => o.state === 'HELD').flatMap((o) => o.heldWorkstationIds),
    );
    return workstations
      .filter((ws) => ws.kind === kind && ws.enabled && !heldIds.has(ws.id))
      .slice(0, need);
  };

  const queue = sortActiveOrders(orders);
  for (const order of queue) {
    if (order.state === 'HELD') continue;
    // FAILED 在操作人显式重试前不自动占用，但它仍卡住队头（原队位不被后到者越过）
    if (order.state === 'FAILED') break;
    // QUEUED：只认领本会话提交的单子；无主单（页面已关）或他窗单都不可由本窗口代领
    if (order.ownerSessionId !== sessionId) break;

    const lackRoller = used.roller + order.rollerNeeded > capacity.roller;
    const lackOven = used.oven + order.ovenNeeded > capacity.oven;
    if (lackRoller || lackOven) {
      const reason: DispatchReason = lackRoller ? 'insufficient_roller' : 'insufficient_oven';
      if (order.reason !== reason) {
        await db.dispatchOrders.put({ ...order, reason, updatedAt: new Date(now).toISOString() });
      }
      break; // 队头阻塞：后续单子即使能塞下也不许插队
    }

    const rollers = freeWorkstations('roller', order.rollerNeeded);
    const ovens = freeWorkstations('oven', order.ovenNeeded);
    if (rollers.length < order.rollerNeeded || ovens.length < order.ovenNeeded) {
      break; // 设备级兜底（容量与占用不一致时宁可不分配）
    }
    const held: DispatchOrder = {
      ...order,
      state: 'HELD',
      heldWorkstationIds: [...rollers, ...ovens].map((ws) => ws.id),
      heldAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
      ownerSessionId: sessionId,
      reason: 'none',
      stateChangedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    await db.dispatchOrders.put(held);
    Object.assign(order, held);
    used.roller += held.rollerNeeded;
    used.oven += held.ovenNeeded;
    result.promoted.push(held);
  }
  return result;
}

/* ------------------------------- 对外操作 ------------------------------- */

/** 提交调度单：分配单调递增 seq 并入队 QUEUED，随后立即尝试一轮占用 */
export async function submitOrder(draft: DispatchOrderDraft): Promise<DispatchOrder> {
  if (!DISPATCH_TASK_KINDS.includes(draft.task)) throw new Error('未知调度任务类型');
  const rollerNeeded = Math.max(1, Math.floor(draft.rollerNeeded ?? 1));
  const ovenNeeded = Math.max(1, Math.floor(draft.ovenNeeded ?? 1));
  const stamp = nowIso();
  const now = Date.now();

  const order = await db.transaction('rw', [db.dispatchOrders, db.workstations], async () => {
    const last = await db.dispatchOrders.orderBy('seq').last();
    const row: DispatchOrder = {
      id: createId(ID_PREFIX.dispatchOrder),
      seq: (last?.seq ?? 0) + 1,
      batchId: draft.batchId,
      task: draft.task,
      note: draft.note?.trim() ?? '',
      rollerNeeded,
      ovenNeeded,
      state: 'QUEUED',
      heldWorkstationIds: [],
      heldAt: '',
      leaseExpiresAt: '',
      ownerSessionId: SESSION_ID,
      reason: 'queued',
      attempts: 0,
      recordId: '',
      submittedAt: stamp,
      stateChangedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await db.dispatchOrders.put(row);
    await promoteInTransaction(SESSION_ID, now);
    return (await db.dispatchOrders.get(row.id)) as DispatchOrder;
  });
  notifyChanged();
  return order;
}

/** 跑一轮调度（心跳 / 跨窗口通知 / 人工重试后都会调用） */
export async function tickScheduler(): Promise<void> {
  await db.transaction('rw', [db.dispatchOrders, db.workstations], () =>
    promoteInTransaction(SESSION_ID, Date.now()),
  );
  notifyChanged();
}

/** 心跳：本会话 HELD 全部续租一轮，再尝试推进队列 */
export async function heartbeat(): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', [db.dispatchOrders, db.workstations], async () => {
    const mine = await db.dispatchOrders.where('ownerSessionId').equals(SESSION_ID).toArray();
    for (const order of mine) {
      if (order.state !== 'HELD') continue;
      await db.dispatchOrders.put({
        ...order,
        leaseExpiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
        updatedAt: new Date(now).toISOString(),
      });
    }
    await promoteInTransaction(SESSION_ID, now);
  });
  notifyChanged();
}

/**
 * 显式重试：把无主 QUEUED 或 FAILED 的单子重新认领并尝试占用。
 * 严格保持原 seq：前序仍有等待单时拒绝（不许借重试越过前队）。
 */
export async function retryOrder(orderId: string): Promise<DispatchOrder> {
  const now = Date.now();
  const order = await db.transaction('rw', [db.dispatchOrders, db.workstations], async () => {
    const target = await db.dispatchOrders.get(orderId);
    if (!target) throw new Error('调度单不存在或已被删除');
    if (!['QUEUED', 'FAILED'].includes(target.state)) throw new Error('当前状态不允许重试');

    const active = sortActiveOrders(await db.dispatchOrders.toArray());
    // 只有排在队里的（QUEUED / FAILED）才算前序；HELD 是已占用的并行任务，不阻塞重试
    const before = active.find(
      (item) =>
        item.id !== target.id &&
        item.seq < target.seq &&
        (item.state === 'QUEUED' || item.state === 'FAILED'),
    );
    if (before) {
      throw new Error(`前序 #${before.seq} 调度单尚未完成，按提交先后不能越队重试`);
    }

    const capacity = capacityOf(await db.workstations.toArray());
    const used = usedCapacityOf(await db.dispatchOrders.toArray());
    if (
      used.roller + target.rollerNeeded > capacity.roller ||
      used.oven + target.ovenNeeded > capacity.oven
    ) {
      // 仍占不到：认领会话并回到队首等待，名次不变
      const waiting: DispatchOrder = {
        ...target,
        state: 'QUEUED',
        ownerSessionId: SESSION_ID,
        attempts: target.attempts + 1,
        reason: target.state === 'FAILED' ? 'save_failed' : target.reason,
        stateChangedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      await db.dispatchOrders.put(waiting);
      return waiting;
    }

    const workstations = await db.workstations.toArray();
    const heldIds = new Set(
      (await db.dispatchOrders.toArray())
        .filter((item) => item.state === 'HELD')
        .flatMap((item) => item.heldWorkstationIds),
    );
    const pick = (kind: WorkstationKind, need: number): string[] =>
      workstations
        .filter((ws) => ws.kind === kind && ws.enabled && !heldIds.has(ws.id))
        .slice(0, need)
        .map((ws) => ws.id);
    const rollerIds = pick('roller', target.rollerNeeded);
    const ovenIds = pick('oven', target.ovenNeeded);

    const held: DispatchOrder = {
      ...target,
      state: 'HELD',
      ownerSessionId: SESSION_ID,
      attempts: target.attempts + 1,
      heldWorkstationIds: [...rollerIds, ...ovenIds],
      heldAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
      reason: 'none',
      stateChangedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    await db.dispatchOrders.put(held);
    return held;
  });
  notifyChanged();
  return order;
}

/** 释放本会话的指定占用（保存失败 / 页面关闭共用内部实现） */
async function releaseHeld(orderId: string, reason: DispatchReason): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', [db.dispatchOrders, db.workstations], async () => {
    const order = await db.dispatchOrders.get(orderId);
    if (!order || order.state !== 'HELD' || order.ownerSessionId !== SESSION_ID) return;
    const nextState: DispatchState = reason === 'save_failed' ? 'FAILED' : 'QUEUED';
    await db.dispatchOrders.put({
      ...order,
      state: nextState,
      ownerSessionId: '',
      heldWorkstationIds: [],
      heldAt: '',
      leaseExpiresAt: '',
      reason,
      stateChangedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
  });
  notifyChanged();
}

/** 保存失败：工位释放、单子 FAILED 保留原队位，等待操作人重试 */
export async function failOrder(orderId: string): Promise<void> {
  await releaseHeld(orderId, 'save_failed');
}

/** 取消调度单（排队 / 失败中的单子可取消；本会话占用中的单子取消即释放） */
export async function cancelOrder(orderId: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.dispatchOrders, async () => {
    const order = await db.dispatchOrders.get(orderId);
    if (!order || ['CONFIRMED', 'CANCELLED'].includes(order.state)) return;
    if (order.state === 'HELD' && order.ownerSessionId !== SESSION_ID) {
      throw new Error('该工位正由其他窗口占用确认中，请等待其确认或租约超时');
    }
    await db.dispatchOrders.put({
      ...order,
      state: 'CANCELLED',
      ownerSessionId: '',
      heldWorkstationIds: [],
      heldAt: '',
      leaseExpiresAt: '',
      reason: 'cancelled',
      stateChangedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
  });
  notifyChanged();
}

/**
 * 确认占用：业务落库与「HELD → CONFIRMED 并释放工位」在同一个事务里，
 * 任一失败整体回滚（占用仍是 HELD，由调用方决定是否走 failOrder）。
 * 只要还存在其他未确认 HELD，本确认也被工序闸门拦截。
 */
export async function confirmOrder(
  orderId: string,
  apply?: (order: DispatchOrder) => Promise<{ recordId?: string }>,
): Promise<DispatchOrder> {
  const now = Date.now();
  const order = await db.transaction(
    'rw',
    [db.dispatchOrders, db.fixes, db.roasts, db.batches],
    async () => {
      const target = await db.dispatchOrders.get(orderId);
      if (!target) throw new Error('调度单不存在或已被删除');
      if (target.state !== 'HELD') throw new Error('调度单不在占用中，无法确认');
      if (target.ownerSessionId !== SESSION_ID) throw new Error('该占用不属于当前窗口（可能已被超时释放）');
      if (Date.parse(target.leaseExpiresAt) <= now) throw new Error('工位占用已超时，请重新排队后重试');

      const result = apply ? await apply(target) : { recordId: '' };
      const confirmed: DispatchOrder = {
        ...target,
        state: 'CONFIRMED',
        ownerSessionId: '',
        heldAt: target.heldAt,
        leaseExpiresAt: '',
        reason: 'confirmed',
        recordId: result?.recordId ?? '',
        stateChangedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      await db.dispatchOrders.put(confirmed);
      return confirmed;
    },
  );
  notifyChanged();
  return order;
}

/** 页面关闭 / 刷新：本会话全部 HELD 立即释放回原队位（pagehide 时尽力执行） */
export async function releaseOnPageHide(): Promise<void> {
  const now = Date.now();
  try {
    await db.transaction('rw', [db.dispatchOrders, db.workstations], async () => {
      const mine = await db.dispatchOrders.where('ownerSessionId').equals(SESSION_ID).toArray();
      for (const order of mine) {
        if (order.state !== 'HELD') continue;
        await db.dispatchOrders.put({
          ...order,
          state: 'QUEUED',
          ownerSessionId: '',
          heldWorkstationIds: [],
          heldAt: '',
          leaseExpiresAt: '',
          reason: 'page_closed',
          stateChangedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
      }
    });
    notifyChanged();
  } catch {
    // pagehide 阶段 IndexedDB 可能来不及完成：租约 TTL + 跨窗口清扫会兜底释放
  }
}

/** 启用 / 停用工位：容量变化后立即跑一轮调度（可能正好放行队首） */
export async function setWorkstationEnabled(workstationId: string, enabled: boolean): Promise<void> {
  const existing = await db.workstations.get(workstationId);
  if (!existing) return;
  await db.workstations.put({ ...existing, enabled, updatedAt: nowIso() });
  await tickScheduler();
}
