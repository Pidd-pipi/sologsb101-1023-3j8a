/**
 * 杀青揉捻（Fix）：锅温、杀青时长与揉捻压力记录
 * 登记完成后回写批次为「已杀青」。
 */

/** 揉捻压力枚举：轻 / 中 / 重 */
export const ROLL_PRESSURE_OPTIONS = ['轻', '中', '重'] as const;
export type RollPressure = (typeof ROLL_PRESSURE_OPTIONS)[number];

/** 参数合法区间（表单校验与区间判定共用） */
export const FIX_LIMITS = {
  wokTempC: { min: 80, max: 400 },
  fixMin: { min: 1, max: 60 },
  rollMin: { min: 1, max: 60 },
} as const;

/** 杀青揉捻实体（持久化到 IndexedDB 的 fixes 表） */
export interface Fix {
  id: string;
  /** 所属批次 id（batchId 外键） */
  batchId: string;
  /** 锅温 ℃ */
  wokTempC: number;
  /** 杀青时长（分钟） */
  fixMin: number;
  /** 揉捻压力：轻 / 中 / 重 */
  rollPressure: RollPressure;
  /** 揉捻时长（分钟） */
  rollMin: number;
  /** 操作人 */
  operator: string;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 编辑杀青揉捻表单草稿 */
export interface FixDraft {
  batchId: string;
  wokTempC: number;
  fixMin: number;
  rollPressure: RollPressure;
  rollMin: number;
  operator: string;
}

/** 杀青强度判定档位 */
export type FixLevel = '偏轻' | '适中' | '偏重';
