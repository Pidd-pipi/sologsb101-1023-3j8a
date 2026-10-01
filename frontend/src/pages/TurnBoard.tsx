/**
 * /turns 做青轮次编排
 * - 摇青 / 静置交替时间线 + 累计时长 + 失水率走势（消费 useTurnTimeline）
 * - HTML5 原生拖拽排序：拖动卡片调整轮次顺序，落库写回 roundNo
 * - 「复制上一轮参数后微调」、参数模板保存与套用、轮次增删改与筛选
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  InputNumber,
  Modal,
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
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import GradeTag from '../components/common/GradeTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useTurnTimeline } from '../hooks/useTurnTimeline';
import { useGardenStore } from '../stores/gardenStore';
import { useBatchStore } from '../stores/batchStore';
import {
  LOSS_BANDS,
  SHAKE_BANDS,
  TEMP_BANDS,
  defaultTurnDraft,
  filterTurns,
  tweakFromPrevious,
  useTurnStore,
} from '../stores/turnStore';
import type { Turn, TurnDraft } from '../types/turn';
import { TURN_LIMITS } from '../types/turn';
import { batchLabel, judgeHumidity, judgeRoomTemp, judgeShakeMin, judgeWaterLoss, minutesToReadable } from '../utils/tea';

/** 表单字段（batchId 由当前批次决定） */
type TurnFormValues = Omit<TurnDraft, 'batchId'>;

export default function TurnBoard() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<TurnFormValues>();

  const batches = useBatchStore((state) => state.batches);
  const gardens = useGardenStore((state) => state.gardens);

  const turns = useTurnStore((state) => state.turns);
  const activeBatchId = useTurnStore((state) => state.activeBatchId);
  const filters = useTurnStore((state) => state.filters);
  const template = useTurnStore((state) => state.template);
  const loading = useTurnStore((state) => state.loading);
  const setActiveBatch = useTurnStore((state) => state.setActiveBatch);
  const setFilters = useTurnStore((state) => state.setFilters);
  const resetFilters = useTurnStore((state) => state.resetFilters);
  const createTurn = useTurnStore((state) => state.createTurn);
  const updateTurn = useTurnStore((state) => state.updateTurn);
  const deleteTurn = useTurnStore((state) => state.deleteTurn);
  const copyPreviousTurn = useTurnStore((state) => state.copyPreviousTurn);
  const saveTemplate = useTurnStore((state) => state.saveTemplate);
  const applyTemplate = useTurnStore((state) => state.applyTemplate);
  const clearTemplate = useTurnStore((state) => state.clearTemplate);
  const reorderTurns = useTurnStore((state) => state.reorderTurns);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTurn, setEditingTurn] = useState<Turn | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  /** 拖拽源同步引用：避免 dragstart 与 drop 落在同一帧时 drop 处理器读到尚未提交的 state */
  const dragIdRef = useRef<string | null>(null);

  // 首次进入：默认编排第一个批次
  useEffect(() => {
    if (!activeBatchId && batches.length > 0) {
      void setActiveBatch(batches[0].id);
    }
  }, [activeBatchId, batches, setActiveBatch]);

  const labelOfBatch = (batchId: string): string => {
    const batch = batches.find((item) => item.id === batchId);
    if (!batch) return '未知批次';
    return batchLabel(batch, gardens.find((garden) => garden.id === batch.gardenId)?.name);
  };

  const activeBatch = batches.find((batch) => batch.id === activeBatchId) ?? null;
  const timeline = useTurnTimeline(activeBatchId);

  const orderedTurns = useMemo(() => [...turns].sort((a, b) => a.roundNo - b.roundNo), [turns]);
  const filteredTurns = useMemo(() => filterTurns(orderedTurns, filters), [orderedTurns, filters]);
  const itemByTurnId = useMemo(
    () => new Map(timeline.items.map((item) => [item.turn.id, item])),
    [timeline.items],
  );

  const selectConfigs: FilterSelectConfig[] = [
    { key: 'lossBands', label: '按失水率筛选', options: LOSS_BANDS, width: 176 },
    { key: 'tempBands', label: '按室温筛选', options: TEMP_BANDS, width: 176 },
    { key: 'shakeBands', label: '按摇青时长筛选', options: SHAKE_BANDS, width: 176 },
  ];

  /* ------------------------------ 表单 ------------------------------ */

  const openCreateModal = (draft?: TurnFormValues): void => {
    if (!activeBatchId) {
      message.warning('请先选择要编排的批次');
      return;
    }
    setEditingTurn(null);
    setModalOpen(true);
    form.setFieldsValue(draft ?? defaultTurnDraft(activeBatchId));
  };

  const openCopyModal = (): void => {
    if (orderedTurns.length === 0) {
      message.info('当前批次还没有轮次，先新建第 1 轮');
      openCreateModal();
      return;
    }
    const tweaked = tweakFromPrevious(orderedTurns[orderedTurns.length - 1]);
    openCreateModal({
      shakeMin: tweaked.shakeMin,
      restMin: tweaked.restMin,
      roomTempC: tweaked.roomTempC,
      humidityPct: tweaked.humidityPct,
      waterLossPct: tweaked.waterLossPct,
    });
    message.info('已复制上一轮参数并微调（摇青 +1 分钟 / 静置 -5 分钟 / 失水率 +1.5 个百分点）');
  };

  const openEditModal = (turn: Turn): void => {
    setEditingTurn(turn);
    setModalOpen(true);
    form.setFieldsValue({
      shakeMin: turn.shakeMin,
      restMin: turn.restMin,
      roomTempC: turn.roomTempC,
      humidityPct: turn.humidityPct,
      waterLossPct: turn.waterLossPct,
    });
  };

  const submitForm = async (values: TurnFormValues): Promise<void> => {
    if (!activeBatchId) return;
    try {
      if (editingTurn) {
        await updateTurn(editingTurn.id, { ...values, batchId: activeBatchId });
        message.success(`第 ${editingTurn.roundNo} 轮参数已更新`);
      } else {
        const created = await createTurn({ ...values, batchId: activeBatchId });
        message.success(`已新增第 ${created.roundNo} 轮做青参数`);
      }
      setModalOpen(false);
      setEditingTurn(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '做青轮次保存失败');
    }
  };

  const confirmDelete = (turn: Turn): void => {
    modal.confirm({
      title: `删除第 ${turn.roundNo} 轮？`,
      content: '删除后其余轮次会自动重排 roundNo，做青时间线与累计时长随之更新。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteTurn(turn.id);
          message.success('轮次已删除并重排');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  /* ------------------------------ 拖拽排序 ------------------------------ */

  const handleDrop = async (targetId: string): Promise<void> => {
    const sourceId = dragIdRef.current ?? dragId;
    if (!sourceId || sourceId === targetId) {
      dragIdRef.current = null;
      setDragId(null);
      setOverId(null);
      return;
    }
    const ids = orderedTurns.map((turn) => turn.id);
    const fromIndex = ids.indexOf(sourceId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...ids];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, sourceId);
    dragIdRef.current = null;
    setDragId(null);
    setOverId(null);
    await reorderTurns(next);
    message.success('轮次顺序已保存（roundNo 已写回本地数据库）');
  };

  /* ------------------------------ 列定义 ------------------------------ */

  const columns: ColumnsType<Turn> = [
    { title: '轮次', dataIndex: 'roundNo', width: 70, render: (value: number) => `第 ${value} 轮` },
    {
      title: '摇青',
      dataIndex: 'shakeMin',
      width: 150,
      render: (value: number) => {
        const verdict = judgeShakeMin(value);
        return (
          <Space size={6}>
            <span>{value} 分钟</span>
            <Tag color={verdict.level === 'ok' ? 'green' : verdict.level === 'low' ? 'blue' : 'orange'}>{verdict.label}</Tag>
          </Space>
        );
      },
    },
    { title: '静置', dataIndex: 'restMin', width: 100, render: (value: number) => `${value} 分钟` },
    {
      title: '室温',
      dataIndex: 'roomTempC',
      width: 130,
      render: (value: number) => {
        const verdict = judgeRoomTemp(value);
        return (
          <Space size={6}>
            <span>{value} ℃</span>
            <Tag color={verdict.level === 'ok' ? 'green' : 'orange'}>{verdict.label}</Tag>
          </Space>
        );
      },
    },
    {
      title: '湿度',
      dataIndex: 'humidityPct',
      width: 130,
      render: (value: number) => {
        const verdict = judgeHumidity(value);
        return (
          <Space size={6}>
            <span>{value} %</span>
            <Tag color={verdict.level === 'ok' ? 'green' : 'orange'}>{verdict.label}</Tag>
          </Space>
        );
      },
    },
    {
      title: '失水率',
      dataIndex: 'waterLossPct',
      width: 160,
      render: (value: number, row) => {
        const item = itemByTurnId.get(row.id);
        const verdict = judgeWaterLoss(value);
        return (
          <Space size={6}>
            <span>{value} %</span>
            <Tag color={verdict.level === 'ok' ? 'green' : 'orange'}>{verdict.label}</Tag>
            {item ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                +{item.waterLossDeltaPct} / {item.waterLossRatePerHour} 点·h⁻¹
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '累计时长',
      key: 'accumulated',
      width: 130,
      render: (_: unknown, row) => {
        const item = itemByTurnId.get(row.id);
        return item ? `${item.accumulatedTotalMin} 分钟` : '—';
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      render: (_: unknown, row) => (
        <Space size={2} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditModal(row)}>
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            icon={<SaveOutlined />}
            onClick={() => {
              saveTemplate(row);
              message.success(`已把第 ${row.roundNo} 轮存为参数模板`);
            }}
          >
            存为模板
          </Button>
          <Tooltip title={template ? '把模板参数套用到该轮' : '请先在某一行「存为模板」'}>
            <Button
              size="small"
              type="link"
              disabled={!template}
              onClick={() => {
                void applyTemplate(row.id);
                message.success(`已把模板套用到第 ${row.roundNo} 轮`);
              }}
            >
              套用模板
            </Button>
          </Tooltip>
          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            做青轮次编排
          </Typography.Title>
          <div className="page-hint">
            摇青与静置交替成轮：拖动卡片即可调整轮次顺序（HTML5 原生拖拽，落库写回 roundNo），并可复制上一轮参数后微调。
          </div>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 260 }}
            placeholder="选择要编排的茶青批次"
            value={activeBatchId ?? undefined}
            onChange={(value: string) => void setActiveBatch(value)}
            options={batches.map((batch) => ({
              value: batch.id,
              label: `${labelOfBatch(batch.id)} · ${batch.state}`,
            }))}
          />
          <Button icon={<CopyOutlined />} onClick={openCopyModal}>
            复制上一轮后微调
          </Button>
          <Button
            icon={<ThunderboltOutlined />}
            onClick={() => {
              void copyPreviousTurn();
              message.success('已按上一轮参数快速追加一轮');
            }}
          >
            快速追加一轮
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void setActiveBatch(activeBatchId ?? '')} disabled={!activeBatchId}>
            刷新
          </Button>
          <Tooltip title={template ? '当前模板：摇青 / 静置 / 室温 / 湿度 / 失水率' : '尚未保存参数模板'}>
            <Button
              icon={<SaveOutlined />}
              disabled={!template}
              onClick={() => {
                clearTemplate();
                message.success('参数模板已清空');
              }}
            >
              清空模板
            </Button>
          </Tooltip>
          {template ? (
            <Tag color="green">
              模板：摇 {template.shakeMin} 分钟 / 静 {template.restMin} 分钟 / {template.roomTempC} ℃
            </Tag>
          ) : null}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreateModal()}>
            新建轮次
          </Button>
        </Space>
      </div>

      {batches.length === 0 ? (
        <EmptyPanel
          title="还没有茶青批次"
          description="先到「山场与批次台账」登记一个茶青批次，再回来排做青轮次。"
        />
      ) : (
        <>
          <div className="stat-row">
            <StatBadge label="轮次数" value={orderedTurns.length} suffix="轮" tone="primary" />
            <StatBadge label="累计摇青" value={timeline.totalShakeMin} suffix="分钟" />
            <StatBadge label="累计静置" value={timeline.totalRestMin} suffix="分钟" tone="info" />
            <StatBadge label="做青总时长" value={minutesToReadable(timeline.totalMin)} hint={`摇青占比 ${timeline.shakeRatioPct}%`} />
            <StatBadge
              label="末轮失水率"
              value={timeline.finalWaterLossPct}
              suffix="%"
              tone={timeline.verdicts.waterLoss?.level === 'ok' ? 'success' : 'warning'}
              hint={timeline.verdicts.waterLoss?.hint}
            />
            <StatBadge
              label="峰值失水速率"
              value={timeline.peakWaterLossRatePerHour}
              suffix="点/小时"
              tone="warning"
              hint={timeline.trend === 'rising' ? '走势：持续上升' : timeline.trend === 'falling' ? '走势：回落' : '走势：平稳'}
            />
          </div>

          <Row gutter={[14, 14]}>
            <Col xs={24} xl={14}>
              <Card
                title="轮次顺序（拖拽调整）"
                extra={<Typography.Text type="secondary">拖拽卡片到目标位置即可重排</Typography.Text>}
                className="panel-card"
              >
                {orderedTurns.length === 0 ? (
                  <EmptyPanel
                    size="small"
                    title="该批次还没有做青轮次"
                    description="从第 1 轮开始记录摇青与静置参数。"
                    actionText="新建轮次"
                    onAction={() => openCreateModal()}
                  />
                ) : (
                  <div className="turn-board">
                    {orderedTurns.map((turn) => {
                      const item = itemByTurnId.get(turn.id);
                      return (
                        <div
                          key={turn.id}
                          className={`turn-card ${dragId === turn.id ? 'is-dragging' : ''} ${
                            overId === turn.id && dragId !== turn.id ? 'is-drop-target' : ''
                          }`}
                          draggable
                          onDragStart={() => {
                            dragIdRef.current = turn.id;
                            setDragId(turn.id);
                          }}
                          onDragEnd={() => {
                            dragIdRef.current = null;
                            setDragId(null);
                            setOverId(null);
                          }}
                          onDragOver={(event) => {
                            event.preventDefault();
                            setOverId(turn.id);
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            void handleDrop(turn.id);
                          }}
                        >
                          <HolderOutlined style={{ color: 'rgba(47,81,54,0.45)', cursor: 'grab' }} />
                          <div className="turn-round">第 {turn.roundNo} 轮</div>
                          <div className="turn-params">
                            <span>
                              摇青 <strong>{turn.shakeMin}</strong> 分钟
                            </span>
                            <span>
                              静置 <strong>{turn.restMin}</strong> 分钟
                            </span>
                            <span>室温 {turn.roomTempC} ℃</span>
                            <span>湿度 {turn.humidityPct} %</span>
                            <span>
                              失水 <strong>{turn.waterLossPct}</strong> %
                            </span>
                            <span>累计 {item ? item.accumulatedTotalMin : 0} 分钟</span>
                          </div>
                          <Space size={2}>
                            <Button size="small" type="link" onClick={() => openEditModal(turn)}>
                              编辑
                            </Button>
                            <Button size="small" type="link" danger onClick={() => confirmDelete(turn)}>
                              删除
                            </Button>
                          </Space>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            </Col>

            <Col xs={24} xl={10}>
              <Card title="摇青 / 静置交替时间线" className="panel-card" style={{ marginBottom: 14 }}>
                {timeline.segments.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无时间线数据" />
                ) : (
                  <>
                    <div className="timeline-track">
                      {timeline.segments.map((segment) => {
                        const ratio = timeline.totalMin > 0 ? (segment.durationMin / timeline.totalMin) * 100 : 0;
                        return (
                          <div
                            key={`${segment.turnId}-${segment.kind}`}
                            className={`timeline-segment ${segment.kind === 'shake' ? 'is-shake' : 'is-rest'}`}
                            style={{ width: `${ratio}%` }}
                            title={`第 ${segment.roundNo} 轮 ${segment.kind === 'shake' ? '摇青' : '静置'}：${segment.startMin}-${segment.endMin} 分钟`}
                          >
                            {ratio > 9 ? `${segment.kind === 'shake' ? '摇' : '静'}${segment.roundNo}` : ''}
                          </div>
                        );
                      })}
                    </div>
                    <div className="timeline-legend">
                      <span>■ 摇青段（深绿）</span>
                      <span>■ 静置段（浅茶）</span>
                      <span>合计 {minutesToReadable(timeline.totalMin)}</span>
                    </div>
                  </>
                )}
              </Card>

              <Card title="失水率走势" className="panel-card">
                {timeline.items.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无失水率数据" />
                ) : (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {timeline.items.map((item) => (
                      <div key={item.turn.id}>
                        <Space size={8} style={{ fontSize: 12 }}>
                          <span>第 {item.turn.roundNo} 轮</span>
                          <span>失水 {item.waterLossPct}%</span>
                          <Typography.Text type={item.waterLossDeltaPct >= 0 ? 'success' : 'danger'}>
                            {item.waterLossDeltaPct >= 0 ? '+' : ''}
                            {item.waterLossDeltaPct} 百分点
                          </Typography.Text>
                          <Typography.Text type="secondary">{item.waterLossRatePerHour} 点/小时</Typography.Text>
                        </Space>
                        <Progress
                          percent={Math.min(100, (item.waterLossPct / 40) * 100)}
                          showInfo={false}
                          strokeColor={{ from: '#95c98a', to: '#c9963c' }}
                          size="small"
                        />
                      </div>
                    ))}
                    <Space size={8} wrap>
                      {timeline.verdicts.roomTemp ? <Tag>{timeline.verdicts.roomTemp.label}</Tag> : null}
                      {timeline.verdicts.humidity ? <Tag>{timeline.verdicts.humidity.label}</Tag> : null}
                      {timeline.verdicts.waterLoss ? <Tag>{timeline.verdicts.waterLoss.label}</Tag> : null}
                      {activeBatch ? <GradeTag kind="state" value={activeBatch.state} /> : null}
                    </Space>
                  </Space>
                )}
              </Card>
            </Col>
          </Row>

          <div style={{ marginTop: 14 }}>
            <FilterBar
              value={filters}
              onChange={setFilters}
              selects={selectConfigs}
              onReset={resetFilters}
              placeholder="搜索轮次号 / 失水率 / 室温"
            />
            <Card
              title={`轮次明细（${filteredTurns.length} / ${orderedTurns.length} 轮）`}
              className="panel-card"
              loading={loading}
            >
              {filteredTurns.length === 0 ? (
                <EmptyPanel
                  size="small"
                  title="没有命中筛选条件的轮次"
                  description="试试放宽失水率、室温或摇青时长的区间。"
                  secondaryText="重置筛选"
                  onSecondary={() => resetFilters()}
                />
              ) : (
                <Table<Turn> rowKey="id" size="small" dataSource={filteredTurns} columns={columns} pagination={false} scroll={{ x: 1100 }} />
              )}
            </Card>
          </div>
        </>
      )}

      <Modal
        open={modalOpen}
        title={editingTurn ? `编辑第 ${editingTurn.roundNo} 轮参数` : '新建做青轮次'}
        okText={editingTurn ? '保存' : '创建'}
        cancelText="取消"
        onCancel={() => {
          setModalOpen(false);
          setEditingTurn(null);
        }}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(values: TurnFormValues) => void submitForm(values)}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label="摇青（分钟）"
                name="shakeMin"
                rules={[
                  { required: true, message: '请填写摇青时长' },
                  {
                    type: 'number',
                    min: TURN_LIMITS.shakeMin.min,
                    max: TURN_LIMITS.shakeMin.max,
                    message: `摇青需在 ${TURN_LIMITS.shakeMin.min}-${TURN_LIMITS.shakeMin.max} 分钟`,
                  },
                ]}
              >
                <InputNumber min={TURN_LIMITS.shakeMin.min} max={TURN_LIMITS.shakeMin.max} step={0.5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="静置（分钟）"
                name="restMin"
                rules={[
                  { required: true, message: '请填写静置时长' },
                  {
                    type: 'number',
                    min: TURN_LIMITS.restMin.min,
                    max: TURN_LIMITS.restMin.max,
                    message: `静置需在 ${TURN_LIMITS.restMin.min}-${TURN_LIMITS.restMin.max} 分钟`,
                  },
                ]}
              >
                <InputNumber min={TURN_LIMITS.restMin.min} max={TURN_LIMITS.restMin.max} step={5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="室温（℃）"
                name="roomTempC"
                rules={[
                  { required: true, message: '请填写室温' },
                  {
                    type: 'number',
                    min: TURN_LIMITS.roomTempC.min,
                    max: TURN_LIMITS.roomTempC.max,
                    message: `室温需在 ${TURN_LIMITS.roomTempC.min}-${TURN_LIMITS.roomTempC.max} ℃`,
                  },
                ]}
              >
                <InputNumber min={TURN_LIMITS.roomTempC.min} max={TURN_LIMITS.roomTempC.max} step={0.5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="相对湿度（%）"
                name="humidityPct"
                rules={[
                  { required: true, message: '请填写湿度' },
                  {
                    type: 'number',
                    min: TURN_LIMITS.humidityPct.min,
                    max: TURN_LIMITS.humidityPct.max,
                    message: `湿度需在 ${TURN_LIMITS.humidityPct.min}-${TURN_LIMITS.humidityPct.max} %`,
                  },
                ]}
              >
                <InputNumber min={TURN_LIMITS.humidityPct.min} max={TURN_LIMITS.humidityPct.max} step={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item
                label="本轮结束时累计失水率（%）"
                name="waterLossPct"
                rules={[
                  { required: true, message: '请填写失水率' },
                  {
                    type: 'number',
                    min: TURN_LIMITS.waterLossPct.min,
                    max: TURN_LIMITS.waterLossPct.max,
                    message: `失水率需在 ${TURN_LIMITS.waterLossPct.min}-${TURN_LIMITS.waterLossPct.max} %`,
                  },
                ]}
                extra="做青全程目标 12%-20%，超过 20% 建议尽快杀青"
              >
                <InputNumber min={TURN_LIMITS.waterLossPct.min} max={TURN_LIMITS.waterLossPct.max} step={0.5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}
