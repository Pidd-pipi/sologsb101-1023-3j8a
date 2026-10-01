/**
 * 做青轮次（Turn）：摇青与静置交替进行的一轮参数
 * 关注摇青分钟、静置分钟、室温、湿度与失水率。
 */

/** 做青参数合法区间（表单校验与区间判定共用） */
export const TURN_LIMITS = {
  shakeMin: { min: 0, max: 120 },
  restMin: { min: 0, max: 600 },
  roomTempC: { min: 5, max: 40 },
  humidityPct: { min: 20, max: 100 },
  waterLossPct: { min: 0, max: 40 },
} as const;

/** 做青轮次实体（持久化到 IndexedDB 的 turns 表） */
export interface Turn {
  id: string;
  /** 所属批次 id（batchId 外键） */
  batchId: string;
  /** 轮次序号，从 1 开始；拖拽排序后重排 */
  roundNo: number;
  /** 摇青分钟 */
  shakeMin: number;
  /** 静置分钟 */
  restMin: number;
  /** 室温 ℃ */
  roomTempC: number;
  /** 相对湿度 % */
  humidityPct: number;
  /** 本轮结束时累计失水率 % */
  waterLossPct: number;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 编辑轮次表单草稿 */
export interface TurnDraft {
  batchId: string;
  shakeMin: number;
  restMin: number;
  roomTempC: number;
  humidityPct: number;
  waterLossPct: number;
}

/** 做青参数模板（turnStore 维护，供「复制上一轮参数后微调」复用） */
export interface TurnTemplate {
  batchId: string;
  shakeMin: number;
  restMin: number;
  roomTempC: number;
  humidityPct: number;
  waterLossPct: number;
}

/** 时间线上的一个交替段：摇青段或静置段 */
export interface TurnSegment {
  turnId: string;
  roundNo: number;
  kind: 'shake' | 'rest';
  /** 该段开始的累计分钟数 */
  startMin: number;
  /** 该段结束的累计分钟数 */
  endMin: number;
  /** 段时长（分钟） */
  durationMin: number;
}

/** useTurnTimeline 派生的一行：轮次 + 累计时长与失水率走势 */
export interface TurnTimelineItem {
  turn: Turn;
  /** 本轮开始的累计分钟数 */
  startMin: number;
  /** 本轮结束（含静置）的累计分钟数 */
  endMin: number;
  /** 摇青结束时的累计分钟数 */
  shakeEndMin: number;
  /** 摇青段 */
  shakeSegment: TurnSegment;
  /** 静置段 */
  restSegment: TurnSegment;
  /** 截至本轮的累计摇青分钟 */
  accumulatedShakeMin: number;
  /** 截至本轮的累计静置分钟 */
  accumulatedRestMin: number;
  /** 截至本轮的总时长 */
  accumulatedTotalMin: number;
  /** 本轮结束时失水率 % */
  waterLossPct: number;
  /** 相对上一轮的失水率增量（百分点） */
  waterLossDeltaPct: number;
  /** 失水速率：百分点 / 小时 */
  waterLossRatePerHour: number;
}
