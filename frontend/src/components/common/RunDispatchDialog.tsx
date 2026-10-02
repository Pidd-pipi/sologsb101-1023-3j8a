/**
 * <RunDispatchDialog> 全局工位占用执行弹窗
 *
 * 流程：提交调度单 → QUEUED（显示名次与排队原因）→ HELD（显示占用工位与租约倒计时，
 * 同时拿到揉捻机 + 焙火炉）→ 确认（业务落库与状态推进在同一事务）。
 * 支持：保存失败模拟（工位释放、回原队位）、取消、重试；租约超时 / 页面关闭后
 * 单子回 QUEUED 等待，名次不变。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, App, Button, Modal, Space, Tag, Typography } from 'antd';
import { FireOutlined, LockOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { liveQuery } from 'dexie';
import { db, nowIso, createId, ID_PREFIX } from '../../utils/db';
import {
  DISPATCH_REASON_LABEL,
  DISPATCH_STATE_LABEL,
  DISPATCH_TASK_LABEL,
  type DispatchOrder,
} from '../../types/dispatch';
import type { Fix } from '../../types/fix';
import type { Roast } from '../../types/roast';
import {
  cancelOrder,
  confirmOrder,
  failOrder,
  retryOrder,
  submitOrder,
  tickScheduler,
} from '../../utils/scheduler';
import { batchDispatchSummary, heldOrders, waitingOrders } from '../../utils/dispatchViews';
import { useDispatchStore } from '../../stores/dispatchStore';
import { useBatchStore } from '../../stores/batchStore';
import { useGardenStore } from '../../stores/gardenStore';
import { batchLabel } from '../../utils/tea';

/** 全局未确认占用：存在其他 HELD 单时给出提示 */
function useGlobalHoldBlock(excludeOrderId?: string) {
  const orders = useDispatchStore((state) => state.orders);
  return useMemo(
    () => heldOrders(orders).find((item) => item.id !== excludeOrderId) ?? null,
    [orders, excludeOrderId],
  );
}

export default function RunDispatchDialog() {
  const { message } = App.useApp();
  const pendingRun = useDispatchStore((state) => state.pendingRun);
  const closeRun = useDispatchStore((state) => state.closeRun);
  const workstations = useDispatchStore((state) => state.workstations);
  const storeOrders = useDispatchStore((state) => state.orders);
  const batches = useBatchStore((state) => state.batches);
  const gardens = useGardenStore((state) => state.gardens);

  const [orderId, setOrderId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [lastError, setLastError] = useState('');

  const pending = pendingRun;
  const batch = pending ? batches.find((item) => item.id === pending.batchId) ?? null : null;
  const garden = batch ? gardens.find((item) => item.id === batch.gardenId) ?? null : null;

  // 1 秒时钟：驱动租约倒计时显示
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  // 弹窗打开：重置并立即提交调度单。
  // 用「提交中 key」ref 保证同一次打开只提交一次（兼容 React StrictMode 的双调用，
  // 以及 act 测试环境的模拟重挂载）；异步结果只认当前打开的这一次请求。
  const inflightKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pending) {
      setOrderId(null);
      setLastError('');
      setSubmitting(false);
      setConfirming(false);
      inflightKeyRef.current = null;
      return;
    }
    const requestKey = `${pending.batchId}::${pending.task}::${pending.note}`;
    if (inflightKeyRef.current === requestKey) return;
    inflightKeyRef.current = requestKey;
    setOrderId(null);
    setLastError('');
    setSubmitting(true);
    void (async () => {
      try {
        const order = await submitOrder({
          batchId: pending.batchId,
          task: pending.task,
          note: pending.note,
        });
        // 只要弹窗仍是这一次请求就接收结果；StrictMode 重挂载不会作废已完成的提交
        if (inflightKeyRef.current === requestKey) setOrderId(order.id);
      } catch (error) {
        if (inflightKeyRef.current === requestKey) {
          setLastError(error instanceof Error ? error.message : '调度单提交失败');
        }
      } finally {
        if (inflightKeyRef.current === requestKey) setSubmitting(false);
      }
    })();
  }, [pending]);

  // 直接订阅这一张单子（其他窗口 / 清扫 / 心跳引起的状态变化都能即时反映）
  const [liveOrder, setLiveOrder] = useState<DispatchOrder | null>(null);
  useEffect(() => {
    if (!orderId) {
      setLiveOrder(null);
      return;
    }
    const subscription = liveQuery(() => db.dispatchOrders.get(orderId)).subscribe({
      next: (row) => setLiveOrder((row as DispatchOrder | undefined) ?? null),
      error: () => setLiveOrder(null),
    });
    return () => subscription.unsubscribe();
  }, [orderId]);

  const order = liveOrder ?? storeOrders.find((item) => item.id === orderId) ?? null;
  const summary = pending
    ? batchDispatchSummary(pending.batchId, storeOrders, workstations)
    : null;
  const heldNameMap = useMemo(() => new Map(workstations.map((ws) => [ws.id, ws.name])), [workstations]);
  const blocker = useGlobalHoldBlock(order?.id);

  const waiting = useMemo(() => (order ? waitingOrders(storeOrders) : []), [order, storeOrders]);
  const queuePosition = order ? waiting.findIndex((item) => item.id === order.id) + 1 : 0;
  const queueLength = waiting.length;

  const remainMs = order?.leaseExpiresAt ? Math.max(0, Date.parse(order.leaseExpiresAt) - now) : 0;
  const remainSec = Math.ceil(remainMs / 1000);

  const finishSuccess = async (record: Fix | Roast | null): Promise<void> => {
    const run = pending;
    if (!run) return;
    await Promise.resolve(run.onComplete?.(record));
    message.success('工位占用已确认，工位已释放给后续排队批次');
    closeRun();
  };

  /* ------------------------------- 确认（业务落库） ------------------------------- */

  const handleConfirm = async (): Promise<void> => {
    const target = order;
    const run = pending;
    if (!target || !run) return;
    setConfirming(true);
    setLastError('');
    try {
      const confirmed = await confirmOrder(target.id, async (held) => {
        if (run.payload.kind === 'FIX') {
          const stamp = nowIso();
          const fix: Fix = {
            id: createId(ID_PREFIX.fix),
            batchId: held.batchId,
            wokTempC: run.payload.draft.wokTempC,
            fixMin: run.payload.draft.fixMin,
            rollPressure: run.payload.draft.rollPressure,
            rollMin: run.payload.draft.rollMin,
            operator: run.payload.draft.operator,
            createdAt: stamp,
            updatedAt: stamp,
          };
          await db.fixes.put(fix);
          // 工序闸门在调度层已校验，这里只做只进不退的状态推进
          const currentBatch = await db.batches.get(held.batchId);
          if (currentBatch && currentBatch.state === '做青中') {
            await db.batches.put({ ...currentBatch, state: '已杀青', updatedAt: stamp });
          }
          return { recordId: fix.id };
        }
        if (run.payload.kind === 'ROAST') {
          const stamp = nowIso();
          const branch = await db.roasts.where('batchId').equals(held.batchId).toArray();
          const roast: Roast = {
            id: createId(ID_PREFIX.roast),
            batchId: held.batchId,
            passNo: branch.length + 1,
            tempC: run.payload.draft.tempC,
            hours: run.payload.draft.hours,
            charcoal: run.payload.draft.charcoal,
            nextRoastDate: run.payload.draft.nextRoastDate,
            state: run.payload.draft.state,
            createdAt: stamp,
            updatedAt: stamp,
          };
          await db.roasts.put(roast);
          return { recordId: roast.id };
        }
        return { recordId: '' };
      });

      const record =
        confirmed.recordId && run.payload.kind === 'FIX'
          ? ((await db.fixes.get(confirmed.recordId)) ?? null)
          : confirmed.recordId && run.payload.kind === 'ROAST'
            ? ((await db.roasts.get(confirmed.recordId)) ?? null)
            : null;
      await finishSuccess(record as Fix | Roast | null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : '确认失败');
    } finally {
      setConfirming(false);
    }
  };

  /* ------------------------------- 失败模拟 / 重试 / 取消 ------------------------------- */

  const handleSimulateFail = async (): Promise<void> => {
    if (!order) return;
    try {
      await failOrder(order.id);
      message.warning('业务记录保存失败：工位已释放，调度单保留原队位，可重试');
    } catch (error) {
      setLastError(error instanceof Error ? error.message : '释放失败');
    }
  };

  const handleRetry = async (): Promise<void> => {
    if (!order) return;
    setSubmitting(true);
    setLastError('');
    try {
      await retryOrder(order.id);
      // 被前序挡住时仍是排队；本窗口刚释放出容量的场景立刻补一轮调度
      await tickScheduler();
    } catch (error) {
      setLastError(error instanceof Error ? error.message : '重试失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (): Promise<void> => {
    if (!order) {
      closeRun();
      return;
    }
    try {
      await cancelOrder(order.id);
      message.info('调度单已取消，工位未被占用');
      closeRun();
    } catch (error) {
      setLastError(error instanceof Error ? error.message : '取消失败');
    }
  };

  /* --------------------------------- 渲染 --------------------------------- */

  const taskIcon = pending?.task === 'FIX' ? <ThunderboltOutlined /> : <FireOutlined />;
  const okDisabled = !order || order.state !== 'HELD' || confirming || submitting || blocker !== null || remainMs <= 0;

  let footer: ReactNode = null;
  if (order?.state === 'HELD') {
    footer = (
      <Space wrap>
        <Button danger ghost onClick={() => void handleSimulateFail()} disabled={confirming}>
          模拟保存失败
        </Button>
        <Button onClick={() => void handleCancel()} disabled={confirming}>
          放弃占用
        </Button>
        <Button type="primary" loading={confirming} disabled={okDisabled} onClick={() => void handleConfirm()}>
          确认并保存（释放工位给下一单）
        </Button>
      </Space>
    );
  } else if (order?.state === 'FAILED') {
    footer = (
      <Space>
        <Button onClick={() => void handleCancel()}>取消调度</Button>
        <Button type="primary" loading={submitting} onClick={() => void handleRetry()}>
          重试占用（原队位）
        </Button>
      </Space>
    );
  } else if (order?.state === 'CONFIRMED' || order?.state === 'CANCELLED') {
    footer = (
      <Button onClick={() => closeRun()}>关闭</Button>
    );
  } else {
    footer = (
      <Space>
        <Button onClick={() => void handleCancel()} loading={submitting}>
          取消排队
        </Button>
        <Button type="primary" loading disabled>
          等待工位中…
        </Button>
      </Space>
    );
  }

  return (
    <Modal
      open={pending !== null}
      width={620}
      closable={false}
      maskClosable={false}
      keyboard={false}
      title={
        <Space>
          {taskIcon}
          <span>{pending ? `${DISPATCH_TASK_LABEL[pending.task]} · 工位调度` : '工位调度'}</span>
          {order ? <Tag color="default">#{order.seq}</Tag> : null}
        </Space>
      }
      footer={footer}
    >
      {pending && batch ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Text strong>批次：</Typography.Text>
            <Typography.Text>{batchLabel(batch, garden?.name)}</Typography.Text>
            <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
              当前工序「{batch.state}」
            </Typography.Text>
          </div>

          {!order ? (
            <Alert showIcon type="info" message={submitting ? '正在提交调度单…' : DISPATCH_REASON_LABEL.queued} />
          ) : null}

          {order?.state === 'QUEUED' ? (
            <Alert
              showIcon
              type="warning"
              message={`排队中 · 第 ${queuePosition > 0 ? queuePosition : '—'} / ${queueLength} 位（按提交先后，不能插队）`}
              description={
                <Space direction="vertical" size={4}>
                  <span>异常原因：{DISPATCH_REASON_LABEL[order.reason]}</span>
                  <span>揉捻机与焙火炉会同时分配；队头任一类工位不足，后到者一律等待。</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    关闭本页会释放已占用工位并保留此队位，重新打开调度台可重试。
                  </Typography.Text>
                </Space>
              }
            />
          ) : null}

          {order?.state === 'HELD' ? (
            <Alert
              showIcon
              type="success"
              icon={<LockOutlined />}
              message={
                <Space wrap>
                  <span>已同时拿到两类工位，剩余确认时间 {remainSec} 秒</span>
                  <Tag color="volcano">{DISPATCH_STATE_LABEL.HELD}</Tag>
                </Space>
              }
              description={
                <Space direction="vertical" size={4}>
                  <Space wrap>
                    {order.heldWorkstationIds.map((id) => (
                      <Tag key={id} color="volcano">
                        {heldNameMap.get(id) ?? id}
                      </Tag>
                    ))}
                  </Space>
                  <span>超时未确认将自动释放工位、保留原队位；保存失败也会释放并可重试。</span>
                  {blocker ? (
                    <Typography.Text type="danger">
                      #{blocker.seq} 占用未确认：{DISPATCH_REASON_LABEL.held_unconfirmed}
                    </Typography.Text>
                  ) : null}
                </Space>
              }
            />
          ) : null}

          {order?.state === 'FAILED' ? (
            <Alert
              showIcon
              type="error"
              message="保存失败：工位已释放，原队位保留"
              description={`当前排在第 ${summary?.queuePosition ?? '—'} 位；点「重试占用」将以 #${order.seq} 的原队位重新申请，前序未完成时仍需等待。`}
            />
          ) : null}

          {order?.state === 'CONFIRMED' ? (
            <Alert showIcon type="success" message={DISPATCH_REASON_LABEL.confirmed} />
          ) : null}
          {order?.state === 'CANCELLED' ? (
            <Alert showIcon type="info" message={DISPATCH_REASON_LABEL.cancelled} />
          ) : null}

          {lastError ? <Alert showIcon type="error" message={lastError} /> : null}
        </Space>
      ) : null}
    </Modal>
  );
}
