/**
 * 茶青批次状态管理（Zustand）· batchStore.ts
 * 维护批次列表、工序状态流转（做青中→已杀青→已焙火→已审评）、
 * 杀青页 / 审评页 / 拼配页的跨页筛选条件与拼配方案草稿。
 */
import { create } from 'zustand';
import {
  BATCH_STATES,
  batchStateOrder,
  nextBatchState,
  type Batch,
  type BatchDraft,
  type BatchState,
  type BatchStateCounts,
} from '../types/batch';
import type { BlendCandidate, Review } from '../types/review';
import type { Fix } from '../types/fix';
import type { Garden } from '../types/garden';
import {
  ID_PREFIX,
  createId,
  listBatches,
  listFixes,
  listReviews,
  nowIso,
  putBatch,
  removeBatch as removeBatchRow,
} from '../utils/db';
import { batchLabel, matchScoreBand, roundTo } from '../utils/tea';
import { emptyFilterValue, matchKeyword, pickedIncludes, pickedSelect, type FilterValue } from '../components/common/FilterBar';

/** 批次筛选（/gardens 的批次子表与派生统计复用） */
export const DEFAULT_BATCH_FILTERS: FilterValue = emptyFilterValue(['gardenIds', 'states', 'tendernesses']);
/** 杀青揉捻页筛选 */
export const DEFAULT_FIX_FILTERS: FilterValue = emptyFilterValue(['gardenIds', 'batchIds', 'pressures']);
/** 审评页筛选 */
export const DEFAULT_REVIEW_FILTERS: FilterValue = emptyFilterValue(['gardenIds', 'batchIds', 'bands']);
/** 拼配页筛选 */
export const DEFAULT_BLEND_FILTERS: FilterValue = emptyFilterValue(['gardenIds', 'bands', 'states']);

/** 拼配方案草稿项 */
export interface BlendDraftItem {
  batchId: string;
  reviewId: string;
  ratioPct: number;
}

/* ------------------------------ 纯过滤函数 ------------------------------ */

/** 批次筛选：关键字（批次标签 / 气象）/ 山场 / 工序状态 / 嫩度 */
export function filterBatches(batches: Batch[], gardens: Garden[], filters: FilterValue): Batch[] {
  const gardenMap = new Map(gardens.map((garden) => [garden.id, garden]));
  return batches.filter((batch) => {
    const garden = gardenMap.get(batch.gardenId);
    if (!matchKeyword(filters.keyword, batchLabel(batch, garden?.name), batch.weather, batch.tenderness, batch.state)) {
      return false;
    }
    if (!pickedIncludes(filters, 'gardenIds', batch.gardenId)) return false;
    if (!pickedIncludes(filters, 'states', batch.state)) return false;
    if (!pickedIncludes(filters, 'tendernesses', batch.tenderness)) return false;
    return true;
  });
}

/** 杀青揉捻筛选：关键字（操作人 / 批次）/ 山场 / 批次 / 揉捻压力 */
export function filterFixes(fixes: Fix[], batches: Batch[], gardens: Garden[], filters: FilterValue): Fix[] {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  const gardenMap = new Map(gardens.map((garden) => [garden.id, garden]));
  const pressures = pickedSelect(filters, 'pressures');
  return fixes.filter((fix) => {
    const batch = batchMap.get(fix.batchId);
    const garden = batch ? gardenMap.get(batch.gardenId) : undefined;
    const label = batch ? batchLabel(batch, garden?.name) : '';
    if (!matchKeyword(filters.keyword, fix.operator, fix.rollPressure, label, fix.wokTempC)) {
      return false;
    }
    if (!batch) return false;
    if (!pickedIncludes(filters, 'gardenIds', batch.gardenId)) return false;
    if (pickedSelect(filters, 'batchIds').length > 0 && !pickedSelect(filters, 'batchIds').includes(fix.batchId)) return false;
    if (pressures.length > 0 && !pressures.includes(fix.rollPressure)) return false;
    return true;
  });
}

/** 审评筛选：关键字（批次 / 拼配去向）/ 山场 / 批次 / 总分区间 */
export function filterReviews(reviews: Review[], batches: Batch[], gardens: Garden[], filters: FilterValue): Review[] {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  const gardenMap = new Map(gardens.map((garden) => [garden.id, garden]));
  const bands = pickedSelect(filters, 'bands');
  const batchIds = pickedSelect(filters, 'batchIds');
  return reviews.filter((review) => {
    const batch = batchMap.get(review.batchId);
    if (!batch) return false;
    const garden = gardenMap.get(batch.gardenId);
    if (!matchKeyword(filters.keyword, batchLabel(batch, garden?.name), review.blendNote, review.reviewedAt)) return false;
    if (!pickedIncludes(filters, 'gardenIds', batch.gardenId)) return false;
    if (batchIds.length > 0 && !batchIds.includes(review.batchId)) return false;
    if (!matchScoreBand(review.totalScore, bands)) return false;
    return true;
  });
}

/** 拼配候选筛选：关键字（山场 / 批次 / 品种）/ 山场 / 总分区间 / 批次状态 */
export function filterBlendCandidates(candidates: BlendCandidate[], filters: FilterValue): BlendCandidate[] {
  const bands = pickedSelect(filters, 'bands');
  return candidates.filter((candidate) => {
    if (!matchKeyword(filters.keyword, candidate.gardenName, candidate.batchLabel, candidate.cultivar, candidate.state)) {
      return false;
    }
    if (!pickedIncludes(filters, 'gardenIds', candidate.gardenId)) return false;
    if (!matchScoreBand(candidate.totalScore, bands)) return false;
    if (!pickedIncludes(filters, 'states', candidate.state)) return false;
    return true;
  });
}

/** 工序状态计数 */
export function countBatchStates(batches: Batch[]): BatchStateCounts {
  const counts = BATCH_STATES.reduce((acc, state) => {
    acc[state] = 0;
    return acc;
  }, {} as BatchStateCounts);
  batches.forEach((batch) => {
    counts[batch.state] += 1;
  });
  return counts;
}

interface BatchStoreState {
  batches: Batch[];
  fixes: Fix[];
  reviews: Review[];
  filters: FilterValue;
  fixFilters: FilterValue;
  reviewFilters: FilterValue;
  blendFilters: FilterValue;
  blendDraft: BlendDraftItem[];
  blendPlanName: string;
  currentBatchId: string | null;
  loading: boolean;
  error: string;
  loadBatches: () => Promise<void>;
  loadReviews: () => Promise<void>;
  setFilters: (filters: FilterValue) => void;
  setFixFilters: (filters: FilterValue) => void;
  setReviewFilters: (filters: FilterValue) => void;
  setBlendFilters: (filters: FilterValue) => void;
  resetFixFilters: () => void;
  resetReviewFilters: () => void;
  resetBlendFilters: () => void;
  selectBatch: (batchId: string | null) => void;
  createBatch: (draft: BatchDraft) => Promise<Batch>;
  updateBatch: (batchId: string, draft: BatchDraft) => Promise<void>;
  deleteBatch: (batchId: string) => Promise<void>;
  /** 推进到下一道工序；已审评返回 null */
  advanceBatchState: (batchId: string) => Promise<BatchState | null>;
  /** 工序回写：仅允许向后推进，不会回退 */
  markBatchState: (batchId: string, target: BatchState) => Promise<BatchState | null>;
  setBlendPlanName: (name: string) => void;
  toggleBlendBatch: (batchId: string, reviewId: string) => void;
  setBlendRatio: (batchId: string, ratioPct: number) => void;
  setBlendDraft: (items: BlendDraftItem[]) => void;
  autoFillBlendDraft: (candidates: BlendCandidate[], limit?: number) => void;
  clearBlendDraft: () => void;
  blendRatioTotal: () => number;
}

export const useBatchStore = create<BatchStoreState>((set, get) => ({
  batches: [],
  fixes: [],
  reviews: [],
  filters: DEFAULT_BATCH_FILTERS,
  fixFilters: DEFAULT_FIX_FILTERS,
  reviewFilters: DEFAULT_REVIEW_FILTERS,
  blendFilters: DEFAULT_BLEND_FILTERS,
  blendDraft: [],
  blendPlanName: '拼配方案 A',
  currentBatchId: null,
  loading: false,
  error: '',

  async loadBatches() {
    set({ loading: true, error: '' });
    try {
      const [batches, fixes] = await Promise.all([listBatches(), listFixes()]);
      const current = get().currentBatchId;
      set({
        batches,
        fixes,
        loading: false,
        currentBatchId: current && batches.some((item) => item.id === current) ? current : (batches[0]?.id ?? null),
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '批次数据读取失败' });
    }
  },

  async loadReviews() {
    try {
      set({ reviews: await listReviews() });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '审评数据读取失败' });
    }
  },

  setFilters(filters) {
    set({ filters });
  },

  setFixFilters(filters) {
    set({ fixFilters: filters });
  },

  setReviewFilters(filters) {
    set({ reviewFilters: filters });
  },

  setBlendFilters(filters) {
    set({ blendFilters: filters });
  },

  resetFixFilters() {
    set({ fixFilters: DEFAULT_FIX_FILTERS });
  },

  resetReviewFilters() {
    set({ reviewFilters: DEFAULT_REVIEW_FILTERS });
  },

  resetBlendFilters() {
    set({ blendFilters: DEFAULT_BLEND_FILTERS });
  },

  selectBatch(batchId) {
    set({ currentBatchId: batchId });
  },

  async createBatch(draft) {
    const stamp = nowIso();
    const row: Batch = {
      id: createId(ID_PREFIX.batch),
      gardenId: draft.gardenId,
      pickedAt: draft.pickedAt,
      freshLeafKg: draft.freshLeafKg,
      tenderness: draft.tenderness,
      weather: draft.weather.trim(),
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await putBatch(row);
    await get().loadBatches();
    set({ currentBatchId: row.id });
    return row;
  },

  async updateBatch(batchId, draft) {
    const existing = get().batches.find((item) => item.id === batchId);
    if (!existing) return;
    const next: Batch = {
      ...existing,
      gardenId: draft.gardenId,
      pickedAt: draft.pickedAt,
      freshLeafKg: draft.freshLeafKg,
      tenderness: draft.tenderness,
      weather: draft.weather.trim(),
      state: draft.state,
      updatedAt: nowIso(),
    };
    await putBatch(next);
    await get().loadBatches();
  },

  async deleteBatch(batchId) {
    await removeBatchRow(batchId);
    set({ blendDraft: get().blendDraft.filter((item) => item.batchId !== batchId) });
    await Promise.all([get().loadBatches(), get().loadReviews()]);
  },

  async advanceBatchState(batchId) {
    const batch = get().batches.find((item) => item.id === batchId);
    if (!batch) return null;
    const next = nextBatchState(batch.state);
    if (!next) return null;
    await get().markBatchState(batchId, next);
    return next;
  },

  async markBatchState(batchId, target) {
    const batch = get().batches.find((item) => item.id === batchId);
    if (!batch) return null;
    if (batchStateOrder(target) <= batchStateOrder(batch.state)) return batch.state;
    const next: Batch = { ...batch, state: target, updatedAt: nowIso() };
    await putBatch(next);
    await get().loadBatches();
    return target;
  },

  setBlendPlanName(name) {
    set({ blendPlanName: name });
  },

  toggleBlendBatch(batchId, reviewId) {
    const draft = get().blendDraft;
    if (draft.some((item) => item.batchId === batchId)) {
      set({ blendDraft: draft.filter((item) => item.batchId !== batchId) });
      return;
    }
    const remain = Math.max(0, 100 - get().blendRatioTotal());
    set({ blendDraft: [...draft, { batchId, reviewId, ratioPct: draft.length === 0 ? 100 : remain }] });
  },

  setBlendRatio(batchId, ratioPct) {
    set({
      blendDraft: get().blendDraft.map((item) =>
        item.batchId === batchId ? { ...item, ratioPct: Math.max(0, Math.min(100, ratioPct)) } : item,
      ),
    });
  },

  setBlendDraft(items) {
    set({ blendDraft: items });
  },

  autoFillBlendDraft(candidates, limit = 3) {
    const picked = candidates.slice(0, Math.max(2, Math.min(limit, 4)));
    if (picked.length === 0) {
      set({ blendDraft: [] });
      return;
    }
    if (picked.length === 1) {
      set({ blendDraft: [{ batchId: picked[0].batchId, reviewId: picked[0].reviewId, ratioPct: 100 }] });
      return;
    }
    const scoreSum = picked.reduce((acc, item) => acc + item.totalScore, 0);
    const raw = picked.map((item) => (scoreSum > 0 ? (item.totalScore / scoreSum) * 100 : 100 / picked.length));
    const ratios = raw.map((value) => Math.floor(value));
    const remainder = 100 - ratios.reduce((acc, value) => acc + value, 0);
    const fractionOrder = raw
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => b.fraction - a.fraction);
    for (let step = 0; step < remainder; step += 1) {
      ratios[fractionOrder[step % fractionOrder.length].index] += 1;
    }
    set({
      blendDraft: picked.map((item, index) => ({
        batchId: item.batchId,
        reviewId: item.reviewId,
        ratioPct: ratios[index],
      })),
    });
  },

  clearBlendDraft() {
    set({ blendDraft: [] });
  },

  blendRatioTotal() {
    return roundTo(
      get().blendDraft.reduce((acc, item) => acc + item.ratioPct, 0),
      1,
    );
  },
}));

export default useBatchStore;
