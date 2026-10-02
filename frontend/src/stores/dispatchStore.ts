/**
 * 工位调度状态管理（Zustand）· dispatchStore.ts
 * - liveQuery 订阅 workstations / dispatchOrders（所有窗口共享同一份 IndexedDB）
 * - 租约生命周期：心跳续租 + 周期清扫僵死占用 + pagehide 立即释放
 * - 全局「执行调度」弹窗：杀青页 / 焙火页 / 调度台三处共用同一套占用 → 确认流程
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import { db } from '../utils/db';
import {
  HEARTBEAT_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
  type DispatchOrder,
  type DispatchTaskKind,
  type Workstation,
} from '../types/dispatch';
import type { Fix, FixDraft } from '../types/fix';
import type { Roast, RoastDraft } from '../types/roast';
import {
  heartbeat,
  releaseOnPageHide,
  subscribeDispatchChanged,
  tickScheduler,
} from '../utils/scheduler';

/** 业务落库载荷（二选一：杀青揉捻记录 / 焙火道次）；为空表示纯占台演示 */
export type DispatchBusinessPayload =
  | { kind: 'FIX'; draft: FixDraft }
  | { kind: 'ROAST'; draft: RoastDraft }
  | { kind: 'DEMO' };

export interface PendingDispatchRun {
  batchId: string;
  task: DispatchTaskKind;
  note: string;
  payload: DispatchBusinessPayload;
  /** 确认成功后的回调（页面用来刷新自己的表格 / 提示） */
  onComplete?: (record: Fix | Roast | null) => void | Promise<void>;
}

interface DispatchStoreState {
  workstations: Workstation[];
  orders: DispatchOrder[];
  loading: boolean;
  error: string;
  initialized: boolean;
  /** 全局执行弹窗当前请求 */
  pendingRun: PendingDispatchRun | null;
  initRuntime: () => void;
  refresh: () => Promise<void>;
  openRun: (run: PendingDispatchRun) => void;
  closeRun: () => void;
}

export const useDispatchStore = create<DispatchStoreState>((set) => ({
  workstations: [],
  orders: [],
  loading: true,
  error: '',
  initialized: false,
  pendingRun: null,

  initRuntime() {
    if (useDispatchStore.getState().initialized) return;
    set({ initialized: true });

    liveQuery(() => db.workstations.toArray()).subscribe({
      next: (rows) => set({ workstations: rows }),
      error: (err: unknown) => set({ error: err instanceof Error ? err.message : '工位数据读取失败' }),
    });
    liveQuery(() => db.dispatchOrders.toArray()).subscribe({
      next: (rows) => set({ orders: rows, loading: false }),
      error: (err: unknown) =>
        set({ error: err instanceof Error ? err.message : '调度单数据读取失败', loading: false }),
    });

    // 租约维护：本窗口心跳续租 + 推进自己的队列
    const beat = window.setInterval(() => {
      void heartbeat().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);

    // 兜底清扫：把其他窗口僵死的 HELD 超时释放（窗口被直接杀死、pagehide 没送达时）
    const sweep = window.setInterval(() => {
      void tickScheduler().catch(() => undefined);
    }, SWEEP_INTERVAL_MS);

    // 其他窗口一旦有调度变更，本窗口立刻跑一轮，不必等下一次轮询
    const unsubscribe = subscribeDispatchChanged(() => {
      void tickScheduler().catch(() => undefined);
    });

    // 页面关闭 / 刷新：本会话占用立刻释放、保留原队位。
    // 仅监听 pagehide（真正卸载）；切到后台标签不算关闭，由 30s 租约 TTL 兜底。
    const onHide = (): void => {
      void releaseOnPageHide();
    };
    window.addEventListener('pagehide', onHide);

    window.addEventListener('beforeunload', () => {
      window.clearInterval(beat);
      window.clearInterval(sweep);
      unsubscribe();
    });
  },

  async refresh() {
    try {
      const [workstations, orders] = await Promise.all([db.workstations.toArray(), db.dispatchOrders.toArray()]);
      set({ workstations, orders });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '调度数据读取失败' });
    }
  },

  openRun(run) {
    set({ pendingRun: run });
  },

  closeRun() {
    set({ pendingRun: null });
  },
}));

export default useDispatchStore;
