/**
 * 工位调度（ScheduleOrder）：杀青揉捻与焙火安排的工位占用调度
 * 每个任务必须同时拿到一台揉捻机和一个焙火炉（一个完整工位），
 * 剩余容量不足时按提交先后（FIFO）排队，不能占一半，也不能让后到的插队。
 * 页面关闭 / 保存失败 / 占用超时后释放工位，但保留原队位，可重试。
 */

/** 调度工序类型：杀青揉捻 / 焙火 */
export const SCHEDULE_PROCESS_OPTIONS = ['fix', 'roast'] as const;
export type ScheduleProcess = (typeof SCHEDULE_PROCESS_OPTIONS)[number];

/** 调度单状态（数组顺序即流转顺序） */
export const SCHEDULE_STATES = ['queued', 'occupied', 'completed', 'released', 'exception'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATES)[number];

/** 揉捻机资源（固定容量，可扩展） */
export const ROLLERS = [
  { id: 'roller-1', name: '揉捻机 1 号' },
  { id: 'roller-2', name: '揉捻机 2 号' },
  { id: 'roller-3', name: '揉捻机 3 号' },
] as const;

/** 焙火炉资源（固定容量，可扩展） */
export const OVENS = [
  { id: 'oven-1', name: '焙火炉 1 号' },
  { id: 'oven-2', name: '焙火炉 2 号' },
  { id: 'oven-3', name: '焙火炉 3 号' },
] as const;

/** 占用超时（毫秒）：超过此时长自动释放工位 */
export const OCCUPATION_TIMEOUT_MS = 5 * 60 * 1000;

/** 调度单实体（持久化到 IndexedDB 的 scheduleOrders 表） */
export interface ScheduleOrder {
  id: string;
  /** 所属批次 id（batchId 外键） */
  batchId: string;
  /** 调度工序类型 */
  process: ScheduleProcess;
  /** 排队序号（FIFO，从 1 开始；释放后保留原队位） */
  queueNo: number;
  /** 调度单状态 */
  status: ScheduleStatus;
  /** 占用的揉捻机 id（排队中为 null） */
  rollerId: string | null;
  /** 占用的焙火炉 id（排队中为 null） */
  ovenId: string | null;
  /** 占用确认时间（ISO） */
  occupiedAt: string | null;
  /** 占用超时时间（ISO），超过自动释放 */
  expiresAt: string | null;
  /** 异常原因（释放 / 超时 / 保存失败等） */
  exceptionReason: string;
  /** 提交时间（ISO） */
  submittedAt: string;
  /** 占用归属的会话 id（页面关闭时据此释放） */
  ownerSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 新建调度单表单草稿 */
export interface ScheduleDraft {
  batchId: string;
  process: ScheduleProcess;
}

/** 批次调度信息（跨页共用的派生结构） */
export interface ScheduleInfo {
  batchId: string;
  /** 调度单 id（无调度单为 null） */
  orderId: string | null;
  /** 调度单状态（无调度单为 null） */
  status: ScheduleStatus | null;
  /** 排队名次（队列中的位置，从 1 开始；仅排队中有值） */
  queueRank: number | null;
  /** 排队序号（仅排队中有值） */
  queueNo: number | null;
  /** 占用的揉捻机名称 */
  rollerName: string | null;
  /** 占用的焙火炉名称 */
  ovenName: string | null;
  /** 异常原因 */
  exceptionReason: string | null;
  /** 是否有未确认的调度单（排队中） */
  unconfirmed: boolean;
}

/** 调度状态 → 中文文案 */
export const SCHEDULE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  queued: '排队中',
  occupied: '占用中',
  completed: '已完成',
  released: '已释放',
  exception: '异常',
};

/** 调度工序 → 中文文案 */
export const SCHEDULE_PROCESS_LABEL: Record<ScheduleProcess, string> = {
  fix: '杀青揉捻',
  roast: '焙火',
};

/** 调度状态 → 标签底色 */
export const SCHEDULE_STATUS_COLOR: Record<ScheduleStatus, string> = {
  queued: 'processing',
  occupied: 'gold',
  completed: 'green',
  released: 'default',
  exception: 'red',
};
