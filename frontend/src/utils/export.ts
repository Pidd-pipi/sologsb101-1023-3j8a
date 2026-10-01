/**
 * 导出 / 导入工具（utils/export.ts）
 * - 批次工艺记录 JSON 导出与校验
 * - 整库存档 JSON 导出与解析校验
 * - 拼配方案 JSON 导出与占比校验
 * 全部在浏览器本地完成（Blob + URL.createObjectURL + a.download），不经过任何服务端。
 */
import type { Batch } from '../types/batch';
import type { Garden } from '../types/garden';
import type { Turn } from '../types/turn';
import type { Fix } from '../types/fix';
import type { Roast } from '../types/roast';
import type { Review } from '../types/review';
import { DB_NAME, DB_VERSION, type DatabaseSnapshot } from './db';
import { batchLabel, isRatioValid, roundTo } from './tea';

/* ------------------------------ 通用下载 ------------------------------ */

/** 触发浏览器下载 */
function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** 文件名时间戳片段 */
export function stampSuffix(): string {
  const date = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}`;
}

/* --------------------------- 批次工艺记录导出 --------------------------- */

/** 单个批次的完整工艺记录（父 → 子 → 孙三层贯通） */
export interface BatchProcessBundle {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  garden: Garden | null;
  batch: Batch;
  turns: Turn[];
  fix: Fix | null;
  roasts: Roast[];
  review: Review | null;
  summary: {
    turnCount: number;
    totalShakeMin: number;
    totalRestMin: number;
    totalMin: number;
    finalWaterLossPct: number;
    fireLevel: string;
  };
}

/** 组装批次工艺记录（供导出与页面预览复用） */
export function buildBatchProcessBundle(params: {
  garden: Garden | null;
  batch: Batch;
  turns: Turn[];
  fix: Fix | null;
  roasts: Roast[];
  review: Review | null;
  fireLevel: string;
  totalShakeMin: number;
  totalRestMin: number;
  totalMin: number;
  finalWaterLossPct: number;
}): BatchProcessBundle {
  const { garden, batch, turns, fix, roasts, review, fireLevel } = params;
  return {
    name: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    garden,
    batch,
    turns: [...turns].sort((a, b) => a.roundNo - b.roundNo),
    fix,
    roasts: [...roasts].sort((a, b) => a.passNo - b.passNo),
    review,
    summary: {
      turnCount: turns.length,
      totalShakeMin: roundTo(params.totalShakeMin, 1),
      totalRestMin: roundTo(params.totalRestMin, 1),
      totalMin: roundTo(params.totalMin, 1),
      finalWaterLossPct: roundTo(params.finalWaterLossPct, 1),
      fireLevel,
    },
  };
}

/** 导出批次工艺记录 JSON */
export function exportBatchProcessJson(bundle: BatchProcessBundle): string {
  const filename = `gbtearock-批次工艺-${bundle.batch.pickedAt}-${stampSuffix()}.json`;
  download(filename, JSON.stringify(bundle, null, 2), 'application/json;charset=utf-8');
  return filename;
}

/* ------------------------------- 整库存档 ------------------------------- */

/** 导出整库存档 JSON */
export function exportSnapshotJson(snapshot: DatabaseSnapshot): string {
  const filename = `gbtearock-存档-${stampSuffix()}.json`;
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8');
  return filename;
}

/** 判断是否为非空对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验一组行记录：必须是数组且每行带 id / createdAt / updatedAt */
function assertRows(value: unknown, table: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`存档缺少「${table}」表数据或格式不是数组`);
  }
  value.forEach((row, index) => {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id) {
      throw new Error(`「${table}」第 ${index + 1} 行缺少 id`);
    }
    if (typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') {
      throw new Error(`「${table}」第 ${index + 1} 行缺少 createdAt / updatedAt`);
    }
  });
}

/**
 * 解析并校验整库存档 JSON 文本；校验失败抛出带中文说明的 Error。
 */
export function parseSnapshotJson(text: string): DatabaseSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('JSON 解析失败：文件内容不是合法 JSON');
  }
  if (!isRecord(raw)) {
    throw new Error('JSON 解析失败：顶层必须是对象');
  }
  if (raw.name !== DB_NAME) {
    throw new Error(`存档不匹配：期望库名 ${DB_NAME}，实际为 ${String(raw.name ?? '空')}`);
  }
  assertRows(raw.gardens, 'gardens');
  assertRows(raw.batches, 'batches');
  assertRows(raw.turns, 'turns');
  assertRows(raw.fixes, 'fixes');
  assertRows(raw.roasts, 'roasts');
  assertRows(raw.reviews, 'reviews');
  return {
    name: DB_NAME,
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : DB_VERSION,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString(),
    gardens: raw.gardens as DatabaseSnapshot['gardens'],
    batches: raw.batches as DatabaseSnapshot['batches'],
    turns: raw.turns as DatabaseSnapshot['turns'],
    fixes: raw.fixes as DatabaseSnapshot['fixes'],
    roasts: raw.roasts as DatabaseSnapshot['roasts'],
    reviews: raw.reviews as DatabaseSnapshot['reviews'],
  };
}

/** 读取用户选择的文件文本 */
export function readJsonFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file, 'utf-8');
  });
}

/* ------------------------------ 拼配方案 ------------------------------ */

/** 拼配方案中的一款茶 */
export interface BlendPlanItem {
  batchId: string;
  batchLabel: string;
  gardenName: string;
  cultivar: string;
  totalScore: number;
  /** 拼配占比 % */
  ratioPct: number;
  reviewId: string;
  blendNote: string;
}

/** 拼配方案导出结构 */
export interface BlendPlanPayload {
  name: string;
  schemaVersion: number;
  planName: string;
  generatedAt: string;
  itemCount: number;
  totalRatioPct: number;
  items: BlendPlanItem[];
}

/** 占比校验：数量、单项区间与合计都合法才返回 null，否则返回中文错误说明 */
export function validateBlendPlan(items: BlendPlanItem[]): string | null {
  if (items.length < 2) return '拼配方案至少需要选择 2 款毛茶';
  const invalid = items.find((item) => !Number.isFinite(item.ratioPct) || item.ratioPct <= 0 || item.ratioPct > 100);
  if (invalid) return `${invalid.batchLabel} 的占比需在 0-100 之间`;
  if (!isRatioValid(items.map((item) => item.ratioPct))) {
    const sum = roundTo(
      items.reduce((acc, item) => acc + item.ratioPct, 0),
      1,
    );
    return `占比合计 ${sum}%，必须等于 100%`;
  }
  return null;
}

/** 组装拼配方案导出结构 */
export function buildBlendPlanPayload(planName: string, items: BlendPlanItem[]): BlendPlanPayload {
  const sorted = [...items].sort((a, b) => b.ratioPct - a.ratioPct);
  return {
    name: DB_NAME,
    schemaVersion: DB_VERSION,
    planName: planName.trim() || '未命名拼配方案',
    generatedAt: new Date().toISOString(),
    itemCount: sorted.length,
    totalRatioPct: roundTo(
      sorted.reduce((acc, item) => acc + item.ratioPct, 0),
      1,
    ),
    items: sorted,
  };
}

/** 导出拼配方案 JSON（占比不合法时抛错，由页面提示） */
export function exportBlendPlanJson(payload: BlendPlanPayload): string {
  const error = validateBlendPlan(payload.items);
  if (error) throw new Error(error);
  const filename = `gbtearock-拼配方案-${stampSuffix()}.json`;
  download(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  return filename;
}

/** 拼配方案文案（写入审评记录 blendNote 字段） */
export function blendNoteOf(planName: string, item: BlendPlanItem, items: BlendPlanItem[]): string {
  const name = planName.trim() || '未命名拼配方案';
  const partners = items
    .filter((row) => row.batchId !== item.batchId)
    .map((row) => `${row.batchLabel} ${row.ratioPct}%`)
    .join('、');
  return partners ? `${name} · 占 ${item.ratioPct}%（同批：${partners}）` : `${name} · 占 ${item.ratioPct}%`;
}

/** 批次工艺记录一行摘要文案（导出前的列表预览复用） */
export function batchSummaryText(bundle: BatchProcessBundle): string {
  const gardenName = bundle.garden ? bundle.garden.name : '未知山场';
  return `${batchLabel(bundle.batch, gardenName)}｜轮次 ${bundle.summary.turnCount} 轮｜累计 ${bundle.summary.totalMin} 分钟｜失水 ${bundle.summary.finalWaterLossPct}%｜火功 ${bundle.summary.fireLevel}`;
}
