/**
 * 山场状态管理（Zustand）· gardenStore.ts
 * 维护山场列表、派生指标（批次数 / 鲜叶合计 / 审评均分）、当前选中山场与筛选条件。
 */
import { create } from 'zustand';
import { ALTITUDE_BANDS, type Garden, type GardenDraft, type GardenMetrics } from '../types/garden';
import {
  ID_PREFIX,
  countAll,
  createId,
  listBatches,
  listGardens,
  listReviews,
  nowIso,
  putGarden,
  removeGarden as removeGardenRow,
} from '../utils/db';
import { averageScore, roundTo } from '../utils/tea';
import { emptyFilterValue, matchKeyword, pickedIncludes, pickedSelect, type FilterValue } from '../components/common/FilterBar';

/** 山场页筛选条件默认值：关键字 + 品种 / 土壤 / 海拔分段三个下拉多选 */
export const DEFAULT_GARDEN_FILTERS: FilterValue = emptyFilterValue(['cultivars', 'soils', 'bands']);

/** 纯函数：按关键字、品种、土壤、海拔分段过滤山场 */
export function filterGardens(gardens: Garden[], filters: FilterValue): Garden[] {
  const bands = pickedSelect(filters, 'bands');
  return gardens.filter((garden) => {
    if (!matchKeyword(filters.keyword, garden.name, garden.aspect, garden.cultivar, garden.soil)) return false;
    if (!pickedIncludes(filters, 'cultivars', garden.cultivar)) return false;
    if (!pickedIncludes(filters, 'soils', garden.soil)) return false;
    if (bands.length > 0) {
      const hit = bands.some((key) => {
        const band = ALTITUDE_BANDS.find((item) => item.key === key);
        return band ? garden.altitudeM >= band.minM && garden.altitudeM <= band.maxM : false;
      });
      if (!hit) return false;
    }
    return true;
  });
}

interface GardenStoreState {
  gardens: Garden[];
  /** 山场派生指标：key = gardenId */
  metrics: Record<string, GardenMetrics>;
  /** 各表行数概览（页脚 / 统计徽标） */
  counts: Record<string, number>;
  currentGardenId: string | null;
  filters: FilterValue;
  loading: boolean;
  error: string;
  initialized: boolean;
  loadGardens: () => Promise<void>;
  refreshCounts: () => Promise<void>;
  setFilters: (filters: FilterValue) => void;
  resetFilters: () => void;
  selectGarden: (gardenId: string | null) => void;
  createGarden: (draft: GardenDraft) => Promise<Garden>;
  updateGarden: (gardenId: string, draft: GardenDraft) => Promise<void>;
  deleteGarden: (gardenId: string) => Promise<void>;
}

/** 依据山场 / 批次 / 审评计算指标 */
async function buildMetrics(gardens: Garden[]): Promise<{ metrics: Record<string, GardenMetrics> }> {
  const [batches, reviews] = await Promise.all([listBatches(), listReviews()]);
  const scoreByBatch = new Map(reviews.map((review) => [review.batchId, review.totalScore]));
  const metrics: Record<string, GardenMetrics> = {};
  const scoresByGarden: Record<string, number[]> = {};

  gardens.forEach((garden) => {
    metrics[garden.id] = {
      gardenId: garden.id,
      batchCount: 0,
      freshLeafKg: 0,
      averageScore: null,
      latestPickedAt: null,
    };
  });

  batches.forEach((batch) => {
    const metric = metrics[batch.gardenId];
    if (!metric) return;
    metric.batchCount += 1;
    metric.freshLeafKg = roundTo(metric.freshLeafKg + batch.freshLeafKg, 1);
    if (!metric.latestPickedAt || batch.pickedAt > metric.latestPickedAt) {
      metric.latestPickedAt = batch.pickedAt;
    }
    const score = scoreByBatch.get(batch.id);
    if (typeof score === 'number') {
      scoresByGarden[batch.gardenId] = [...(scoresByGarden[batch.gardenId] ?? []), score];
    }
  });

  Object.values(metrics).forEach((metric) => {
    metric.averageScore = averageScore(scoresByGarden[metric.gardenId] ?? []);
  });

  return { metrics };
}

export const useGardenStore = create<GardenStoreState>((set, get) => ({
  gardens: [],
  metrics: {},
  counts: {},
  currentGardenId: null,
  filters: DEFAULT_GARDEN_FILTERS,
  loading: false,
  error: '',
  initialized: false,

  async loadGardens() {
    set({ loading: true, error: '' });
    try {
      const gardens = await listGardens();
      const { metrics } = await buildMetrics(gardens);
      const currentGardenId = get().currentGardenId;
      set({
        gardens,
        metrics,
        loading: false,
        initialized: true,
        currentGardenId: currentGardenId && gardens.some((item) => item.id === currentGardenId) ? currentGardenId : (gardens[0]?.id ?? null),
      });
      await get().refreshCounts();
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '山场数据读取失败' });
    }
  },

  async refreshCounts() {
    try {
      set({ counts: await countAll() });
    } catch {
      // 行数概览失败不阻断主流程
    }
  },

  setFilters(filters) {
    set({ filters });
  },

  resetFilters() {
    set({ filters: DEFAULT_GARDEN_FILTERS });
  },

  selectGarden(gardenId) {
    set({ currentGardenId: gardenId });
  },

  async createGarden(draft) {
    const stamp = nowIso();
    const row: Garden = {
      id: createId(ID_PREFIX.garden),
      name: draft.name.trim(),
      altitudeM: draft.altitudeM,
      soil: draft.soil,
      cultivar: draft.cultivar,
      aspect: draft.aspect.trim(),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await putGarden(row);
    await get().loadGardens();
    set({ currentGardenId: row.id });
    return row;
  },

  async updateGarden(gardenId, draft) {
    const existing = get().gardens.find((item) => item.id === gardenId);
    if (!existing) return;
    const next: Garden = {
      ...existing,
      name: draft.name.trim(),
      altitudeM: draft.altitudeM,
      soil: draft.soil,
      cultivar: draft.cultivar,
      aspect: draft.aspect.trim(),
      updatedAt: nowIso(),
    };
    await putGarden(next);
    await get().loadGardens();
  },

  async deleteGarden(gardenId) {
    await removeGardenRow(gardenId);
    if (get().currentGardenId === gardenId) set({ currentGardenId: null });
    await get().loadGardens();
  },
}));

/** 便捷选择器：当前选中山场 */
export function selectCurrentGarden(state: GardenStoreState): Garden | null {
  return state.gardens.find((item) => item.id === state.currentGardenId) ?? null;
}

export default useGardenStore;
