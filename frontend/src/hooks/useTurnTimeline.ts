/**
 * useTurnTimeline(batchId)
 * 派生做青轮次的累计摇青 / 静置时长、摇青-静置交替时间线段与失水率走势。
 * 被做青页（TurnBoard）与山场页（GardenList 的山场详情）消费。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { liveQuery, type Subscription } from 'dexie';
import { db, listTurnsByBatch } from '../utils/db';
import type { Turn, TurnSegment, TurnTimelineItem } from '../types/turn';
import { judgeHumidity, judgeRoomTemp, judgeWaterLoss, minutesToReadable, roundTo, type RangeVerdict } from '../utils/tea';

export interface UseTurnTimelineResult {
  /** 按轮次升序的轮次记录 */
  turns: Turn[];
  /** 逐轮派生数据（累计时长、失水率增量与速率） */
  items: TurnTimelineItem[];
  /** 交替时间线段：摇青段与静置段依次排列 */
  segments: TurnSegment[];
  totalShakeMin: number;
  totalRestMin: number;
  totalMin: number;
  totalReadable: string;
  /** 摇青占比 % */
  shakeRatioPct: number;
  /** 末轮失水率 % */
  finalWaterLossPct: number;
  /** 峰值失水速率（百分点 / 小时） */
  peakWaterLossRatePerHour: number;
  /** 失水率走势：上升 / 平缓 / 回落 */
  trend: 'rising' | 'flat' | 'falling';
  /** 最后一轮的温湿度与失水率区间判定 */
  verdicts: {
    roomTemp: RangeVerdict | null;
    humidity: RangeVerdict | null;
    waterLoss: RangeVerdict | null;
  };
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}

/** 轮次记录 → 时间线与累计统计 */
export function buildTurnTimeline(turns: Turn[]): {
  items: TurnTimelineItem[];
  segments: TurnSegment[];
  totalShakeMin: number;
  totalRestMin: number;
  totalMin: number;
  finalWaterLossPct: number;
  peakWaterLossRatePerHour: number;
  trend: 'rising' | 'flat' | 'falling';
} {
  const ordered = [...turns].sort((a, b) => a.roundNo - b.roundNo);
  const items: TurnTimelineItem[] = [];
  const segments: TurnSegment[] = [];

  let cursor = 0;
  let accumulatedShakeMin = 0;
  let accumulatedRestMin = 0;
  let previousWaterLoss = 0;
  let peakRate = 0;
  let rising = 0;
  let falling = 0;

  ordered.forEach((turn) => {
    const shakeMin = Number.isFinite(turn.shakeMin) ? Math.max(0, turn.shakeMin) : 0;
    const restMin = Number.isFinite(turn.restMin) ? Math.max(0, turn.restMin) : 0;
    const startMin = cursor;
    const shakeEndMin = startMin + shakeMin;
    const endMin = shakeEndMin + restMin;

    const shakeSegment: TurnSegment = {
      turnId: turn.id,
      roundNo: turn.roundNo,
      kind: 'shake',
      startMin,
      endMin: shakeEndMin,
      durationMin: shakeMin,
    };
    const restSegment: TurnSegment = {
      turnId: turn.id,
      roundNo: turn.roundNo,
      kind: 'rest',
      startMin: shakeEndMin,
      endMin,
      durationMin: restMin,
    };
    segments.push(shakeSegment, restSegment);

    accumulatedShakeMin += shakeMin;
    accumulatedRestMin += restMin;

    const waterLossDeltaPct = roundTo(turn.waterLossPct - previousWaterLoss, 1);
    const roundHours = (shakeMin + restMin) / 60;
    const waterLossRatePerHour = roundHours > 0 ? roundTo(waterLossDeltaPct / roundHours, 2) : 0;
    if (waterLossRatePerHour > peakRate) peakRate = waterLossRatePerHour;
    if (waterLossDeltaPct > 0.2) rising += 1;
    if (waterLossDeltaPct < -0.2) falling += 1;

    items.push({
      turn,
      startMin,
      endMin,
      shakeEndMin,
      shakeSegment,
      restSegment,
      accumulatedShakeMin: roundTo(accumulatedShakeMin, 1),
      accumulatedRestMin: roundTo(accumulatedRestMin, 1),
      accumulatedTotalMin: roundTo(accumulatedShakeMin + accumulatedRestMin, 1),
      waterLossPct: turn.waterLossPct,
      waterLossDeltaPct,
      waterLossRatePerHour,
    });

    previousWaterLoss = turn.waterLossPct;
    cursor = endMin;
  });

  return {
    items,
    segments,
    totalShakeMin: roundTo(accumulatedShakeMin, 1),
    totalRestMin: roundTo(accumulatedRestMin, 1),
    totalMin: roundTo(accumulatedShakeMin + accumulatedRestMin, 1),
    finalWaterLossPct: ordered.length > 0 ? ordered[ordered.length - 1].waterLossPct : 0,
    peakWaterLossRatePerHour: peakRate,
    trend: rising > falling ? 'rising' : falling > rising ? 'falling' : 'flat',
  };
}

export function useTurnTimeline(batchId: string | null | undefined): UseTurnTimelineResult {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const batchIdRef = useRef<string | null | undefined>(batchId);
  batchIdRef.current = batchId;

  useEffect(() => {
    const target = batchId ?? null;
    if (!target) {
      setTurns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const subscription: Subscription = liveQuery(() => listTurnsByBatch(target)).subscribe({
      next: (value) => {
        setTurns(value);
        setError('');
        setLoading(false);
      },
      error: (err: unknown) => {
        setError(err instanceof Error ? err.message : '做青轮次读取失败');
        setLoading(false);
      },
    });
    return () => subscription.unsubscribe();
  }, [batchId]);

  const refresh = useCallback(async () => {
    const target = batchIdRef.current;
    if (!target) return;
    try {
      setTurns(await listTurnsByBatch(target));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '做青轮次读取失败');
    }
  }, []);

  const derived = useMemo(() => buildTurnTimeline(turns), [turns]);

  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  const verdicts = useMemo(
    () => ({
      roomTemp: lastTurn ? judgeRoomTemp(lastTurn.roomTempC) : null,
      humidity: lastTurn ? judgeHumidity(lastTurn.humidityPct) : null,
      waterLoss: lastTurn ? judgeWaterLoss(lastTurn.waterLossPct) : null,
    }),
    [lastTurn],
  );

  const shakeRatioPct = derived.totalMin > 0 ? roundTo((derived.totalShakeMin / derived.totalMin) * 100, 1) : 0;

  return {
    turns,
    items: derived.items,
    segments: derived.segments,
    totalShakeMin: derived.totalShakeMin,
    totalRestMin: derived.totalRestMin,
    totalMin: derived.totalMin,
    totalReadable: minutesToReadable(derived.totalMin),
    shakeRatioPct,
    finalWaterLossPct: derived.finalWaterLossPct,
    peakWaterLossRatePerHour: derived.peakWaterLossRatePerHour,
    trend: derived.trend,
    verdicts,
    loading,
    error,
    refresh,
  };
}

export default useTurnTimeline;

/** 供页面在非 React 场景（导出前预览）复用的时间线构建器 */
export async function loadTurnTimeline(batchId: string): Promise<ReturnType<typeof buildTurnTimeline>> {
  const turns = await db.turns.where('batchId').equals(batchId).toArray();
  return buildTurnTimeline(turns);
}
