/**
 * 做青轮次状态管理（Zustand）· turnStore.ts
 * 维护当前批次的轮次列表、参数模板（复制上一轮参数后微调）、
 * 拖拽排序（写回 roundNo）与失水率 / 温湿度筛选条件。
 */
import { create } from 'zustand';
import { TURN_LIMITS, type Turn, type TurnDraft, type TurnTemplate } from '../types/turn';
import { ID_PREFIX, createId, listTurnsByBatch, nowIso, putTurn, putTurns, removeTurn } from '../utils/db';
import { roundTo } from '../utils/tea';
import { emptyFilterValue, matchKeyword, pickedSelect, type FilterValue } from '../components/common/FilterBar';

/** 失水率区间下拉选项 */
export const LOSS_BANDS = [
  { value: 'low', label: '失水 <5%' },
  { value: 'mid', label: '失水 5%-12%' },
  { value: 'target', label: '失水 12%-20%' },
  { value: 'high', label: '失水 >20%' },
];

/** 室温区间下拉选项 */
export const TEMP_BANDS = [
  { value: 'cool', label: '室温 <20 ℃' },
  { value: 'fit', label: '室温 20-26 ℃' },
  { value: 'warm', label: '室温 >26 ℃' },
];

/** 摇青时长区间下拉选项 */
export const SHAKE_BANDS = [
  { value: 'light', label: '摇青 <4 分钟' },
  { value: 'normal', label: '摇青 4-10 分钟' },
  { value: 'heavy', label: '摇青 >10 分钟' },
];

/** 做青页筛选条件默认值：关键字 + 失水率 / 室温 / 摇青时长三个下拉多选 */
export const DEFAULT_TURN_FILTERS: FilterValue = emptyFilterValue(['lossBands', 'tempBands', 'shakeBands']);

function inLossBand(turn: Turn, keys: string[]): boolean {
  if (keys.length === 0) return true;
  return keys.some((key) => {
    if (key === 'low') return turn.waterLossPct < 5;
    if (key === 'mid') return turn.waterLossPct >= 5 && turn.waterLossPct <= 12;
    if (key === 'target') return turn.waterLossPct > 12 && turn.waterLossPct <= 20;
    if (key === 'high') return turn.waterLossPct > 20;
    return false;
  });
}

function inTempBand(turn: Turn, keys: string[]): boolean {
  if (keys.length === 0) return true;
  return keys.some((key) => {
    if (key === 'cool') return turn.roomTempC < 20;
    if (key === 'fit') return turn.roomTempC >= 20 && turn.roomTempC <= 26;
    if (key === 'warm') return turn.roomTempC > 26;
    return false;
  });
}

function inShakeBand(turn: Turn, keys: string[]): boolean {
  if (keys.length === 0) return true;
  return keys.some((key) => {
    if (key === 'light') return turn.shakeMin < 4;
    if (key === 'normal') return turn.shakeMin >= 4 && turn.shakeMin <= 10;
    if (key === 'heavy') return turn.shakeMin > 10;
    return false;
  });
}

/** 纯函数：按关键字与三个区间下拉过滤轮次 */
export function filterTurns(turns: Turn[], filters: FilterValue): Turn[] {
  return turns.filter((turn) => {
    if (!matchKeyword(filters.keyword, `第 ${turn.roundNo} 轮`, turn.roundNo, turn.waterLossPct, turn.roomTempC)) {
      return false;
    }
    if (!inLossBand(turn, pickedSelect(filters, 'lossBands'))) return false;
    if (!inTempBand(turn, pickedSelect(filters, 'tempBands'))) return false;
    if (!inShakeBand(turn, pickedSelect(filters, 'shakeBands'))) return false;
    return true;
  });
}

/** 复制上一轮参数后微调：摇青 +1 分钟、静置 -5 分钟、失水率 +1.5 个百分点 */
export function tweakFromPrevious(previous: Turn): TurnDraft {
  return {
    batchId: previous.batchId,
    shakeMin: Math.min(TURN_LIMITS.shakeMin.max, roundTo(previous.shakeMin + 1, 1)),
    restMin: Math.max(TURN_LIMITS.restMin.min, roundTo(previous.restMin - 5, 1)),
    roomTempC: previous.roomTempC,
    humidityPct: previous.humidityPct,
    waterLossPct: Math.min(TURN_LIMITS.waterLossPct.max, roundTo(previous.waterLossPct + 1.5, 1)),
  };
}

/** 轮次草稿默认值（无上一轮时使用） */
export function defaultTurnDraft(batchId: string): TurnDraft {
  return { batchId, shakeMin: 5, restMin: 45, roomTempC: 23, humidityPct: 72, waterLossPct: 5 };
}

interface TurnStoreState {
  turns: Turn[];
  activeBatchId: string | null;
  filters: FilterValue;
  /** 参数模板：可存可套用 */
  template: TurnTemplate | null;
  loading: boolean;
  error: string;
  loadTurns: (batchId?: string) => Promise<void>;
  setActiveBatch: (batchId: string) => Promise<void>;
  setFilters: (filters: FilterValue) => void;
  resetFilters: () => void;
  createTurn: (draft: TurnDraft) => Promise<Turn>;
  updateTurn: (turnId: string, draft: TurnDraft) => Promise<void>;
  deleteTurn: (turnId: string) => Promise<void>;
  copyPreviousTurn: (batchId?: string) => Promise<Turn | null>;
  saveTemplate: (turn: Turn) => void;
  applyTemplate: (turnId: string) => Promise<void>;
  clearTemplate: () => void;
  reorderTurns: (orderedIds: string[]) => Promise<void>;
  renumber: (batchId: string) => Promise<void>;
}

export const useTurnStore = create<TurnStoreState>((set, get) => ({
  turns: [],
  activeBatchId: null,
  filters: DEFAULT_TURN_FILTERS,
  template: null,
  loading: false,
  error: '',

  async loadTurns(batchId) {
    const target = batchId ?? get().activeBatchId;
    if (!target) {
      set({ turns: [], loading: false });
      return;
    }
    set({ loading: true, error: '' });
    try {
      const turns = await listTurnsByBatch(target);
      set({ turns, activeBatchId: target, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '做青轮次读取失败' });
    }
  },

  async setActiveBatch(batchId) {
    set({ activeBatchId: batchId });
    await get().loadTurns(batchId);
  },

  setFilters(filters) {
    set({ filters });
  },

  resetFilters() {
    set({ filters: DEFAULT_TURN_FILTERS });
  },

  async createTurn(draft) {
    const current = get().turns.filter((turn) => turn.batchId === draft.batchId);
    const stamp = nowIso();
    const row: Turn = {
      id: createId(ID_PREFIX.turn),
      batchId: draft.batchId,
      roundNo: current.length + 1,
      shakeMin: draft.shakeMin,
      restMin: draft.restMin,
      roomTempC: draft.roomTempC,
      humidityPct: draft.humidityPct,
      waterLossPct: draft.waterLossPct,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await putTurn(row);
    await get().loadTurns(draft.batchId);
    return row;
  },

  async updateTurn(turnId, draft) {
    const existing = get().turns.find((turn) => turn.id === turnId);
    if (!existing) return;
    const next: Turn = {
      ...existing,
      shakeMin: draft.shakeMin,
      restMin: draft.restMin,
      roomTempC: draft.roomTempC,
      humidityPct: draft.humidityPct,
      waterLossPct: draft.waterLossPct,
      updatedAt: nowIso(),
    };
    await putTurn(next);
    await get().loadTurns(existing.batchId);
  },

  async deleteTurn(turnId) {
    const existing = get().turns.find((turn) => turn.id === turnId);
    if (!existing) return;
    await removeTurn(turnId);
    await get().renumber(existing.batchId);
  },

  async copyPreviousTurn(batchId) {
    const target = batchId ?? get().activeBatchId;
    if (!target) return null;
    const turns = await listTurnsByBatch(target);
    const previous = turns[turns.length - 1];
    const draft = previous ? tweakFromPrevious(previous) : defaultTurnDraft(target);
    return get().createTurn(draft);
  },

  saveTemplate(turn) {
    set({
      template: {
        batchId: turn.batchId,
        shakeMin: turn.shakeMin,
        restMin: turn.restMin,
        roomTempC: turn.roomTempC,
        humidityPct: turn.humidityPct,
        waterLossPct: turn.waterLossPct,
      },
    });
  },

  async applyTemplate(turnId) {
    const template = get().template;
    const existing = get().turns.find((turn) => turn.id === turnId);
    if (!template || !existing) return;
    await get().updateTurn(turnId, {
      batchId: existing.batchId,
      shakeMin: template.shakeMin,
      restMin: template.restMin,
      roomTempC: template.roomTempC,
      humidityPct: template.humidityPct,
      waterLossPct: template.waterLossPct,
    });
  },

  clearTemplate() {
    set({ template: null });
  },

  async reorderTurns(orderedIds) {
    const { turns, activeBatchId } = get();
    if (!activeBatchId || orderedIds.length === 0) return;
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const branch = turns.filter((turn) => turn.batchId === activeBatchId);
    const reordered = [...branch]
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((turn, index) => ({ ...turn, roundNo: index + 1, updatedAt: nowIso() }));
    await putTurns(reordered);
    await get().loadTurns(activeBatchId);
  },

  async renumber(batchId) {
    const rows = await listTurnsByBatch(batchId);
    const renumbered = rows.map((turn, index) => ({ ...turn, roundNo: index + 1, updatedAt: nowIso() }));
    if (renumbered.length > 0) await putTurns(renumbered);
    if (get().activeBatchId === batchId) await get().loadTurns(batchId);
  },
}));

export default useTurnStore;
