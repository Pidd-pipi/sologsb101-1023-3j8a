/**
 * 调度派生视图与工序闸门（dispatchViews.ts）
 *
 * 山场台账、杀青揉捻记录、焙火安排、调度台都消费这里的纯函数，
 * 保证「名次、占用工位、异常原因」三处同源一致；
 * 旧批次没有调度单时统一按「未排队」显示。
 */
import {
  DISPATCH_REASON_LABEL,
  type DispatchOrder,
  type DispatchReason,
  type Workstation,
} from '../types/dispatch';
import { capacityOf, sortActiveOrders } from './scheduler';

/* ------------------------------- 名次视图 ------------------------------- */

export interface BatchDispatchSummary {
  /** 是否有活跃（排队 / 占用 / 失败）调度单 */
  hasOrder: boolean;
  /** 最新一张调度单 */
  order: DispatchOrder | null;
  /** 调度单号 #seq，无单时为 null */
  rankNo: number | null;
  /** 队列名次（队首 = 1；仅排队 / 失败中有意义；占用 / 无单为 null） */
  queuePosition: number | null;
  /** 队列长度（含自己） */
  queueLength: number;
  /** 当前占用的工位名（HELD） */
  heldWorkstationNames: string[];
  /** 异常 / 状态原因（用于三处同源展示） */
  reason: DispatchReason;
  reasonText: string;
}

const EMPTY_REASON_TEXT = DISPATCH_REASON_LABEL.no_order;

/**
 * 单个批次的调度名次摘要：取 seq 最大的一张活跃单代表批次当前调度状态。
 */
export function batchDispatchSummary(
  batchId: string,
  orders: DispatchOrder[],
  workstations: Workstation[],
): BatchDispatchSummary {
  const allActive = sortActiveOrders(orders);
  const mine = allActive.filter((order) => order.batchId === batchId);
  const order = mine.length > 0 ? mine[mine.length - 1] : null;

  if (!order) {
    return {
      hasOrder: false,
      order: null,
      rankNo: null,
      queuePosition: null,
      queueLength: allActive.filter((item) => item.state === 'QUEUED').length,
      heldWorkstationNames: [],
      reason: 'no_order',
      reasonText: EMPTY_REASON_TEXT,
    };
  }

  const wsNameOf = new Map(workstations.map((ws) => [ws.id, ws.name]));
  const heldNames = order.heldWorkstationIds.map((id) => wsNameOf.get(id) ?? id);

  let queuePosition: number | null = null;
  let queueLength = 0;
  if (order.state === 'QUEUED' || order.state === 'FAILED') {
    const waiting = allActive.filter((item) => item.state === 'QUEUED' || item.state === 'FAILED');
    queueLength = waiting.length;
    queuePosition = waiting.findIndex((item) => item.id === order.id) + 1;
  }

  return {
    hasOrder: true,
    order,
    rankNo: order.seq,
    queuePosition,
    queueLength,
    heldWorkstationNames: heldNames,
    reason: order.reason,
    reasonText: DISPATCH_REASON_LABEL[order.reason],
  };
}

/* ------------------------------- 工位视图 ------------------------------- */

export interface WorkstationUsage {
  workstation: Workstation;
  /** 当前占用该工位的调度单（HELD） */
  heldBy: DispatchOrder | null;
  /** 是否空闲（启用且无占用；停用单独标记） */
  occupied: boolean;
}

/** 每个工位的实时占用情况（调度台工位卡 + 占用明细共用） */
export function workstationUsages(orders: DispatchOrder[], workstations: Workstation[]): WorkstationUsage[] {
  const heldOrders = orders.filter((order) => order.state === 'HELD');
  return workstations.map((workstation) => {
    const heldBy = heldOrders.find((order) => order.heldWorkstationIds.includes(workstation.id)) ?? null;
    return { workstation, heldBy, occupied: heldBy !== null };
  });
}

/** 容量占用汇总 */
export interface CapacitySummary {
  rollerTotal: number;
  rollerUsed: number;
  ovenTotal: number;
  ovenUsed: number;
}

export function capacitySummary(orders: DispatchOrder[], workstations: Workstation[]): CapacitySummary {
  const capacity = capacityOf(workstations);
  const used = heldOrders(orders).reduce(
    (acc, order) => {
      acc.roller += order.rollerNeeded;
      acc.oven += order.ovenNeeded;
      return acc;
    },
    { roller: 0, oven: 0 },
  );
  return {
    rollerTotal: capacity.roller,
    rollerUsed: used.roller,
    ovenTotal: capacity.oven,
    ovenUsed: used.oven,
  };
}

/* ------------------------------- 闸门 ------------------------------- */

export interface HoldBlocker {
  order: DispatchOrder;
  reasonText: string;
}

/** 当前所有未确认的占用（HELD）；非空即代表工序不得越过当前步骤 */
export function heldOrders(orders: DispatchOrder[]): DispatchOrder[] {
  return orders
    .filter((order) => order.state === 'HELD')
    .sort((a, b) => a.seq - b.seq || a.submittedAt.localeCompare(b.submittedAt));
}

/** 全局未确认占用闸门：存在 HELD 时返回拦截信息（确认动作自身除外） */
export function findHoldBlocker(
  orders: DispatchOrder[],
  options: { excludeOrderId?: string } = {},
): HoldBlocker | null {
  const order = heldOrders(orders).find((item) => item.id !== options.excludeOrderId);
  if (!order) return null;
  return { order, reasonText: DISPATCH_REASON_LABEL.held_unconfirmed };
}

/** 断言当前没有未确认占用，否则抛出带中文说明的错误 */
export function assertNoUnconfirmedHold(
  orders: DispatchOrder[],
  options: { excludeOrderId?: string } = {},
): void {
  const blocker = findHoldBlocker(orders, options);
  if (blocker) {
    throw new Error(`#${blocker.order.seq} 调度单占用未确认：${blocker.reasonText}`);
  }
}

/** 排队（QUEUED / FAILED）中的单子，FIFO 顺序 */
export function waitingOrders(orders: DispatchOrder[]): DispatchOrder[] {
  return sortActiveOrders(orders).filter((order) => order.state === 'QUEUED' || order.state === 'FAILED');
}

/** 已终结（已确认 / 已取消）历史单，最近在前 */
export function finishedOrders(orders: DispatchOrder[]): DispatchOrder[] {
  return orders
    .filter((order) => order.state === 'CONFIRMED' || order.state === 'CANCELLED')
    .sort((a, b) => b.stateChangedAt.localeCompare(a.stateChangedAt) || b.seq - a.seq);
}
