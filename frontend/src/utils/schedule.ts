/**
 * 工位调度纯函数工具（utils/schedule.ts）
 * 只做纯函数换算：队列计算、资源分配、超时判定、批次调度信息派生。
 * 不碰数据库、不碰 React。
 */
import {
  OCCUPATION_TIMEOUT_MS,
  OVENS,
  ROLLERS,
  type ScheduleInfo,
  type ScheduleOrder,
  type ScheduleProcess,
  type ScheduleStatus,
} from '../types/schedule';

/* ------------------------------ 资源与容量 ------------------------------ */

/** 工位总数（揉捻机与焙火炉数量的较小值，一个完整工位 = 一台揉捻机 + 一个焙火炉） */
export function totalStations(): number {
  return Math.min(ROLLERS.length, OVENS.length);
}

/** 当前已占用的工位数量（占用中的调度单数量） */
export function occupiedStations(orders: ScheduleOrder[]): number {
  return orders.filter((order) => order.status === 'occupied').length;
}

/** 当前剩余可用工位数量 */
export function availableStations(orders: ScheduleOrder[]): number {
  return Math.max(0, totalStations() - occupiedStations(orders));
}

/** 揉捻机占用情况：返回被占用的 rollerId 集合 */
export function occupiedRollerIds(orders: ScheduleOrder[]): Set<string> {
  return new Set(
    orders
      .filter((order) => order.status === 'occupied' && order.rollerId !== null)
      .map((order) => order.rollerId as string),
  );
}

/** 焙火炉占用情况：返回被占用的 ovenId 集合 */
export function occupiedOvenIds(orders: ScheduleOrder[]): Set<string> {
  return new Set(
    orders
      .filter((order) => order.status === 'occupied' && order.ovenId !== null)
      .map((order) => order.ovenId as string),
  );
}

/* ------------------------------ 队列计算 ------------------------------ */

/** 排队中的调度单（按 queueNo 升序，即 FIFO 顺序） */
export function queuedOrders(orders: ScheduleOrder[]): ScheduleOrder[] {
  return orders
    .filter((order) => order.status === 'queued')
    .sort((a, b) => a.queueNo - b.queueNo);
}

/** 占用中的调度单（按 occupiedAt 升序） */
export function occupiedOrders(orders: ScheduleOrder[]): ScheduleOrder[] {
  return orders
    .filter((order) => order.status === 'occupied')
    .sort((a, b) => (a.occupiedAt ?? '').localeCompare(b.occupiedAt ?? ''));
}

/** 已释放的调度单（按 updatedAt 降序） */
export function releasedOrders(orders: ScheduleOrder[]): ScheduleOrder[] {
  return orders
    .filter((order) => order.status === 'released' || order.status === 'exception')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 已完成的调度单（按 updatedAt 降序） */
export function completedOrders(orders: ScheduleOrder[]): ScheduleOrder[] {
  return orders
    .filter((order) => order.status === 'completed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 下一个排队序号（当前最大 queueNo + 1；无排队则从 1 开始） */
export function nextQueueNo(orders: ScheduleOrder[]): number {
  const queued = queuedOrders(orders);
  if (queued.length === 0) return 1;
  return Math.max(...queued.map((order) => order.queueNo)) + 1;
}

/** 某排队中调度单的名次（队列中的位置，从 1 开始） */
export function queueRankOf(orders: ScheduleOrder[], orderId: string): number | null {
  const queued = queuedOrders(orders);
  const index = queued.findIndex((order) => order.id === orderId);
  return index < 0 ? null : index + 1;
}

/* ------------------------------ 资源分配 ------------------------------ */

export interface AllocationResult {
  allocated: boolean;
  rollerId: string | null;
  ovenId: string | null;
}

/**
 * 尝试为调度单分配一个完整工位（一台揉捻机 + 一个焙火炉）。
 * 必须同时拿到两种资源，否则返回 allocated: false（不占一半）。
 */
export function tryAllocate(orders: ScheduleOrder[]): AllocationResult {
  const usedRollers = occupiedRollerIds(orders);
  const usedOvens = occupiedOvenIds(orders);
  const roller = ROLLERS.find((item) => !usedRollers.has(item.id));
  const oven = OVENS.find((item) => !usedOvens.has(item.id));
  if (roller && oven) {
    return { allocated: true, rollerId: roller.id, ovenId: oven.id };
  }
  return { allocated: false, rollerId: null, ovenId: null };
}

/** 揉捻机 id → 名称 */
export function rollerNameOf(rollerId: string | null): string | null {
  if (!rollerId) return null;
  return ROLLERS.find((item) => item.id === rollerId)?.name ?? rollerId;
}

/** 焙火炉 id → 名称 */
export function ovenNameOf(ovenId: string | null): string | null {
  if (!ovenId) return null;
  return OVENS.find((item) => item.id === ovenId)?.name ?? ovenId;
}

/* ------------------------------ 超时判定 ------------------------------ */

/** 占用是否已超时 */
export function isExpired(order: ScheduleOrder, now: number = Date.now()): boolean {
  if (order.status !== 'occupied' || !order.expiresAt) return false;
  return new Date(order.expiresAt).getTime() <= now;
}

/** 占用剩余毫秒数（负数表示已超时） */
export function occupationRemainingMs(order: ScheduleOrder, now: number = Date.now()): number {
  if (!order.expiresAt) return 0;
  return new Date(order.expiresAt).getTime() - now;
}

/** 占用剩余秒数（向上取整，用于倒计时展示） */
export function occupationRemainingSeconds(order: ScheduleOrder, now: number = Date.now()): number {
  return Math.max(0, Math.ceil(occupationRemainingMs(order, now) / 1000));
}

/** 格式化剩余时间为 mm:ss */
export function formatRemaining(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/* ------------------------------ 批次调度信息 ------------------------------ */

/**
 * 派生批次的调度信息（跨页共用）。
 * 取该批次最近一条未完成的调度单（排队中 / 占用中）；
 * 若无，则取最近一条已释放 / 异常的调度单；
 * 若无调度单，返回 status: null（未排队）。
 */
export function scheduleInfoForBatch(orders: ScheduleOrder[], batchId: string): ScheduleInfo {
  const batchOrders = orders
    .filter((order) => order.batchId === batchId)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  const active = batchOrders.find((order) => order.status === 'queued' || order.status === 'occupied');
  if (active) {
    return {
      batchId,
      orderId: active.id,
      status: active.status,
      queueRank: active.status === 'queued' ? queueRankOf(orders, active.id) : null,
      queueNo: active.status === 'queued' ? active.queueNo : null,
      rollerName: active.status === 'occupied' ? rollerNameOf(active.rollerId) : null,
      ovenName: active.status === 'occupied' ? ovenNameOf(active.ovenId) : null,
      exceptionReason: active.exceptionReason || null,
      unconfirmed: active.status === 'queued',
    };
  }

  const latest = batchOrders[0];
  if (latest) {
    return {
      batchId,
      orderId: latest.id,
      status: latest.status,
      queueRank: null,
      queueNo: null,
      rollerName: latest.status === 'occupied' ? rollerNameOf(latest.rollerId) : null,
      ovenName: latest.status === 'occupied' ? ovenNameOf(latest.ovenId) : null,
      exceptionReason: latest.exceptionReason || null,
      unconfirmed: false,
    };
  }

  return {
    batchId,
    orderId: null,
    status: null,
    queueRank: null,
    queueNo: null,
    rollerName: null,
    ovenName: null,
    exceptionReason: null,
    unconfirmed: false,
  };
}

/** 批次是否有未确认的调度单（排队中）—— 用于阻断工序推进 */
export function hasUnconfirmedOrder(orders: ScheduleOrder[], batchId: string): boolean {
  return orders.some((order) => order.batchId === batchId && order.status === 'queued');
}

/** 批次是否有已确认的调度单（占用中 / 已完成） */
export function hasConfirmedOrder(orders: ScheduleOrder[], batchId: string): boolean {
  return orders.some(
    (order) => order.batchId === batchId && (order.status === 'occupied' || order.status === 'completed'),
  );
}

/** 批次是否有任何调度单（含已释放 / 异常） */
export function hasAnyOrder(orders: ScheduleOrder[], batchId: string): boolean {
  return orders.some((order) => order.batchId === batchId);
}

/* ------------------------------ 调度单构造 ------------------------------ */

/** 构造一条排队中的调度单 */
export function buildQueuedOrder(params: {
  id: string;
  batchId: string;
  process: ScheduleProcess;
  queueNo: number;
  sessionId: string;
  stamp: string;
}): ScheduleOrder {
  return {
    id: params.id,
    batchId: params.batchId,
    process: params.process,
    queueNo: params.queueNo,
    status: 'queued',
    rollerId: null,
    ovenId: null,
    occupiedAt: null,
    expiresAt: null,
    exceptionReason: '',
    submittedAt: params.stamp,
    ownerSessionId: params.sessionId,
    createdAt: params.stamp,
    updatedAt: params.stamp,
  };
}

/** 构造一条占用中的调度单（同时写入两种资源与超时时间） */
export function buildOccupiedOrder(params: {
  id: string;
  batchId: string;
  process: ScheduleProcess;
  queueNo: number;
  rollerId: string;
  ovenId: string;
  sessionId: string;
  stamp: string;
}): ScheduleOrder {
  return {
    id: params.id,
    batchId: params.batchId,
    process: params.process,
    queueNo: params.queueNo,
    status: 'occupied',
    rollerId: params.rollerId,
    ovenId: params.ovenId,
    occupiedAt: params.stamp,
    expiresAt: new Date(Date.now() + OCCUPATION_TIMEOUT_MS).toISOString(),
    exceptionReason: '',
    submittedAt: params.stamp,
    ownerSessionId: params.sessionId,
    createdAt: params.stamp,
    updatedAt: params.stamp,
  };
}

/** 调度单状态 → 是否为终态 */
export function isTerminalStatus(status: ScheduleStatus): boolean {
  return status === 'completed' || status === 'released' || status === 'exception';
}
