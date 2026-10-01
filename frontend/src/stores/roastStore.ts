/**
 * 焙火状态管理（Zustand）· roastStore.ts
 * 维护焙火道次（多道次按序排列）、复焙提醒、足火判定（待焙→焙火中→已足火）与筛选条件。
 */
import { create } from 'zustand';
import { nextRoastState, type Roast, type RoastDraft, type RoastReminder, type RoastState } from '../types/roast';
import type { Batch } from '../types/batch';
import type { Garden } from '../types/garden';
import {
  ID_PREFIX,
  createId,
  listRoasts,
  listRoastsByBatch,
  nowIso,
  putRoast,
  putRoasts,
  removeRoast as removeRoastRow,
} from '../utils/db';
import { buildReminder, fireLevelOf, fireLoadOf } from '../utils/tea';
import { emptyFilterValue, matchKeyword, pickedIncludes, pickedSelect, type FilterValue } from '../components/common/FilterBar';
import { useBatchStore } from './batchStore';

/** 焙火页筛选条件默认值：关键字 + 批次 / 道次状态 / 炭种 / 山场四个下拉多选 */
export const DEFAULT_ROAST_FILTERS: FilterValue = emptyFilterValue(['batchIds', 'states', 'charcoals', 'gardenIds']);

/** 纯函数：按关键字、批次、道次状态、炭种、山场过滤焙火记录 */
export function filterRoasts(roasts: Roast[], batches: Batch[], gardens: Garden[], filters: FilterValue): Roast[] {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  const gardenNameOf = (batch: Batch | undefined): string => {
    if (!batch) return '';
    return gardens.find((garden) => garden.id === batch.gardenId)?.name ?? '';
  };
  const charcoals = pickedSelect(filters, 'charcoals');
  const batchIds = pickedSelect(filters, 'batchIds');
  return roasts.filter((roast) => {
    const batch = batchMap.get(roast.batchId);
    if (!batch) return false;
    if (!matchKeyword(filters.keyword, gardenNameOf(batch), batch.pickedAt, roast.charcoal, `第 ${roast.passNo} 道`, roast.tempC)) {
      return false;
    }
    if (!pickedIncludes(filters, 'gardenIds', batch.gardenId)) return false;
    if (!pickedIncludes(filters, 'states', roast.state)) return false;
    if (batchIds.length > 0 && !batchIds.includes(roast.batchId)) return false;
    if (charcoals.length > 0 && !charcoals.includes(roast.charcoal)) return false;
    return true;
  });
}

interface RoastStoreState {
  roasts: Roast[];
  filters: FilterValue;
  loading: boolean;
  error: string;
  loadRoasts: () => Promise<void>;
  setFilters: (filters: FilterValue) => void;
  resetFilters: () => void;
  createRoast: (draft: RoastDraft) => Promise<Roast>;
  updateRoast: (roastId: string, draft: RoastDraft) => Promise<void>;
  deleteRoast: (roastId: string) => Promise<void>;
  /** 状态流转：待焙 → 焙火中 → 已足火；足火后自动把批次回写为「已焙火」 */
  advanceRoastState: (roastId: string) => Promise<RoastState | null>;
  /** 道次上移 / 下移（写回 passNo） */
  movePass: (roastId: string, direction: 'up' | 'down') => Promise<void>;
  /** 拖拽或批量重排后的道次顺序写回 */
  reorderPasses: (batchId: string, orderedIds: string[]) => Promise<void>;
}

export const useRoastStore = create<RoastStoreState>((set, get) => ({
  roasts: [],
  filters: DEFAULT_ROAST_FILTERS,
  loading: false,
  error: '',

  async loadRoasts() {
    set({ loading: true, error: '' });
    try {
      const roasts = await listRoasts();
      set({ roasts, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '焙火数据读取失败' });
    }
  },

  setFilters(filters) {
    set({ filters });
  },

  resetFilters() {
    set({ filters: DEFAULT_ROAST_FILTERS });
  },

  async createRoast(draft) {
    const branch = get().roasts.filter((roast) => roast.batchId === draft.batchId);
    const stamp = nowIso();
    const row: Roast = {
      id: createId(ID_PREFIX.roast),
      batchId: draft.batchId,
      passNo: branch.length + 1,
      tempC: draft.tempC,
      hours: draft.hours,
      charcoal: draft.charcoal,
      nextRoastDate: draft.nextRoastDate,
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await putRoast(row);
    await get().loadRoasts();
    return row;
  },

  async updateRoast(roastId, draft) {
    const existing = get().roasts.find((roast) => roast.id === roastId);
    if (!existing) return;
    const next: Roast = {
      ...existing,
      tempC: draft.tempC,
      hours: draft.hours,
      charcoal: draft.charcoal,
      nextRoastDate: draft.nextRoastDate,
      state: draft.state,
      updatedAt: nowIso(),
    };
    await putRoast(next);
    await get().loadRoasts();
  },

  async deleteRoast(roastId) {
    const existing = get().roasts.find((roast) => roast.id === roastId);
    if (!existing) return;
    await removeRoastRow(roastId);
    const rest = await listRoastsByBatch(existing.batchId);
    if (rest.length > 0) {
      await putRoasts(rest.map((roast, index) => ({ ...roast, passNo: index + 1, updatedAt: nowIso() })));
    }
    await get().loadRoasts();
  },

  async advanceRoastState(roastId) {
    const existing = get().roasts.find((roast) => roast.id === roastId);
    if (!existing) return null;
    const next = nextRoastState(existing.state);
    if (!next) return null;
    await putRoast({ ...existing, state: next, updatedAt: nowIso() });
    if (next === '已足火') {
      // 足火判定通过：批次工序推进到「已焙火」
      await useBatchStore.getState().markBatchState(existing.batchId, '已焙火');
    }
    await get().loadRoasts();
    return next;
  },

  async movePass(roastId, direction) {
    const existing = get().roasts.find((roast) => roast.id === roastId);
    if (!existing) return;
    const branch = get()
      .roasts.filter((roast) => roast.batchId === existing.batchId)
      .sort((a, b) => a.passNo - b.passNo);
    const index = branch.findIndex((roast) => roast.id === roastId);
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || swapIndex < 0 || swapIndex >= branch.length) return;
    const swapped = [...branch];
    const current = swapped[index];
    swapped[index] = swapped[swapIndex];
    swapped[swapIndex] = current;
    await putRoasts(swapped.map((roast, order) => ({ ...roast, passNo: order + 1, updatedAt: nowIso() })));
    await get().loadRoasts();
  },

  async reorderPasses(batchId, orderedIds) {
    if (orderedIds.length === 0) return;
    const branch = get().roasts.filter((roast) => roast.batchId === batchId);
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const reordered = [...branch]
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((roast, index) => ({ ...roast, passNo: index + 1, updatedAt: nowIso() }));
    await putRoasts(reordered);
    await get().loadRoasts();
  },
}));

/** 某批次的道次（按 passNo 升序） */
export function roastsOfBatch(roasts: Roast[], batchId: string): Roast[] {
  return roasts.filter((roast) => roast.batchId === batchId).sort((a, b) => a.passNo - b.passNo);
}

/** 某批次的火功档位 */
export function fireLevelOfBatch(roasts: Roast[], batchId: string): ReturnType<typeof fireLevelOf> {
  return fireLevelOf(roastsOfBatch(roasts, batchId));
}

/** 某批次累计热负荷（℃·h） */
export function fireLoadOfBatch(roasts: Roast[], batchId: string): number {
  return fireLoadOf(roastsOfBatch(roasts, batchId));
}

/** 全部复焙提醒（按到期紧急度排序） */
export function buildReminders(roasts: Roast[]): RoastReminder[] {
  return roasts
    .map((roast) => buildReminder(roast))
    .filter((item): item is RoastReminder => item !== null)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

export default useRoastStore;
