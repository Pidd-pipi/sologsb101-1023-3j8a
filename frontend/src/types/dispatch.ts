/**
 * 工位调度（Dispatch）：揉捻机 / 焙火炉两类工位的原子占用、FIFO 排队与租约。
 *
 * 状态机：
 *   QUEUED 排队 ──┬─► HELD 占用中（两工位同时拿到，带租约与心跳）
 *                │      ├─► CONFIRMED 已确认（工位释放、业务记录落库）
 *                │      ├─► QUEUED 重新排队（保存失败 / 页面关闭 / 租约超时，保留原队位）
 *                │      └─► FAILED 保存失败（与 QUEUED 同队位、同优先级，可重试）
 *                └─► CANCELLED 已取消
 */

/** 工位类型：揉捻机 / 焙火炉 */
export const WORKSTATION_KINDS = ['roller', 'oven'] as const;
export type WorkstationKind = (typeof WORKSTATION_KINDS)[number];

export const WORKSTATION_KIND_LABEL: Record<WorkstationKind, string> = {
  roller: '揉捻机',
  oven: '焙火炉',
};

/** 调度任务类型：杀青揉捻 / 焙火安排（每类任务都要同时拿到 1 台揉捻机 + 1 座焙火炉） */
export const DISPATCH_TASK_KINDS = ['FIX', 'ROAST'] as const;
export type DispatchTaskKind = (typeof DISPATCH_TASK_KINDS)[number];

export const DISPATCH_TASK_LABEL: Record<DispatchTaskKind, string> = {
  FIX: '杀青揉捻',
  ROAST: '焙火安排',
};

/** 调度单状态 */
export const DISPATCH_STATES = ['QUEUED', 'HELD', 'CONFIRMED', 'FAILED', 'CANCELLED'] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

export const DISPATCH_STATE_LABEL: Record<DispatchState, string> = {
  QUEUED: '排队中',
  HELD: '占用中',
  CONFIRMED: '已确认',
  FAILED: '保存失败',
  CANCELLED: '已取消',
};

/** 仍参与排队 / 占用工位的活跃状态 */
export const ACTIVE_DISPATCH_STATES: readonly DispatchState[] = ['QUEUED', 'HELD', 'FAILED'];

/** 排队列里的状态（保留队位、等待重新占用） */
export const QUEUE_DISPATCH_STATES: readonly DispatchState[] = ['QUEUED', 'FAILED'];

/** 工位实体（持久化到 workstations 表；每台设备一行） */
export interface Workstation {
  id: string;
  /** 工位类型 */
  kind: WorkstationKind;
  /** 工位名，例如「揉捻机 R1」「焙火炉 O1」 */
  name: string;
  /** 备注，例如炭种 / 压力档位说明 */
  note: string;
  /** 是否停用（停用工位不参与容量计算） */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 异常原因编码（台账 / 杀青记录 / 调度台三处展示同一份文案） */
export type DispatchReason =
  | 'none'
  | 'queued'
  | 'insufficient_roller'
  | 'insufficient_oven'
  | 'held_unconfirmed'
  | 'save_failed'
  | 'lease_expired'
  | 'page_closed'
  | 'cancelled'
  | 'confirmed'
  | 'no_order';

export const DISPATCH_REASON_LABEL: Record<DispatchReason, string> = {
  none: '—',
  queued: '等待工位（揉捻机 + 焙火炉同时空闲）',
  insufficient_roller: '揉捻机剩余容量不足，按提交先后排队',
  insufficient_oven: '焙火炉剩余容量不足，按提交先后排队',
  held_unconfirmed: '工位已占用但尚未确认，批次状态与焙火安排不得越过当前工序',
  save_failed: '业务记录保存失败，工位已释放，保留原队位可重试',
  lease_expired: '占用心跳超时，工位已自动释放并保留原队位',
  page_closed: '提交页面已关闭，工位已释放并保留原队位',
  cancelled: '调度单已取消',
  confirmed: '工位占用已确认并释放',
  no_order: '未排队',
};

/** 调度单实体（持久化到 dispatchOrders 表） */
export interface DispatchOrder {
  id: string;
  /** 单调递增序号（创建时分配；排队名次与「原队位」都以它为准） */
  seq: number;
  /** 关联茶青批次 */
  batchId: string;
  /** 任务类型 */
  task: DispatchTaskKind;
  /** 备注（操作人 / 道次等展示信息） */
  note: string;
  /** 需要的揉捻机数量（固定按台计，默认 1） */
  rollerNeeded: number;
  /** 需要的焙火炉数量（默认 1） */
  ovenNeeded: number;
  /** 状态 */
  state: DispatchState;
  /** 占用工位 id 列表（HELD 时写入；释放后保留作留档） */
  heldWorkstationIds: string[];
  /** 占用开始时间（ISO） */
  heldAt: string;
  /** 租约到期时间（ISO，epoch 毫秒）；HELD 时心跳续租 */
  leaseExpiresAt: string;
  /** 持有占用的会话 id（浏览器标签窗口实例） */
  ownerSessionId: string;
  /** 异常原因（最近一次排队 / 释放 / 失败原因，三处台账同源展示） */
  reason: DispatchReason;
  /** 重试次数（保存失败后重新占用的次数） */
  attempts: number;
  /** 确认后写入的业务记录 id（fixes / roasts 表） */
  recordId: string;
  /** 提交时间（ISO） */
  submittedAt: string;
  /** 状态最近变更时间（ISO） */
  stateChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 新建调度单的入参草稿 */
export interface DispatchOrderDraft {
  batchId: string;
  task: DispatchTaskKind;
  note?: string;
  rollerNeeded?: number;
  ovenNeeded?: number;
}

/** 租约时长（毫秒）：占用 30 秒内必须完成确认，否则视为心跳超时 */
export const LEASE_TTL_MS = 30_000;
/** 心跳续租间隔 */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** 僵死占用清扫间隔（兜底 pagehide 没送达的关闭场景） */
export const SWEEP_INTERVAL_MS = 5_000;
/** 单次占用最长确认时间（UI 倒计时上限，等于租约时长） */
export const LEASE_COUNTDOWN_MS = LEASE_TTL_MS;
