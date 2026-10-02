/**
 * 工位调度状态管理（Zustand）· scheduleStore.ts
 * 维护调度单列表、FIFO 队列、资源分配、占用超时与页面关闭释放。
 * 核心原则：每个任务必须同时拿到揉捻机与焙火炉（一个完整工位），
 * 剩余容量不足时按提交先后排队，不能占一半，也不能让后到的插队。
 */
import { create } from 'zustand';
import {
  OCCUPATION_TIMEOUT_MS,
  OVENS,
  ROLLERS,
  type ScheduleOrder,
  type ScheduleProcess,
} from '../types/schedule';
import {
  buildOccupiedOrder,
  buildQueuedOrder,
  hasUnconfirmedOrder,
  isExpired,
  nextQueueNo,
  occupiedOrders,
  queuedOrders,
  releasedOrders,
  scheduleInfoForBatch,
  tryAllocate,
} from '../utils/schedule';
import {
  createId,
  db,
  listScheduleOrders,
  nowIso,
  putScheduleOrder,
} from '../utils/db';

/** 会话存储键：记录当前标签页的会话 id */
const SESSION_STORAGE_KEY = 'gbtearock-schedule-session-id';
/** 心跳存储键：记录各会话的最后心跳时间与占用的调度单 */
const HEARTBEAT_STORAGE_KEY = 'gbtearock-schedule-heartbeat';
/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 15000;
/** 心跳过期判定（毫秒）：超过此时长未心跳的会话视为已关闭 */
const HEARTBEAT_STALE_MS = 45000;

/* ------------------------------ 会话与心跳 ------------------------------ */

/** 获取（或生成）当前标签页的会话 id */
function getSessionId(): string {
  let sessionId = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!sessionId) {
    sessionId = createId('session');
    sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }
  return sessionId;
}

interface HeartbeatEntry {
  at: number;
  orders: string[];
}

type HeartbeatMap = Record<string, HeartbeatEntry>;

function readHeartbeats(): HeartbeatMap {
  try {
    const raw = localStorage.getItem(HEARTBEAT_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as HeartbeatMap;
  } catch {
    return {};
  }
}

function writeHeartbeats(map: HeartbeatMap): void {
  try {
    localStorage.setItem(HEARTBEAT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage 不可用时忽略
  }
}

/** 更新当前会话的心跳 */
function heartbeat(sessionId: string, orderIds: string[]): void {
  const map = readHeartbeats();
  map[sessionId] = { at: Date.now(), orders: orderIds };
  writeHeartbeats(map);
}

/** 清除当前会话的心跳（页面关闭时调用） */
function clearHeartbeat(sessionId: string): void {
  const map = readHeartbeats();
  delete map[sessionId];
  writeHeartbeats(map);
}

/** 找出心跳已过期的会话 id */
function staleSessionIds(): string[] {
  const map = readHeartbeats();
  const now = Date.now();
  return Object.entries(map)
    .filter(([, entry]) => now - entry.at > HEARTBEAT_STALE_MS)
    .map(([id]) => id);
}

/** 更新当前会话的心跳（记录占用中的调度单） */
function updateHeartbeat(sessionId: string, orders: ScheduleOrder[]): void {
  if (!sessionId) return;
  const orderIds = orders
    .filter((o) => o.ownerSessionId === sessionId && o.status === 'occupied')
    .map((o) => o.id);
  heartbeat(sessionId, orderIds);
}

/* ------------------------------ Store 接口 ------------------------------ */

interface ScheduleStoreState {
  orders: ScheduleOrder[];
  loading: boolean;
  error: string;
  sessionId: string;
  /** 队列刷新计数器（用于触发倒计时重渲染） */
  tick: number;

  loadOrders: () => Promise<void>;

  /** 提交调度申请：原子性地获取揉捻机 + 焙火炉，容量不足则按 FIFO 排队 */
  submitOrder: (batchId: string, process: ScheduleProcess) => Promise<ScheduleOrder>;

  /** 确认占用（排队中 → 已占用），或重试已释放的调度单 */
  confirmOrder: (orderId: string) => Promise<ScheduleOrder | null>;

  /** 释放占用（页面关闭 / 保存失败 / 超时）：保留队位，回到排队中 */
  releaseOrder: (orderId: string, reason: string) => Promise<void>;

  /** 标记完成（已占用 → 已完成），释放资源并推进队列 */
  completeOrder: (orderId: string) => Promise<void>;

  /** 处理队列：资源释放后，按 FIFO 把队首可满足的订单转为已占用 */
  processQueue: () => Promise<void>;

  /** 检查并释放超时占用 */
  checkTimeouts: () => Promise<void>;

  /** 清理已关闭会话的占用（心跳过期） */
  cleanupStaleSessions: () => Promise<void>;

  /** 派生：队列（排队中的订单，按 queueNo 排序） */
  queueList: () => ScheduleOrder[];
  /** 派生：当前占用（已占用的订单） */
  occupationList: () => ScheduleOrder[];
  /** 派生：异常 / 已释放列表 */
  exceptionList: () => ScheduleOrder[];
  /** 派生：批次调度信息 */
  infoForBatch: (batchId: string) => ReturnType<typeof scheduleInfoForBatch>;
  /** 派生：批次是否有未确认的调度单 */
  batchUnconfirmed: (batchId: string) => boolean;

  /** 启动心跳与定时检查（应用初始化时调用） */
  startHeartbeat: () => () => void;
}

export const useScheduleStore = create<ScheduleStoreState>((set, get) => ({
  orders: [],
  loading: false,
  error: '',
  sessionId: '',
  tick: 0,

  async loadOrders() {
    set({ loading: true, error: '' });
    try {
      const orders = await listScheduleOrders();
      set({ orders, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '调度数据读取失败' });
    }
  },

  async submitOrder(batchId, process) {
    const sessionId = get().sessionId || getSessionId();
    set({ sessionId });
    const stamp = nowIso();

    // 在事务中原子性地完成：读队列 → 排队号 → 尝试分配 → 写入
    const order = await db.transaction('rw', db.scheduleOrders, async () => {
      const allOrders = await db.scheduleOrders.toArray();
      const queueNo = nextQueueNo(allOrders);
      const allocation = tryAllocate(allOrders);
      // 只有在没有排队中的订单时，才立即分配资源（避免后到的插队）
      const hasQueued = queuedOrders(allOrders).length > 0;

      let draft: ScheduleOrder;
      if (allocation.allocated && allocation.rollerId && allocation.ovenId && !hasQueued) {
        draft = buildOccupiedOrder({
          id: createId('sched'),
          batchId,
          process,
          queueNo,
          rollerId: allocation.rollerId,
          ovenId: allocation.ovenId,
          sessionId,
          stamp,
        });
      } else {
        draft = buildQueuedOrder({
          id: createId('sched'),
          batchId,
          process,
          queueNo,
          sessionId,
          stamp,
        });
      }
      await db.scheduleOrders.put(draft);
      return draft;
    });

    await get().loadOrders();
    updateHeartbeat(get().sessionId, get().orders);
    return order;
  },

  async confirmOrder(orderId) {
    const sessionId = get().sessionId || getSessionId();
    set({ sessionId });
    const stamp = nowIso();

    const order = await db.transaction('rw', db.scheduleOrders, async () => {
      const existing = await db.scheduleOrders.get(orderId);
      if (!existing) return null;
      if (existing.status !== 'queued' && existing.status !== 'released' && existing.status !== 'exception') {
        return existing;
      }
      // 重试：回到排队中（保留原 queueNo），再尝试分配
      const allOrders = await db.scheduleOrders.toArray();
      const others = allOrders.filter((item) => item.id !== orderId);
      // 检查是否有排在前面的订单（queueNo 更小的排队中订单），避免插队
      const hasAhead = others.some(
        (item) => item.status === 'queued' && item.queueNo < existing.queueNo,
      );
      const allocation = hasAhead ? { allocated: false, rollerId: null, ovenId: null } : tryAllocate(others);

      if (allocation.allocated && allocation.rollerId && allocation.ovenId) {
        const occupied = buildOccupiedOrder({
          id: existing.id,
          batchId: existing.batchId,
          process: existing.process,
          queueNo: existing.queueNo,
          rollerId: allocation.rollerId,
          ovenId: allocation.ovenId,
          sessionId,
          stamp,
        });
        await db.scheduleOrders.put(occupied);
        return occupied;
      }
      // 容量不足或有前车，回到排队中（保留原队位）
      const queued: ScheduleOrder = {
        ...existing,
        status: 'queued',
        rollerId: null,
        ovenId: null,
        occupiedAt: null,
        expiresAt: null,
        exceptionReason: '',
        ownerSessionId: sessionId,
        updatedAt: stamp,
      };
      await db.scheduleOrders.put(queued);
      return queued;
    });

    await get().loadOrders();
    updateHeartbeat(get().sessionId, get().orders);
    return order;
  },

  async releaseOrder(orderId, reason) {
    const stamp = nowIso();
    await db.transaction('rw', db.scheduleOrders, async () => {
      const existing = await db.scheduleOrders.get(orderId);
      if (!existing) return;
      if (existing.status !== 'occupied') return;
      const released: ScheduleOrder = {
        ...existing,
        status: 'released',
        rollerId: null,
        ovenId: null,
        occupiedAt: null,
        expiresAt: null,
        exceptionReason: reason,
        updatedAt: stamp,
      };
      await db.scheduleOrders.put(released);
    });
    await get().loadOrders();
    // 释放后推进队列
    await get().processQueue();
    updateHeartbeat(get().sessionId, get().orders);
  },

  async completeOrder(orderId) {
    const stamp = nowIso();
    await db.transaction('rw', db.scheduleOrders, async () => {
      const existing = await db.scheduleOrders.get(orderId);
      if (!existing) return;
      if (existing.status !== 'occupied') return;
      const completed: ScheduleOrder = {
        ...existing,
        status: 'completed',
        updatedAt: stamp,
      };
      await db.scheduleOrders.put(completed);
    });
    await get().loadOrders();
    // 完成后推进队列
    await get().processQueue();
    updateHeartbeat(get().sessionId, get().orders);
  },

  async processQueue() {
    const stamp = nowIso();
    await db.transaction('rw', db.scheduleOrders, async () => {
      const allOrders = await db.scheduleOrders.toArray();
      const queued = queuedOrders(allOrders);
      if (queued.length === 0) return;

      // 已占用的资源（排除即将处理的队列）
      const occupied = occupiedOrders(allOrders);
      const usedRollers = new Set(
        occupied.map((o) => o.rollerId).filter((id): id is string => id !== null),
      );
      const usedOvens = new Set(
        occupied.map((o) => o.ovenId).filter((id): id is string => id !== null),
      );

      // FIFO：从队首开始，能满足就分配，不能满足就停止（不插队）
      for (const order of queued) {
        const roller = ROLLERS.find((r) => !usedRollers.has(r.id));
        const oven = OVENS.find((o) => !usedOvens.has(o.id));
        if (!roller || !oven) break; // 队首无法满足，停止处理（不插队）

        const updated: ScheduleOrder = {
          ...order,
          status: 'occupied',
          rollerId: roller.id,
          ovenId: oven.id,
          occupiedAt: stamp,
          expiresAt: new Date(Date.now() + OCCUPATION_TIMEOUT_MS).toISOString(),
          updatedAt: stamp,
        };
        await db.scheduleOrders.put(updated);
        usedRollers.add(roller.id);
        usedOvens.add(oven.id);
      }
    });
    await get().loadOrders();
  },

  async checkTimeouts() {
    const now = Date.now();
    const allOrders = await listScheduleOrders();
    const expired = allOrders.filter((order) => isExpired(order, now));
    if (expired.length === 0) return;

    const stamp = nowIso();
    await db.transaction('rw', db.scheduleOrders, async () => {
      for (const order of expired) {
        const released: ScheduleOrder = {
          ...order,
          status: 'released',
          rollerId: null,
          ovenId: null,
          occupiedAt: null,
          expiresAt: null,
          exceptionReason: '占用超时，系统自动释放',
          updatedAt: stamp,
        };
        await db.scheduleOrders.put(released);
      }
    });
    await get().loadOrders();
    await get().processQueue();
  },

  async cleanupStaleSessions() {
    const staleIds = staleSessionIds();
    if (staleIds.length === 0) return;

    const allOrders = await listScheduleOrders();
    const staleOrders = allOrders.filter(
      (order) => order.status === 'occupied' && order.ownerSessionId && staleIds.includes(order.ownerSessionId),
    );
    if (staleOrders.length === 0) return;

    const stamp = nowIso();
    await db.transaction('rw', db.scheduleOrders, async () => {
      for (const order of staleOrders) {
        const released: ScheduleOrder = {
          ...order,
          status: 'released',
          rollerId: null,
          ovenId: null,
          occupiedAt: null,
          expiresAt: null,
          exceptionReason: '页面关闭，系统自动释放',
          updatedAt: stamp,
        };
        await db.scheduleOrders.put(released);
      }
    });
    // 清除过期会话的心跳记录
    const map = readHeartbeats();
    staleIds.forEach((id) => delete map[id]);
    writeHeartbeats(map);

    await get().loadOrders();
    await get().processQueue();
  },

  queueList() {
    return queuedOrders(get().orders);
  },

  occupationList() {
    return occupiedOrders(get().orders);
  },

  exceptionList() {
    return releasedOrders(get().orders);
  },

  infoForBatch(batchId) {
    return scheduleInfoForBatch(get().orders, batchId);
  },

  batchUnconfirmed(batchId) {
    return hasUnconfirmedOrder(get().orders, batchId);
  },

  startHeartbeat() {
    const sessionId = getSessionId();
    set({ sessionId });

    // 立即清理一次过期会话
    void get().cleanupStaleSessions();
    void get().checkTimeouts();

    // 定时心跳 + 超时检查 + 过期会话清理
    const timer = setInterval(() => {
      updateHeartbeat(get().sessionId, get().orders);
      void get().checkTimeouts();
      void get().cleanupStaleSessions();
      set({ tick: get().tick + 1 });
    }, HEARTBEAT_INTERVAL_MS);

    // 页面关闭时释放当前会话占用
    const handleBeforeUnload = (): void => {
      const orderIds = get()
        .orders.filter((o) => o.ownerSessionId === sessionId && o.status === 'occupied')
        .map((o) => o.id);
      if (orderIds.length > 0) {
        // 同步标记释放（best-effort，IndexedDB 写入可能不完成）
        const stamp = nowIso();
        orderIds.forEach((id) => {
          const order = get().orders.find((o) => o.id === id);
          if (order) {
            const released: ScheduleOrder = {
              ...order,
              status: 'released',
              rollerId: null,
              ovenId: null,
              occupiedAt: null,
              expiresAt: null,
              exceptionReason: '页面关闭，系统自动释放',
              updatedAt: stamp,
            };
            // 尽力写入（不 await）
            void putScheduleOrder(released);
          }
        });
      }
      clearHeartbeat(sessionId);
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  },
}));

export default useScheduleStore;
