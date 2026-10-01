/**
 * /roasting 焙火曲线与复焙安排
 * - 多道次按序排列（上移 / 下移写回 passNo）、温度时长与炭种登记
 * - 足火判定（轻火 / 中火 / 足火）与状态流转：待焙 → 焙火中 → 已足火（足火后回写批次为已焙火）
 * - 复焙提醒面板：逾期 / 今日 / 7 日内 / 已排期
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  FireOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import GradeTag from '../components/common/GradeTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useGardenStore } from '../stores/gardenStore';
import { useBatchStore } from '../stores/batchStore';
import {
  buildReminders,
  filterRoasts,
  fireLevelOfBatch,
  fireLoadOfBatch,
  roastsOfBatch,
  useRoastStore,
} from '../stores/roastStore';
import { CHARCOAL_OPTIONS, ROAST_LIMITS, ROAST_STATES, type Roast, type RoastDraft } from '../types/roast';
import type { Batch } from '../types/batch';
import {
  CHARCOAL_COLOR,
  FIRE_LEVEL_ADVICE,
  FIRE_THRESHOLDS,
  REMINDER_COLOR,
  REMINDER_LABEL,
  batchLabel,
  isFullFire,
  roundTo,
} from '../utils/tea';

export default function RoastPlan() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<RoastDraft>();

  const batches = useBatchStore((state) => state.batches);
  const gardens = useGardenStore((state) => state.gardens);

  const roasts = useRoastStore((state) => state.roasts);
  const roastFilters = useRoastStore((state) => state.filters);
  const setFilters = useRoastStore((state) => state.setFilters);
  const resetFilters = useRoastStore((state) => state.resetFilters);
  const loadRoasts = useRoastStore((state) => state.loadRoasts);
  const createRoast = useRoastStore((state) => state.createRoast);
  const updateRoast = useRoastStore((state) => state.updateRoast);
  const deleteRoast = useRoastStore((state) => state.deleteRoast);
  const advanceRoastState = useRoastStore((state) => state.advanceRoastState);
  const movePass = useRoastStore((state) => state.movePass);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRoast, setEditingRoast] = useState<Roast | null>(null);

  useEffect(() => {
    void loadRoasts();
  }, [loadRoasts]);

  const gardenMap = useMemo(() => new Map(gardens.map((garden) => [garden.id, garden])), [gardens]);
  const batchMap = useMemo(() => new Map(batches.map((batch) => [batch.id, batch])), [batches]);
  const labelOfBatch = (batchId: string): string => {
    const batch = batchMap.get(batchId);
    if (!batch) return '未知批次';
    return batchLabel(batch, gardenMap.get(batch.gardenId)?.name);
  };

  const rows = useMemo(() => filterRoasts(roasts, batches, gardens, roastFilters), [batches, gardens, roastFilters, roasts]);
  const reminders = useMemo(() => buildReminders(roasts), [roasts]);

  /** 过滤结果按批次分组 */
  const grouped = useMemo(() => {
    const map = new Map<string, Roast[]>();
    rows.forEach((roast) => {
      map.set(roast.batchId, [...(map.get(roast.batchId) ?? []), roast]);
    });
    return [...map.entries()].map(([batchId, list]) => ({
      batchId,
      list: [...list].sort((a, b) => a.passNo - b.passNo),
    }));
  }, [rows]);

  const stats = useMemo(() => {
    const totalLoad = roundTo(
      rows.reduce((acc, roast) => acc + roast.tempC * roast.hours, 0),
      1,
    );
    const batchCount = new Set(rows.map((roast) => roast.batchId)).size;
    const fullFireCount = rows.filter((roast) => roast.state === '已足火').length;
    const soonCount = reminders.filter((item) => item.level === 'overdue' || item.level === 'today' || item.level === 'soon').length;
    const averageTemp = rows.length > 0 ? roundTo(rows.reduce((acc, roast) => acc + roast.tempC, 0) / rows.length, 1) : 0;
    return { totalLoad, batchCount, fullFireCount, soonCount, averageTemp };
  }, [reminders, rows]);

  const selectConfigs: FilterSelectConfig[] = [
    {
      key: 'batchIds',
      label: '按批次筛选',
      options: batches.map((batch) => ({ value: batch.id, label: labelOfBatch(batch.id) })),
      width: 240,
    },
    {
      key: 'states',
      label: '按道次状态筛选',
      options: ROAST_STATES.map((value) => ({ value, label: value })),
      width: 176,
    },
    {
      key: 'charcoals',
      label: '按炭种筛选',
      options: CHARCOAL_OPTIONS.map((value) => ({ value, label: value })),
      width: 168,
    },
    {
      key: 'gardenIds',
      label: '按山场筛选',
      options: gardens.map((garden) => ({ value: garden.id, label: garden.name })),
    },
  ];

  const openModal = (batchId?: string, roast?: Roast): void => {
    setEditingRoast(roast ?? null);
    setModalOpen(true);
    if (roast) {
      form.setFieldsValue({
        batchId: roast.batchId,
        tempC: roast.tempC,
        hours: roast.hours,
        charcoal: roast.charcoal,
        nextRoastDate: roast.nextRoastDate,
        state: roast.state,
      });
    } else {
      const branch = batchId ? roastsOfBatch(roasts, batchId) : [];
      const last = branch[branch.length - 1];
      form.setFieldsValue({
        batchId: batchId ?? batches[0]?.id,
        tempC: last ? Math.min(ROAST_LIMITS.tempC.max, last.tempC + 5) : 95,
        hours: last ? last.hours : 5,
        charcoal: last ? last.charcoal : '荔枝炭',
        nextRoastDate: '',
        state: '待焙',
      });
    }
  };

  const submit = async (values: RoastDraft): Promise<void> => {
    try {
      if (editingRoast) {
        await updateRoast(editingRoast.id, values);
        message.success(`第 ${editingRoast.passNo} 道焙火已更新`);
      } else {
        const created = await createRoast(values);
        message.success(`已新增第 ${created.passNo} 道焙火`);
      }
      setModalOpen(false);
      setEditingRoast(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '焙火记录保存失败');
    }
  };

  const confirmDelete = (roast: Roast): void => {
    modal.confirm({
      title: `删除第 ${roast.passNo} 道焙火？`,
      content: `批次：${labelOfBatch(roast.batchId)}。删除后同批次其余道次会重排 passNo。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteRoast(roast.id);
          message.success('焙火道次已删除并重排');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  const handleAdvance = async (roast: Roast): Promise<void> => {
    const next = await advanceRoastState(roast.id);
    if (next) {
      message.success(`第 ${roast.passNo} 道状态已推进到「${next}」${next === '已足火' ? '，批次已回写为「已焙火」' : ''}`);
    } else {
      message.info('该道次已是「已足火」');
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            焙火曲线与复焙安排
          </Typography.Title>
          <div className="page-hint">
            多道次按序排列，逐道推进「待焙 → 焙火中 → 已足火」；累计热负荷达到 {FIRE_THRESHOLDS.full} ℃·h 且不
            少于两道次即判定足火。
          </div>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void loadRoasts()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()} disabled={batches.length === 0}>
            新建焙火道次
          </Button>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="焙火道次" value={rows.length} suffix={`/ ${roasts.length}`} tone="primary" />
        <StatBadge label="涉及批次" value={stats.batchCount} suffix="个" />
        <StatBadge label="累计热负荷" value={stats.totalLoad} suffix="℃·h" tone="warning" hint="温度 × 时长求和" />
        <StatBadge label="平均温度" value={stats.averageTemp} suffix="℃" tone="info" />
        <StatBadge label="已足火道次" value={stats.fullFireCount} suffix="道" tone="success" />
        <StatBadge
          label="待复焙（含逾期）"
          value={stats.soonCount}
          suffix="条"
          tone={stats.soonCount > 0 ? 'danger' : 'default'}
          hint="7 日内到期或已逾期的复焙提醒"
        />
      </div>

      <Card
        className="panel-card"
        title={
          <Space size={8}>
            <FireOutlined />
            <span>复焙提醒</span>
            <Tag color={reminders.length > 0 ? 'volcano' : 'default'}>{reminders.length} 条</Tag>
          </Space>
        }
        style={{ marginBottom: 14 }}
      >
        {reminders.length === 0 ? (
          <Typography.Text type="secondary">暂无复焙安排：在道次表单里填写「复焙日期」即可生成提醒。</Typography.Text>
        ) : (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {reminders.map((reminder) => (
              <Space key={reminder.roastId} size={10} wrap>
                <Tag color={REMINDER_COLOR[reminder.level]}>{REMINDER_LABEL[reminder.level]}</Tag>
                <span>{labelOfBatch(reminder.batchId)}</span>
                <span>第 {reminder.passNo} 道</span>
                <span className="mono">{reminder.nextRoastDate}</span>
                <Typography.Text type={reminder.daysLeft < 0 ? 'danger' : 'secondary'}>
                  {reminder.daysLeft < 0
                    ? `已逾期 ${Math.abs(reminder.daysLeft)} 天`
                    : reminder.daysLeft === 0
                      ? '今天应复焙'
                      : `还有 ${reminder.daysLeft} 天`}
                </Typography.Text>
              </Space>
            ))}
          </Space>
        )}
      </Card>

      <FilterBar
        value={roastFilters}
        onChange={setFilters}
        selects={selectConfigs}
        onReset={resetFilters}
        placeholder="搜索山场 / 批次 / 炭种 / 道次"
      />

      {roasts.length === 0 ? (
        <EmptyPanel
          title="还没有焙火记录"
          description="毛茶拣剔后即可排第 1 道焙火：填温度、时长与炭种，并约定复焙日期。"
          actionText="新建焙火道次"
          onAction={() => openModal()}
        />
      ) : grouped.length === 0 ? (
        <EmptyPanel
          size="small"
          title="没有命中筛选条件的焙火道次"
          description="试试调整批次、道次状态、炭种或山场。"
          secondaryText="重置筛选"
          onSecondary={resetFilters}
        />
      ) : (
        <Row gutter={[14, 14]}>
          {grouped.map((group) => {
            const branch = roastsOfBatch(roasts, group.batchId);
            const fireLevel = fireLevelOfBatch(roasts, group.batchId);
            const load = fireLoadOfBatch(roasts, group.batchId);
            const fullFire = isFullFire(branch);
            return (
              <Col key={group.batchId} xs={24} xl={12}>
                <Card
                  className="panel-card"
                  title={
                    <Space size={8} wrap>
                      <span>{labelOfBatch(group.batchId)}</span>
                      <GradeTag kind="fire" value={fireLevel} />
                      {fullFire ? <Tag color="volcano">足火判定通过</Tag> : null}
                    </Space>
                  }
                  extra={
                    <Tooltip title="按上一道参数 +5 ℃ 追加下一道">
                      <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => openModal(group.batchId)}>
                        追加道次
                      </Button>
                    </Tooltip>
                  }
                >
                  <Space size={16} wrap style={{ marginBottom: 10 }}>
                    <StatBadge size="small" label="道次" value={branch.length} suffix="道" />
                    <StatBadge size="small" label="累计热负荷" value={load} suffix="℃·h" tone="warning" />
                    <StatBadge size="small" label="足火阈值" value={FIRE_THRESHOLDS.full} suffix="℃·h" />
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {FIRE_LEVEL_ADVICE[fireLevel]}
                  </Typography.Text>

                  <div style={{ marginTop: 10 }}>
                    {group.list.map((roast, index) => (
                      <div key={roast.id} className={`roast-pass ${roast.state === '已足火' ? 'is-fullfire' : ''}`}>
                        <strong style={{ width: 58 }}>第 {roast.passNo} 道</strong>
                        <span style={{ width: 92 }}>
                          {roast.tempC} ℃ / {roast.hours} h
                        </span>
                        <Tag color={CHARCOAL_COLOR[roast.charcoal]}>{roast.charcoal}</Tag>
                        <GradeTag kind="roastState" value={roast.state} />
                        <span className="mono" style={{ fontSize: 12, color: 'rgba(43,42,38,0.6)' }}>
                          {roast.nextRoastDate ? `复焙 ${roast.nextRoastDate}` : '未排复焙'}
                        </span>
                        <Space size={2} style={{ marginLeft: 'auto' }}>
                          <Button
                            size="small"
                            type="text"
                            icon={<ArrowUpOutlined />}
                            disabled={index === 0}
                            onClick={() => void movePass(roast.id, 'up')}
                          />
                          <Button
                            size="small"
                            type="text"
                            icon={<ArrowDownOutlined />}
                            disabled={index === group.list.length - 1}
                            onClick={() => void movePass(roast.id, 'down')}
                          />
                          <Button size="small" type="link" onClick={() => void handleAdvance(roast)}>
                            推进状态
                          </Button>
                          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openModal(undefined, roast)} />
                          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(roast)} />
                        </Space>
                      </div>
                    ))}
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      {groupsWithoutRoast(batches, roasts).length > 0 ? (
        <Card className="panel-card" style={{ marginTop: 14 }} title="尚未排焙火的批次">
          <Space wrap size={8}>
            {groupsWithoutRoast(batches, roasts).map((batch) => (
              <Tag key={batch.id} color="gold" style={{ padding: '4px 8px' }}>
                {batchLabel(batch, gardenMap.get(batch.gardenId)?.name)}
                <Button size="small" type="link" onClick={() => openModal(batch.id)}>
                  排第 1 道
                </Button>
              </Tag>
            ))}
          </Space>
        </Card>
      ) : null}

      {batches.length === 0 ? (
        <Empty
          style={{ marginTop: 16 }}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有茶青批次，先到山场台账登记批次"
        />
      ) : null}

      <Modal
        open={modalOpen}
        title={editingRoast ? `编辑第 ${editingRoast.passNo} 道焙火` : '新建焙火道次'}
        okText={editingRoast ? '保存' : '新增道次'}
        cancelText="取消"
        onCancel={() => {
          setModalOpen(false);
          setEditingRoast(null);
        }}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(values: RoastDraft) => void submit(values)}>
          <Row gutter={12}>
            <Col span={24}>
              <Form.Item label="茶青批次" name="batchId" rules={[{ required: true, message: '请选择茶青批次' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  disabled={editingRoast !== null}
                  options={batches.map((batch) => ({
                    value: batch.id,
                    label: `${batchLabel(batch, gardenMap.get(batch.gardenId)?.name)} · ${batch.state}`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="焙火温度（℃）"
                name="tempC"
                rules={[
                  { required: true, message: '请填写温度' },
                  {
                    type: 'number',
                    min: ROAST_LIMITS.tempC.min,
                    max: ROAST_LIMITS.tempC.max,
                    message: `温度需在 ${ROAST_LIMITS.tempC.min}-${ROAST_LIMITS.tempC.max} ℃`,
                  },
                ]}
              >
                <InputNumber min={ROAST_LIMITS.tempC.min} max={ROAST_LIMITS.tempC.max} step={5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="时长（小时）"
                name="hours"
                rules={[
                  { required: true, message: '请填写时长' },
                  {
                    type: 'number',
                    min: ROAST_LIMITS.hours.min,
                    max: ROAST_LIMITS.hours.max,
                    message: `时长需在 ${ROAST_LIMITS.hours.min}-${ROAST_LIMITS.hours.max} 小时`,
                  },
                ]}
              >
                <InputNumber min={ROAST_LIMITS.hours.min} max={ROAST_LIMITS.hours.max} step={0.5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="炭种" name="charcoal" rules={[{ required: true, message: '请选择炭种' }]}>
                <Select options={CHARCOAL_OPTIONS.map((value) => ({ value, label: value }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="道次状态" name="state" rules={[{ required: true, message: '请选择道次状态' }]}>
                <Select options={ROAST_STATES.map((value) => ({ value, label: value }))} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item
                label="复焙日期"
                name="nextRoastDate"
                rules={[{ pattern: /^$|^\d{4}-\d{2}-\d{2}$/, message: '日期格式需为 YYYY-MM-DD，或不填' }]}
                extra="留空表示暂不复焙；填写后会在复焙提醒面板按到期紧急度排序"
              >
                <Input placeholder="2025-09-30" allowClear />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}

/** 还没有任何焙火道次的批次 */
function groupsWithoutRoast(batches: Batch[], roasts: Roast[]): Batch[] {
  const touched = new Set(roasts.map((roast) => roast.batchId));
  return batches.filter((batch) => !touched.has(batch.id));
}
