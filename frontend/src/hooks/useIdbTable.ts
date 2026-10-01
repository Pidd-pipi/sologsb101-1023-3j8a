/**
 * useIdbTable(table, options)
 * Dexie 表的响应式订阅与增删改查封装：liveQuery 订阅 + 手动 refresh。
 * 被全部列表页消费（做青轮次、杀青揉捻、审评、拼配等子表读写）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { liveQuery, type Subscription, type Table, type UpdateSpec } from 'dexie';
import { createId, nowIso } from '../utils/db';

/** 持久化实体最小约束 */
export interface IdbRow {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface UseIdbTableOptions<T> {
  /** 新建行的主键前缀，例如 'turn' */
  prefix?: string;
  /** 排序函数（列表展示顺序） */
  sort?: (a: T, b: T) => number;
  /** 是否订阅；false 时只保留空列表，便于按需加载 */
  enabled?: boolean;
}

export interface UseIdbTableResult<T> {
  rows: T[];
  count: number;
  loading: boolean;
  ready: boolean;
  error: string;
  refresh: () => Promise<void>;
  create: (draft: Omit<T, 'id' | 'createdAt' | 'updatedAt'>) => Promise<T>;
  update: (id: string, patch: Partial<Omit<T, 'id' | 'createdAt'>>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bulkPut: (rows: T[]) => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * 订阅 Dexie 表并暴露 CRUD。
 * create 会自动补 id / createdAt / updatedAt，update 自动刷新 updatedAt。
 */
export function useIdbTable<T extends IdbRow>(
  table: Table<T, string>,
  options: UseIdbTableOptions<T> = {},
): UseIdbTableResult<T> {
  const { prefix = 'row', sort, enabled = true } = options;
  const [raw, setRaw] = useState<T[]>([]);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const sortRef = useRef<((a: T, b: T) => number) | undefined>(sort);
  useEffect(() => {
    sortRef.current = sort;
  }, [sort]);

  useEffect(() => {
    if (!enabled) {
      setRaw([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const subscription: Subscription = liveQuery(() => table.toArray()).subscribe({
      next: (value) => {
        setRaw(value as T[]);
        setError('');
        setLoading(false);
        setReady(true);
      },
      error: (err: unknown) => {
        setError(err instanceof Error ? err.message : '本地数据读取失败');
        setLoading(false);
      },
    });
    return () => subscription.unsubscribe();
  }, [table, enabled]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const value = await table.toArray();
      setRaw(value as T[]);
      setError('');
      setReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '本地数据读取失败');
    } finally {
      setLoading(false);
    }
  }, [table, enabled]);

  const create = useCallback(
    async (draft: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T> => {
      const stamp = nowIso();
      const row = { ...(draft as object), id: createId(prefix), createdAt: stamp, updatedAt: stamp } as unknown as T;
      await table.put(row);
      return row;
    },
    [prefix, table],
  );

  const update = useCallback(
    async (id: string, patch: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<void> => {
      const changes = { ...(patch as object), updatedAt: nowIso() } as unknown as UpdateSpec<T>;
      await table.update(id, changes);
    },
    [table],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await table.delete(id);
    },
    [table],
  );

  const bulkPut = useCallback(
    async (rows: T[]): Promise<void> => {
      await table.bulkPut(rows);
    },
    [table],
  );

  const clear = useCallback(async (): Promise<void> => {
    await table.clear();
  }, [table]);

  const rows = useMemo(() => {
    const comparator = sortRef.current;
    return comparator ? [...raw].sort(comparator) : raw;
  }, [raw]);

  return {
    rows,
    count: rows.length,
    loading,
    ready,
    error,
    refresh,
    create,
    update,
    remove,
    bulkPut,
    clear,
  };
}

export default useIdbTable;
