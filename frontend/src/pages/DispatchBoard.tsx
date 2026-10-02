/**
 * /dispatch 工位调度台
 * - 工位实时占用：揉捻机 / 焙火炉剩余容量、占用批次与所属窗口、停用 / 启用
 * - FIFO 队列：名次、提交时间、任务、等待原因（与山场台账 / 杀青记录同源）
 * - 占用中：租约倒计时、确认（纯占台演示）、模拟保存失败、放弃
 * - 排队 / 失败：重试（保留原队位）、取消；历史：已确认 / 已取消留档
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ClockCircleOutlined,
  FireOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import RunDispatchDialog from '../components/common/RunDispatchDialog';
import { useDispatchStore } from '../stores/dispatchStore';
import { useBatchStore } from '../stores/batchStore';
import { useGardenStore } from '../stores/gardenStore';
import {
  capacitySummary,
  finishedOrders,
  heldOrders,
  waitingOrders,
  workstationUsages,
} from '../utils/dispatchViews';
import {
  DISPATCH_REASON_LABEL,
  DISPATCH_STATE_LABEL,
  DISPATCH_TASK_KINDS,
  DISPATCH_TASK_LABEL,
  LEASE_COUNTDOWN_MS,
  WORKSTATION_KIND_LABEL,
  type DispatchOrder,
  type DispatchTaskKind,
} from '../types/dispatch';
import {
  cancelOrder,
  confirmOrder,
  failOrder,
  retryOrder,
  setWorkstationEnabled,
  SESSION_LABEL,
  tickScheduler,
} from '../utils/scheduler';
import { batchLabel } from '../utils/tea';

interface NewOrderForm {
  batchId: string;
  task: DispatchTaskKind;
}

export default function DispatchBoard() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<NewOrderForm>();
  const [now, setNow] = useState(() => Date.now());

  const workstations = useDispatchStore((state) => state.workstations);
  const orders = useDispatchStore((state) => state.orders);
  const loading = useDispatchStore((state) => state.loading);
  const refresh = useDispatchStore((state) => state.refresh);
  const openRun = useDispatchStore((state) => state.openRun);
  const closeRun = useDispatchStore((state) => state.closeRun);
  const pendingRun = useDispatchStore((state) => state.pendingRun);

  const batches = useBatchStore((state) => state.batches);
  const gardens = useGardenStore((state) => state.gardens);

  // 1 秒时钟：驱动租约倒计时
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const gardenMap = useMemo(() => new Map(gardens.map((garden) => [garden.id, garden])), [gardens]);
  const labelOf = (batchId: string): string => {
    const batch = batches.find((item) => item.id === batchId);
    return batch ? batchLabel(batch, gardenMap.get(batch.gardenId)?.name) : '批次已删除';
  };

  const usage = useMemo(() => workstationUsages(orders, workstations), [orders, workstations]);
  const held = useMemo(() => heldOrders(orders), [orders]);
  const waiting = useMemo(() => waitingOrders(orders), [orders]);
  const finished = useMemo(() => finishedOrders(orders), [orders]);
  const capacity = useMemo(() => capacitySummary(orders, workstations), [orders, workstations]);

  const submitNew = (values: NewOrderForm): void => {
    openRun({
      batchId: values.batchId,
      task: values.task,
      note: DISPATCH_TASK_LABEL[values.task],
      payload: { kind: 'DEMO' },
      onComplete: () => {
        message.success('占台演示已确认');
      },
    });
  };

  const handleRetry = async (order: DispatchOrder): Promise<void> => {
    try {
      await retryOrder(order.id);
      await tickScheduler();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重试失败');
    }
  };

  const handleFail = async (order: DispatchOrder): Promise<void> => {
    try {
      await failOrder(order.id);
      message.warning('已模拟保存失败：工位释放，原队位保留');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };

  const handleConfirmDemo = async (order: DispatchOrder): Promise<void> => {
    try {
      await confirmOrder(order.id);
      message.success(`#${order.seq} 已确认，工位已释放`);
      if (pendingRun?.batchId === order.batchId) closeRun();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '确认失败');
    }
  };

  const handleCancel = (order: DispatchOrder): void => {
    modal.confirm({
      title: `取消调度单 #${order.seq}？`,
      content: order.state === 'HELD' ? '该单正占用工位，取消后工位立即释放给队列后续批次。' : '取消后该单退出队列，后续批次名次前移。',
      okText: '确认取消',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: async () => {
        try {
          await cancelOrder(order.id);
          message.success('调度单已取消');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '取消失败');
        }
      },
    });
  };

  const toggleEnabled = async (workstationId: string, enabled: boolean): Promise<void> => {
    try {
      await setWorkstationEnabled(workstationId, enabled);
      message.success(enabled ? '工位已启用，队列将尝试放行' : '工位已停用，容量重算');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };

  const orderColumns: ColumnsType<DispatchOrder> = [
    {
      title: '名次',
      dataIndex: 'seq',
      width: 70,
      render: (seq: number) => <Typography.Text strong>#{seq}</Typography.Text>,
    },
    {
      title: '批次',
      dataIndex: 'batchId',
      width: 230,
      render: (batchId: string) => labelOf(batchId),
    },
    {
      title: '任务',
      dataIndex: 'task',
      width: 100,
      render: (task: DispatchTaskKind) => (
        <Tag icon={task === 'FIX' ? <ThunderboltOutlined /> : <FireOutlined />} color={task === 'FIX' ? 'gold' : 'orange'}>
          {DISPATCH_TASK_LABEL[task]}
        </Tag>
      ),
    },
    {
      title: '状态 / 占用',
      key: 'state',
      width: 230,
      render: (_: unknown, row) => {
        if (row.state === 'HELD') {
          const remainMs = Math.max(0, Date.parse(row.leaseExpiresAt) - now);
          const pct = Math.round((remainMs / LEASE_COUNTDOWN_MS) * 100);
          const names = row.heldWorkstationIds
            .map((id) => workstations.find((ws) => ws.id === id)?.name ?? id)
            .join('、');
          return (
            <Space direction="vertical" size={2}>
              <Tag icon={<LockOutlined />} color="volcano">
                {DISPATCH_STATE_LABEL.HELD} · {Math.ceil(remainMs / 1000)}s
              </Tag>
              <Progress percent={pct} size="small" showInfo={false} strokeColor="#b0413e" style={{ width: 150, margin: 0 }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {names}
              </Typography.Text>
            </Space>
          );
        }
        const color =
          row.state === 'QUEUED' ? 'gold' : row.state === 'FAILED' ? 'red' : row.state === 'CONFIRMED' ? 'green' : 'default';
        return <Tag color={color}>{DISPATCH_STATE_LABEL[row.state]}</Tag>;
      },
    },
    {
      title: '异常原因',
      dataIndex: 'reason',
      render: (reason: DispatchOrder['reason']) => (
        <Typography.Text type={reason === 'none' || reason === 'confirmed' ? 'secondary' : 'warning'} style={{ fontSize: 12 }}>
          {DISPATCH_REASON_LABEL[reason]}
        </Typography.Text>
      ),
    },
    {
      title: '重试',
      dataIndex: 'attempts',
      width: 70,
      render: (attempts: number) => (attempts > 0 ? <Tag>{attempts} 次</Tag> : '—'),
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      render: (_: unknown, row) => {
        if (row.state === 'HELD') {
          return (
            <Space size={2} wrap>
              <Button size="small" type="link" onClick={() => void handleConfirmDemo(row)}>
                确认
              </Button>
              <Button size="small" type="link" danger onClick={() => void handleFail(row)}>
                模拟失败
              </Button>
              <Button size="small" type="link" danger onClick={() => handleCancel(row)}>
                放弃
              </Button>
            </Space>
          );
        }
        if (row.state === 'QUEUED' || row.state === 'FAILED') {
          return (
            <Space size={2} wrap>
              <Button size="small" type="link" onClick={() => void handleRetry(row)}>
                重试占用
              </Button>
              <Button size="small" type="link" danger onClick={() => handleCancel(row)}>
                取消
              </Button>
            </Space>
          );
        }
        return <Typography.Text type="secondary">已终结</Typography.Text>;
      },
    },
  ];

  const activeOrders = useMemo(
    () =>
      [...held, ...waiting].sort((a, b) => {
        if (a.state === 'HELD' && b.state !== 'HELD') return -1;
        if (a.state !== 'HELD' && b.state === 'HELD') return 1;
        return a.seq - b.seq;
      }),
    [held, waiting],
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            工位调度台
          </Typography.Title>
          <div className="page-hint">
            揉捻机与焙火炉同时分配、按提交先后 FIFO 排队（队头阻塞不插队、不占一半）；占用 30 秒内确认，
            超时或页面关闭自动释放并保留原队位。本窗口编号 {SESSION_LABEL}。
          </div>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void Promise.all([refresh(), tickScheduler()])}>
            刷新并重算
          </Button>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="揉捻机占用" value={`${capacity.rollerUsed}/${capacity.rollerTotal}`} suffix="台" tone="warning" />
        <StatBadge label="焙火炉占用" value={`${capacity.ovenUsed}/${capacity.ovenTotal}`} suffix="座" tone="danger" />
        <StatBadge label="排队 / 失败" value={waiting.length} suffix="单" tone="primary" />
        <StatBadge label="占用中" value={held.length} suffix="单" tone="danger" />
        <StatBadge label="已处理留档" value={finished.length} suffix="单" tone="success" />
      </div>

      <Row gutter={[14, 14]}>
        {usage.map(({ workstation, heldBy, occupied }) => {
          const remainSec = heldBy ? Math.max(0, Math.ceil((Date.parse(heldBy.leaseExpiresAt) - now) / 1000)) : 0;
          return (
            <Col key={workstation.id} xs={24} sm={12} xl={6}>
              <Card
                className="panel-card workstation-card"
                size="small"
                title={
                  <Space size={6}>
                    <span>{workstation.name}</span>
                    <Tag>{WORKSTATION_KIND_LABEL[workstation.kind]}</Tag>
                  </Space>
                }
                extra={
                  <Tooltip title={workstation.enabled ? '停用后该工位不参与容量' : '启用后队列会立即尝试放行'}>
                    <Button size="small" type="link" onClick={() => void toggleEnabled(workstation.id, !workstation.enabled)}>
                      {workstation.enabled ? '停用' : '启用'}
                    </Button>
                  </Tooltip>
                }
              >
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Tag color={occupied ? 'volcano' : workstation.enabled ? 'green' : 'default'}>
                    {occupied ? `占用中 · ${remainSec}s 后超时` : workstation.enabled ? '空闲' : '已停用'}
                  </Tag>
                  {heldBy ? (
                    <Typography.Text style={{ fontSize: 12 }}>
                      #{heldBy.seq} {labelOf(heldBy.batchId)} · {DISPATCH_TASK_LABEL[heldBy.task]}
                    </Typography.Text>
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {workstation.note || '暂无备注'}
                    </Typography.Text>
                  )}
                </Space>
              </Card>
            </Col>
          );
        })}
      </Row>

      <Card
        className="panel-card"
        style={{ marginTop: 14 }}
        title={
          <Space>
            <PlusOutlined />
            <span>提交调度（杀青揉捻 / 焙火安排都要同时拿到揉捻机 + 焙火炉）</span>
          </Space>
        }
      >
        <Form
          form={form}
          layout="inline"
          onFinish={submitNew}
          initialValues={{ batchId: batches[0]?.id, task: DISPATCH_TASK_KINDS[0] }}
        >
          <Form.Item name="batchId" label="茶青批次" rules={[{ required: true, message: '请选择批次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: 280 }}
              options={batches.map((batch) => ({
                value: batch.id,
                label: `${batchLabel(batch, gardenMap.get(batch.gardenId)?.name)} · ${batch.state}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="task" label="任务" rules={[{ required: true }]}>
            <Select
              style={{ width: 130 }}
              options={DISPATCH_TASK_KINDS.map((task) => ({ value: task, label: DISPATCH_TASK_LABEL[task] }))}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<ClockCircleOutlined />} disabled={batches.length === 0}>
              提交并排号
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {activeOrders.length === 0 ? (
        <EmptyPanel
          title="当前没有排队或占用中的调度单"
          description="在上方提交调度，或从杀青揉捻、焙火安排页发起；容量不够时按提交先后在此排队，工位占用与异常原因三处台账同源可见。"
          size="small"
        />
      ) : (
        <Card className="panel-card" style={{ marginTop: 14 }} title="调度队列与占用（FIFO）">
          <Table<DispatchOrder>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={activeOrders}
            columns={orderColumns}
            pagination={false}
            scroll={{ x: 1080 }}
          />
        </Card>
      )}

      {finished.length > 0 ? (
        <Card className="panel-card" style={{ marginTop: 14 }} title="处理留档（已确认 / 已取消）">
          <Table<DispatchOrder>
            rowKey="id"
            size="small"
            dataSource={finished.slice(0, 20)}
            columns={orderColumns}
            pagination={false}
            scroll={{ x: 1080 }}
          />
        </Card>
      ) : null}

      {batches.length === 0 ? (
        <Empty style={{ marginTop: 16 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有茶青批次，先到山场台账登记批次" />
      ) : null}

      <RunDispatchDialog />
    </div>
  );
}
