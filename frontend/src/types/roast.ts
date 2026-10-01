/**
 * 焙火（Roast）：多道次焙火曲线与复焙安排
 * 状态流转：待焙 → 焙火中 → 已足火。
 */

/** 炭种枚举 */
export const CHARCOAL_OPTIONS = ['荔枝炭', '龙眼炭', '机制炭'] as const;
export type Charcoal = (typeof CHARCOAL_OPTIONS)[number];

/** 焙火状态枚举（数组顺序即流转顺序） */
export const ROAST_STATES = ['待焙', '焙火中', '已足火'] as const;
export type RoastState = (typeof ROAST_STATES)[number];

/** 参数合法区间 */
export const ROAST_LIMITS = {
  tempC: { min: 40, max: 160 },
  hours: { min: 0.5, max: 48 },
} as const;

/** 焙火道次实体（持久化到 IndexedDB 的 roasts 表） */
export interface Roast {
  id: string;
  /** 所属批次 id（batchId 外键） */
  batchId: string;
  /** 道次，从 1 开始；按序排列 */
  passNo: number;
  /** 焙火温度 ℃ */
  tempC: number;
  /** 时长（小时） */
  hours: number;
  /** 炭种：荔枝炭 / 龙眼炭 / 机制炭 */
  charcoal: Charcoal;
  /** 复焙日期 YYYY-MM-DD，空串表示不复焙 */
  nextRoastDate: string;
  /** 焙火状态 */
  state: RoastState;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 编辑焙火道次表单草稿 */
export interface RoastDraft {
  batchId: string;
  tempC: number;
  hours: number;
  charcoal: Charcoal;
  nextRoastDate: string;
  state: RoastState;
}

/** 复焙提醒：到期或临期的道次 */
export interface RoastReminder {
  roastId: string;
  batchId: string;
  passNo: number;
  nextRoastDate: string;
  /** 距今天数，负数表示已过期 */
  daysLeft: number;
  level: 'overdue' | 'today' | 'soon' | 'planned';
}

/** 火功档位：轻火 / 中火 / 足火（由累计温度时长换算） */
export type FireLevel = '轻火' | '中火' | '足火';

/** 下一道工序状态；已足火返回 null */
export function nextRoastState(state: RoastState): RoastState | null {
  const index = ROAST_STATES.indexOf(state);
  if (index < 0 || index >= ROAST_STATES.length - 1) return null;
  return ROAST_STATES[index + 1];
}
