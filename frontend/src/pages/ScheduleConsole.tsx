/**
 * /schedule 工位调度台
 * - 工位容量总览（揉捻机 / 焙火炉 / 剩余工位）
 * - 排队队列（FIFO 名次、批次、工序、等待时长、重试 / 释放）
 * - 占用中（资源、占用时长、超时倒计时、完成 / 释放）
 * - 异常记录（页面关闭 / 保存失败 / 超时释放的原因）
 * - 提交调度申请（选择批次 + 工序，原子性获取工位）
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Modal,
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
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import EmptyPanel from '../components/common/EmptyPanel';
import GradeTag from '../components/common/GradeTag';
import StatBadge from '../components/common/StatBadge';
import { useGardenStore } from '../stores/gardenStore';
import { useBatchStore } from '../stores/batchStore';
import { useScheduleStore } from '../stores/scheduleStore';
import {
  OCCUPATION_TIMEOUT_MS,
  SCHEDULE_PROCESS_LABEL,
  SCHEDULE_STATUS_COLOR,
  SCHEDULE_STATUS_LABEL,
  type ScheduleOrder,
  type ScheduleProcess,
} from '../types/schedule';
import {
  availableStations,
  formatRemaining,
  occupationRemainingSeconds,
  occupiedStations,
  queueRankOf,
  totalStations,
} from '../utils/schedule';
import { batchLabel, minutesToReadable } from '../utils/tea';

export default function ScheduleConsole() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<{ batchId: string; process: ScheduleProcess }>();

  const gardens = useGardenStore((state) => state.gardens);
  const batches = useBatchStore((state) => state.batches);

  const orders = useScheduleStore((state) => state.orders);
  const loadOrders = useScheduleStore((state) => state.loadOrders);
  const submitOrder = useScheduleStore((state) => state.submitOrder);
  const confirmOrder = useScheduleStore((state) => state.confirmOrder);
  const releaseOrder = useScheduleStore((state) => state.releaseOrder);
  const completeOrder = useScheduleStore((state) => state.completeOrder);

  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const gardenMap = useMemo(() => new Map(gardens.map((g) => [g.id, g])), [gardens]);
  const batchMap = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);
  const labelOfBatch = (batchId: string): string => {
    const batch = batchMap.get(batchId);
    if (!batch) return '未知批次';
    return batchLabel(batch, gardenMap.get(batch.gardenId)?.name);
  };

  const queueList = useMemo(() => useScheduleStore.getState().queueList(), [orders]);
  const occupationList = useMemo(() => useScheduleStore.getState().occupationList(), [orders]);
  const exceptionList = useMemo(() => useScheduleStore.getState().exceptionList(), [orders]);

  // tick 变化时触发重渲染（倒计时）
  const now = Date.now();

  const stats = useMemo(() => {
    const total = totalStations();
    const occupied = occupiedStations(orders);
    const available = availableStations(orders);
    const queued = queueList.length;
    const exceptions = exceptionList.length;
    return { total, occupied, available, queued, exceptions };
  }, [orders, queueList.length, exceptionList.length]);

  /* ------------------------------ 提交调度申请 ------------------------------ */

  const openModal = (): void => {
    setModalOpen(true);
    form.setFieldsValue({ batchId: batches[0]?.id, process: 'fix' });
  };

  const submit = async (values: { batchId: string; process: ScheduleProcess }): Promise<void> => {
    try {
      const order = await submitOrder(values.batchId, values.process);
      if (order.status === 'occupied') {
        message.success(`已分配工位：${SCHEDULE_PROCESS_LABEL[order.process]}（${labelOfBatch(order.batchId)}）`);
      } else {
        message.info(`工位已满，已按第 ${order.queueNo} 位排队（${SCHEDULE_PROCESS_LABEL[order.process]}）`);
      }
      setModalOpen(false);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '调度申请提交失败');
    }
  };

  /* ------------------------------ 队列操作 ------------------------------ */

  const handleConfirm = async (order: ScheduleOrder): Promise<void> => {
    const result = await confirmOrder(order.id);
    if (result) {
      if (result.status === 'occupied') {
        message.success(`已分配工位：${SCHEDULE_PROCESS_LABEL[result.process]}`);
      } else {
        message.info(`工位已满，保留第 ${result.queueNo} 位排队`);
      }
    }
  };

  const handleRelease = (order: ScheduleOrder): void => {
    modal.confirm({
      title: '释放工位？',
      content: `将释放「${labelOfBatch(order.batchId)}」的工位，保留原排队队位，可随时重试。`,
      okText: '确认释放',
      cancelText: '取消',
      onOk: async () => {
        await releaseOrder(order.id, '人工释放工位');
        message.success('工位已释放，保留原队位');
      },
    });
  };

  const handleComplete = async (order: ScheduleOrder): Promise<void> => {
    await completeOrder(order.id);
    message.success(`「${labelOfBatch(order.batchId)}」已完成，工位已释放`);
  };

  /* ------------------------------ 列定义 ------------------------------ */

  const queueColumns: ColumnsType<ScheduleOrder> = [
    {
      title: '名次',
      key: 'rank',
      width: 70,
      render: (_: unknown, row) => {
        const rank = queueRankOf(orders, row.id);
        return rank !== null ? <Tag color="volcano">第 {rank} 位</Tag> : '—';
      },
    },
    {
      title: '茶青批次',
      key: 'batch',
      render: (_: unknown, row) => {
        const batch = batchMap.get(row.batchId);
        return batch ? (
          <Space size={6} wrap>
            <span>{labelOfBatch(row.batchId)}</span>
            <GradeTag kind="tenderness" value={batch.tenderness} />
          </Space>
        ) : (
          <Tag color="red">批次已删除</Tag>
        );
      },
    },
    {
      title: '工序',
      dataIndex: 'process',
      width: 110,
      render: (value: ScheduleProcess) => <Tag color="blue">{SCHEDULE_PROCESS_LABEL[value]}</Tag>,
    },
    {
      title: '排队序号',
      dataIndex: 'queueNo',
      width: 90,
      render: (value: number) => <span className="mono">#{value}</span>,
    },
    {
      title: '等待时长',
      key: 'wait',
      width: 110,
      render: (_: unknown, row) => {
        const waitMs = now - new Date(row.submittedAt).getTime();
        return <span className="mono">{minutesToReadable(Math.floor(waitMs / 60000))}</span>;
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: ScheduleOrder['status']) => (
        <Tag color={SCHEDULE_STATUS_COLOR[value]}>{SCHEDULE_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: unknown, row) => (
        <Space size={2} wrap>
          <Button size="small" type="link" icon={<PlayCircleOutlined />} onClick={() => void handleConfirm(row)}>
            确认占用
          </Button>
          <Button size="small" type="link" danger icon={<StopOutlined />} onClick={() => handleRelease(row)}>
            释放
          </Button>
        </Space>
      ),
    },
  ];

  const occupationColumns: ColumnsType<ScheduleOrder> = [
    {
      title: '茶青批次',
      key: 'batch',
      render: (_: unknown, row) => {
        const batch = batchMap.get(row.batchId);
        return batch ? (
          <Space size={6} wrap>
            <span>{labelOfBatch(row.batchId)}</span>
            <GradeTag kind="tenderness" value={batch.tenderness} />
          </Space>
        ) : (
          <Tag color="red">批次已删除</Tag>
        );
      },
    },
    {
      title: '工序',
      dataIndex: 'process',
      width: 110,
      render: (value: ScheduleProcess) => <Tag color="blue">{SCHEDULE_PROCESS_LABEL[value]}</Tag>,
    },
    {
      title: '揉捻机',
      key: 'roller',
      width: 120,
      render: (_: unknown, row) => <Tag color="gold">{row.rollerId ?? '—'}</Tag>,
    },
    {
      title: '焙火炉',
      key: 'oven',
      width: 120,
      render: (_: unknown, row) => <Tag color="orange">{row.ovenId ?? '—'}</Tag>,
    },
    {
      title: '已占用',
      key: 'occupied',
      width: 110,
      render: (_: unknown, row) => {
        if (!row.occupiedAt) return '—';
        const elapsedMs = now - new Date(row.occupiedAt).getTime();
        return <span className="mono">{minutesToReadable(Math.floor(elapsedMs / 60000))}</span>;
      },
    },
    {
      title: '超时倒计时',
      key: 'timeout',
      width: 120,
      render: (_: unknown, row) => {
        if (!row.expiresAt) return '—';
        const remaining = occupationRemainingSeconds(row, now);
        const isWarning = remaining < 60;
        return (
          <Tooltip title={`占用超时后将自动释放（${Math.round(OCCUPATION_TIMEOUT_MS / 60000)} 分钟）`}>
            <Tag color={remaining > 0 ? (isWarning ? 'volcano' : 'green') : 'red'} icon={<ClockCircleOutlined />}>
              {remaining > 0 ? formatRemaining(remaining) : '已超时'}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: unknown, row) => (
        <Space size={2} wrap>
          <Button size="small" type="link" icon={<CheckCircleOutlined />} onClick={() => void handleComplete(row)}>
            完成
          </Button>
          <Button size="small" type="link" danger icon={<StopOutlined />} onClick={() => handleRelease(row)}>
            释放
          </Button>
        </Space>
      ),
    },
  ];

  const exceptionColumns: ColumnsType<ScheduleOrder> = [
    {
      title: '茶青批次',
      key: 'batch',
      render: (_: unknown, row) => labelOfBatch(row.batchId),
    },
    {
      title: '工序',
      dataIndex: 'process',
      width: 110,
      render: (value: ScheduleProcess) => <Tag color="blue">{SCHEDULE_PROCESS_LABEL[value]}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: ScheduleOrder['status']) => (
        <Tag color={SCHEDULE_STATUS_COLOR[value]} icon={<ExclamationCircleOutlined />}>
          {SCHEDULE_STATUS_LABEL[value]}
        </Tag>
      ),
    },
    {
      title: '异常原因',
      dataIndex: 'exceptionReason',
      ellipsis: true,
      render: (value: string) => value || '—',
    },
    {
      title: '释放时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (value: string) => <span className="mono">{value.replace('T', ' ').slice(0, 19)}</span>,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: unknown, row) => (
        <Button size="small" type="link" icon={<UndoOutlined />} onClick={() => void handleConfirm(row)}>
          重试
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            工位调度台
          </Typography.Title>
          <div className="page-hint">
            每个任务需同时占用一台揉捻机和一个焙火炉；容量不足时按提交先后排队，不能占一半，也不能插队。
            页面关闭或保存失败后释放工位、保留原队位，可重试；占用超时自动释放。
          </div>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void loadOrders()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openModal} disabled={batches.length === 0}>
            提交调度申请
          </Button>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="工位总数" value={stats.total} suffix="个" tone="primary" />
        <StatBadge label="占用中" value={stats.occupied} suffix="个" tone="warning" />
        <StatBadge label="剩余工位" value={stats.available} suffix="个" tone={stats.available > 0 ? 'success' : 'danger'} />
        <StatBadge label="排队中" value={stats.queued} suffix="单" tone={stats.queued > 0 ? 'info' : 'default'} />
        <StatBadge label="异常 / 已释放" value={stats.exceptions} suffix="单" tone={stats.exceptions > 0 ? 'danger' : 'default'} />
      </div>

      <Row gutter={[14, 14]}>
        <Col xs={24} xl={14}>
          <Card
            className="panel-card"
            title={
              <Space size={8}>
                <ClockCircleOutlined />
                <span>排队队列（FIFO）</span>
                <Tag color={queueList.length > 0 ? 'volcano' : 'default'}>{queueList.length} 单</Tag>
              </Space>
            }
          >
            {queueList.length === 0 ? (
              <EmptyPanel
                size="small"
                title="暂无排队"
                description="所有工位均空闲，提交调度申请即可立即占用。"
              />
            ) : (
              <Table<ScheduleOrder>
                rowKey="id"
                size="small"
                dataSource={queueList}
                columns={queueColumns}
                pagination={false}
                scroll={{ x: 900 }}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card
            className="panel-card"
            title={
              <Space size={8}>
                <CheckCircleOutlined />
                <span>工位占用中</span>
                <Tag color={occupationList.length > 0 ? 'gold' : 'default'}>{occupationList.length} 单</Tag>
              </Space>
            }
          >
            {occupationList.length === 0 ? (
              <EmptyPanel size="small" title="暂无占用" description="工位空闲，可提交调度申请。" />
            ) : (
              <Table<ScheduleOrder>
                rowKey="id"
                size="small"
                dataSource={occupationList}
                columns={occupationColumns}
                pagination={false}
                scroll={{ x: 800 }}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Card
        className="panel-card"
        style={{ marginTop: 14 }}
        title={
          <Space size={8}>
            <ExclamationCircleOutlined />
            <span>异常与释放记录</span>
            <Tag color={exceptionList.length > 0 ? 'red' : 'default'}>{exceptionList.length} 单</Tag>
          </Space>
        }
      >
        {exceptionList.length === 0 ? (
          <Typography.Text type="secondary">暂无异常记录。页面关闭、保存失败或占用超时后，工位会自动释放并保留原队位。</Typography.Text>
        ) : (
          <Table<ScheduleOrder>
            rowKey="id"
            size="small"
            dataSource={exceptionList}
            columns={exceptionColumns}
            pagination={{ pageSize: 5 }}
            scroll={{ x: 800 }}
          />
        )}
      </Card>

      <Modal
        open={modalOpen}
        title="提交调度申请"
        okText="提交申请"
        cancelText="取消"
        onCancel={() => {
          setModalOpen(false);
        }}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
          <Form.Item label="茶青批次" name="batchId" rules={[{ required: true, message: '请选择茶青批次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={batches.map((batch) => ({
                value: batch.id,
                label: `${batchLabel(batch, gardenMap.get(batch.gardenId)?.name)} · ${batch.state}`,
              }))}
            />
          </Form.Item>
          <Form.Item label="调度工序" name="process" rules={[{ required: true, message: '请选择调度工序' }]}>
            <Select
              options={[
                { value: 'fix', label: '杀青揉捻（需揉捻机 + 焙火炉）' },
                { value: 'roast', label: '焙火（需揉捻机 + 焙火炉）' },
              ]}
            />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            提交后系统会同时分配一台揉捻机和一个焙火炉；若工位已满，则按提交先后排队，不能占一半，也不能插队。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
