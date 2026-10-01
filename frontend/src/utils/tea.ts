/**
 * 岩茶工艺知识工具集（utils/tea.ts）
 * 只做纯函数换算与枚举映射：嫩度 / 火功 / 工序状态映射、温湿度与失水率区间判定、
 * 审评评分加权换算、拼配候选排序。不碰数据库、不碰 React。
 */
import { ALTITUDE_BANDS, type Cultivar, type Garden, type Soil } from '../types/garden';
import type { Batch, BatchState, Tenderness } from '../types/batch';
import { TURN_LIMITS, type Turn } from '../types/turn';
import type { FixLevel, RollPressure } from '../types/fix';
import {
  ROAST_STATES,
  type Charcoal,
  type FireLevel,
  type Roast,
  type RoastReminder,
  type RoastState,
} from '../types/roast';
import {
  BLEND_CANDIDATE_SCORE,
  REVIEW_SCORE_MAX,
  REVIEW_TOTAL_MAX,
  REVIEW_WEIGHTS,
  type BlendCandidate,
  type Review,
  type ReviewScoreKey,
} from '../types/review';

/* ------------------------------ 嫩度映射 ------------------------------ */

/** 嫩度 → 展示文案 */
export const TENDERNESS_LABEL: Record<Tenderness, string> = {
  一芽两叶: '一芽两叶（嫩采）',
  一芽三叶: '一芽三叶（常规）',
  开面采: '开面采（成熟）',
};

/** 嫩度 → 标签底色 */
export const TENDERNESS_COLOR: Record<Tenderness, string> = {
  一芽两叶: 'green',
  一芽三叶: 'cyan',
  开面采: 'gold',
};

/** 嫩度 → 做青建议 */
export const TENDERNESS_ADVICE: Record<Tenderness, string> = {
  一芽两叶: '嫩叶宜轻摇多次，缩短单次静置',
  一芽三叶: '常规摇青 3-4 轮，注意走水均匀',
  开面采: '成熟叶耐摇，可延长摇青并控温走水',
};

/* --------------------------- 工序状态映射 --------------------------- */

/** 工序状态 → 标签底色 */
export const BATCH_STATE_COLOR: Record<BatchState, string> = {
  做青中: 'processing',
  已杀青: 'cyan',
  已焙火: 'orange',
  已审评: 'green',
};

/** 揉捻压力 → 标签底色 */
export const ROLL_PRESSURE_COLOR: Record<RollPressure, string> = {
  轻: 'green',
  中: 'blue',
  重: 'volcano',
};

/** 焙火状态 → 标签底色 */
export const ROAST_STATE_COLOR: Record<RoastState, string> = {
  待焙: 'default',
  焙火中: 'processing',
  已足火: 'gold',
};

/** 炭种 → 标签底色 */
export const CHARCOAL_COLOR: Record<Charcoal, string> = {
  荔枝炭: 'volcano',
  龙眼炭: 'orange',
  机制炭: 'default',
};

/** 土壤 / 品种 → 标签底色（山场卡片复用） */
export const SOIL_COLOR: Record<Soil, string> = {
  砾壤: 'gold',
  红壤: 'volcano',
  沙壤: 'blue',
};

export const CULTIVAR_COLOR: Record<Cultivar, string> = {
  水仙: 'green',
  肉桂: 'magenta',
  名丛: 'purple',
};

/* --------------------------- 山场与批次文案 --------------------------- */

/** 海拔落点所属分段名称 */
export function altitudeBandLabel(altitudeM: number): string {
  const band = ALTITUDE_BANDS.find((item) => altitudeM >= item.minM && altitudeM <= item.maxM);
  return band ? band.label : '未标注海拔';
}

/** 批次展示名：山场·采摘日·嫩度 */
export function batchLabel(batch: Batch, gardenName?: string): string {
  const head = gardenName ? `${gardenName} · ` : '';
  return `${head}${batch.pickedAt} · ${batch.tenderness}`;
}

/** 数值四舍五入到指定小数位 */
export function roundTo(value: number, digits = 1): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 分钟 → 「x 小时 y 分钟」 */
export function minutesToReadable(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  if (hour <= 0) return `${minute} 分钟`;
  if (minute === 0) return `${hour} 小时`;
  return `${hour} 小时 ${minute} 分钟`;
}

/** 求平均分（无数据返回 null） */
export function averageScore(scores: number[]): number | null {
  if (scores.length === 0) return null;
  const sum = scores.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
  return roundTo(sum / scores.length, 1);
}

/* ----------------------------- 区间判定 ----------------------------- */

/** 区间判定结果 */
export interface RangeVerdict {
  level: 'low' | 'ok' | 'high';
  label: string;
  hint: string;
}

/** 做青室温判定：目标 20-26 ℃ */
export function judgeRoomTemp(tempC: number): RangeVerdict {
  if (tempC < 20) {
    return { level: 'low', label: '室温偏低', hint: '可关窗升温，摇青后静置时间适当缩短' };
  }
  if (tempC > 26) {
    return { level: 'high', label: '室温偏高', hint: '注意通风降温，防止红边过快' };
  }
  return { level: 'ok', label: '室温适宜', hint: '适宜做青走水（20-26 ℃）' };
}

/** 做青湿度判定：目标 60-80 % */
export function judgeHumidity(humidityPct: number): RangeVerdict {
  if (humidityPct < 60) {
    return { level: 'low', label: '湿度偏低', hint: '地面洒水或缩短静置，避免失水过快' };
  }
  if (humidityPct > 80) {
    return { level: 'high', label: '湿度偏高', hint: '加强通风，延长静置走水时间' };
  }
  return { level: 'ok', label: '湿度适宜', hint: '适宜走水（60-80 %）' };
}

/** 失水率判定：做青全程目标 12-20 % */
export function judgeWaterLoss(waterLossPct: number): RangeVerdict {
  if (waterLossPct < 12) {
    return { level: 'low', label: '失水不足', hint: '尚需补 1-2 轮摇青，继续走水' };
  }
  if (waterLossPct > 20) {
    return { level: 'high', label: '失水偏多', hint: '及时杀青，避免叶张干脆' };
  }
  return { level: 'ok', label: '失水到位', hint: '可进入杀青工序（12-20 %）' };
}

/** 摇青时长判定：单轮 3-12 分钟为宜 */
export function judgeShakeMin(shakeMin: number): RangeVerdict {
  if (shakeMin < TURN_LIMITS.shakeMin.min + 3) {
    return { level: 'low', label: '摇青偏轻', hint: '可增加 1-2 分钟摇青促进走水' };
  }
  if (shakeMin > 12) {
    return { level: 'high', label: '摇青偏重', hint: '注意叶缘红边程度，下一轮适当减时' };
  }
  return { level: 'ok', label: '摇青适宜', hint: '单轮 3-12 分钟为宜' };
}

/** 杀青强度判定：锅温与时长综合 */
export function judgeFixLevel(wokTempC: number, fixMin: number, rollPressure: RollPressure): FixLevel {
  const heat = (wokTempC / 180) * (fixMin / 6);
  const pressureWeight = rollPressure === '重' ? 1.15 : rollPressure === '中' ? 1 : 0.9;
  const score = heat * pressureWeight;
  if (score < 0.85) return '偏轻';
  if (score > 1.25) return '偏重';
  return '适中';
}

/** 火功判定：按累计「温度 × 时长」换算（℃·h） */
export const FIRE_THRESHOLDS = {
  medium: 600,
  full: 1500,
} as const;

/** 焙火累计热负荷（℃·h） */
export function fireLoadOf(roasts: Roast[]): number {
  return roundTo(
    roasts.reduce((acc, roast) => acc + (Number.isFinite(roast.tempC) ? roast.tempC : 0) * (Number.isFinite(roast.hours) ? roast.hours : 0), 0),
    1,
  );
}

/** 多道次焙火 → 火功档位 */
export function fireLevelOf(roasts: Roast[]): FireLevel {
  const load = fireLoadOf(roasts);
  if (load >= FIRE_THRESHOLDS.full) return '足火';
  if (load >= FIRE_THRESHOLDS.medium) return '中火';
  return '轻火';
}

/** 火功 → 标签底色 */
export const FIRE_LEVEL_COLOR: Record<FireLevel, string> = {
  轻火: 'green',
  中火: 'orange',
  足火: 'volcano',
};

/** 火功 → 处理建议 */
export const FIRE_LEVEL_ADVICE: Record<FireLevel, string> = {
  轻火: '轻火风格，注意密封防潮，可在 1 个月内安排复焙',
  中火: '中火风格，建议间隔 20-30 天复焙一次，逐步吃火',
  足火: '已吃足火，进入退火期，静置 30 天以上再开汤审评',
};

/** 是否达到足火（热负荷达标且至少两道次） */
export function isFullFire(roasts: Roast[]): boolean {
  return fireLoadOf(roasts) >= FIRE_THRESHOLDS.full && roasts.length >= 2;
}

/** 批次当前焙火状态（无记录按「待焙」处理） */
export function currentRoastState(roasts: Roast[]): RoastState {
  if (roasts.length === 0) return '待焙';
  if (roasts.some((roast) => roast.state === '已足火')) return '已足火';
  if (roasts.some((roast) => roast.state === '焙火中')) return '焙火中';
  return ROAST_STATES[0];
}

/* ----------------------------- 复焙提醒 ----------------------------- */

/** 今天（本地时区）的 YYYY-MM-DD */
export function todayIso(): string {
  const date = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 目标日期距今天的天数差（正数=未来，负数=已过期） */
export function daysFromToday(dateIso: string, today = todayIso()): number {
  if (!dateIso) return Number.NaN;
  const target = new Date(`${dateIso}T00:00:00`);
  const base = new Date(`${today}T00:00:00`);
  if (Number.isNaN(target.getTime()) || Number.isNaN(base.getTime())) return Number.NaN;
  return Math.round((target.getTime() - base.getTime()) / 86400000);
}

/** 由复焙日期生成提醒（未填写日期返回 null） */
export function buildReminder(roast: Roast, today = todayIso()): RoastReminder | null {
  if (!roast.nextRoastDate) return null;
  const daysLeft = daysFromToday(roast.nextRoastDate, today);
  if (Number.isNaN(daysLeft)) return null;
  const level: RoastReminder['level'] =
    daysLeft < 0 ? 'overdue' : daysLeft === 0 ? 'today' : daysLeft <= 7 ? 'soon' : 'planned';
  return {
    roastId: roast.id,
    batchId: roast.batchId,
    passNo: roast.passNo,
    nextRoastDate: roast.nextRoastDate,
    daysLeft,
    level,
  };
}

/** 提醒级别 → 文案 */
export const REMINDER_LABEL: Record<RoastReminder['level'], string> = {
  overdue: '已逾期',
  today: '今日复焙',
  soon: '7 日内',
  planned: '已排期',
};

/** 提醒级别 → 标签底色 */
export const REMINDER_COLOR: Record<RoastReminder['level'], string> = {
  overdue: 'red',
  today: 'volcano',
  soon: 'orange',
  planned: 'blue',
};

/* ----------------------------- 审评换算 ----------------------------- */

/** 单项得分截断到 0-100 */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(REVIEW_SCORE_MAX, Math.max(0, value));
}

/** 分项加权换算总分（保留 1 位小数） */
export function weightedTotalScore(scores: Record<ReviewScoreKey, number>): number {
  const keys = Object.keys(REVIEW_WEIGHTS) as ReviewScoreKey[];
  const total = keys.reduce((acc, key) => acc + clampScore(scores[key]) * REVIEW_WEIGHTS[key], 0);
  return roundTo(Math.min(REVIEW_TOTAL_MAX, total), 1);
}

/** 总分档位文案 */
export function scoreGrade(score: number): string {
  if (score >= 92) return '特级';
  if (score >= 85) return '一级';
  if (score >= 75) return '二级';
  if (score >= 60) return '三级';
  return '等外';
}

/** 总分 → 标签底色 */
export function scoreColor(score: number): string {
  if (score >= 92) return 'volcano';
  if (score >= 85) return 'gold';
  if (score >= 75) return 'green';
  if (score >= 60) return 'cyan';
  return 'default';
}

/** 总分 → 星级（0-5） */
export function scoreStars(score: number): number {
  return Math.max(0, Math.min(5, Math.round(score / 20)));
}

/** 总分区间（审评页 / 拼配页下拉多选使用） */
export interface ScoreBand {
  key: string;
  label: string;
  minScore: number;
  maxScore: number;
}

export const SCORE_BANDS: ScoreBand[] = [
  { key: 'special', label: '特级（≥92 分）', minScore: 92, maxScore: 100 },
  { key: 'first', label: '一级（85-91.9 分）', minScore: 85, maxScore: 91.9 },
  { key: 'second', label: '二级（75-84.9 分）', minScore: 75, maxScore: 84.9 },
  { key: 'third', label: '三级（60-74.9 分）', minScore: 60, maxScore: 74.9 },
  { key: 'below', label: '等外（<60 分）', minScore: 0, maxScore: 59.9 },
];

/** 分数是否命中选中的区间集合（空集合表示不筛选） */
export function matchScoreBand(score: number, bandKeys: string[]): boolean {
  if (bandKeys.length === 0) return true;
  return bandKeys.some((key) => {
    const band = SCORE_BANDS.find((item) => item.key === key);
    return band ? score >= band.minScore && score <= band.maxScore : false;
  });
}

/* ----------------------------- 拼配候选 ----------------------------- */

/** 按总分由高到低生成拼配候选清单 */
export function buildBlendCandidates(reviews: Review[], batches: Batch[], gardens: Garden[]): BlendCandidate[] {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  const gardenMap = new Map(gardens.map((garden) => [garden.id, garden]));
  return reviews
    .filter((review) => batchMap.has(review.batchId))
    .map((review) => {
      const batch = batchMap.get(review.batchId) as Batch;
      const garden = gardenMap.get(batch.gardenId);
      return {
        reviewId: review.id,
        batchId: review.batchId,
        batchLabel: batchLabel(batch, garden ? garden.name : undefined),
        gardenId: batch.gardenId,
        gardenName: garden ? garden.name : '未知山场',
        cultivar: garden ? garden.cultivar : '未标注',
        totalScore: review.totalScore,
        state: batch.state,
        pickedAt: batch.pickedAt,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore);
}

/** 是否达到拼配候选门槛 */
export function isBlendCandidate(score: number): boolean {
  return score >= BLEND_CANDIDATE_SCORE;
}

/** 拼配占比总和是否合法（允许 0.1 的浮点误差） */
export function isRatioValid(ratios: number[]): boolean {
  if (ratios.length === 0) return false;
  const sum = ratios.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
  return Math.abs(sum - 100) <= 0.1;
}

/* ----------------------------- 轮次统计 ----------------------------- */

/** 轮次合计：摇青 / 静置 / 总时长 */
export function sumTurnMinutes(turns: Turn[]): { shakeMin: number; restMin: number; totalMin: number } {
  const shakeMin = turns.reduce((acc, turn) => acc + (Number.isFinite(turn.shakeMin) ? turn.shakeMin : 0), 0);
  const restMin = turns.reduce((acc, turn) => acc + (Number.isFinite(turn.restMin) ? turn.restMin : 0), 0);
  return { shakeMin: roundTo(shakeMin, 1), restMin: roundTo(restMin, 1), totalMin: roundTo(shakeMin + restMin, 1) };
}

/** 取轮次末次的失水率（无轮次返回 0） */
export function finalWaterLoss(turns: Turn[]): number {
  if (turns.length === 0) return 0;
  const ordered = [...turns].sort((a, b) => a.roundNo - b.roundNo);
  return ordered[ordered.length - 1].waterLossPct;
}
