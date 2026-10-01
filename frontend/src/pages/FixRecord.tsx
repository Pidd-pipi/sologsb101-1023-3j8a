/**
 * /fixing 杀青揉捻记录
 * - 登记锅温、杀青时长、揉捻压力与揉捻时长、操作人（含校验规则）
 * - 登记 / 修改后回写所属批次状态为「已杀青」（工序自动流转）
 * - 关键字 + 山场 / 批次 / 揉捻压力筛选，删除确认，统计徽标与空数据引导
 */
import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import GradeTag from '../components/common/GradeTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useIdbTable } from '../hooks/useIdbTable';
import { useGardenStore } from '../stores/gardenStore';
import { filterFixes, useBatchStore } from '../stores/batchStore';
import { db } from '../utils/db';
import { FIX_LIMITS, ROLL_PRESSURE_OPTIONS, type Fix, type FixDraft } from '../types/fix';
import { batchLabel, judgeFixLevel, roundTo } from '../utils/tea';

export default function FixRecord() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<FixDraft>();

  const gardens = useGardenStore((state) => state.gardens);
  const batches = useBatchStore((state) => state.batches);
  const fixFilters = useBatchStore((state) => state.fixFilters);
  const setFixFilters = useBatchStore((state) => state.setFixFilters);
  const resetFixFilters = useBatchStore((state) => state.resetFixFilters);
  const markBatchState = useBatchStore((state) => state.markBatchState);
  const loadBatches = useBatchStore((state) => state.loadBatches);

  const fixesTable = useIdbTable<Fix>(db.fixes, { prefix: 'fix', sort: (a, b) => b.createdAt.localeCompare(a.createdAt) });

  const [modalOpen, setModalOpen] = useState(false);
  const [editingFix, setEditingFix] = useState<Fix | null>(null);

  const gardenMap = useMemo(() => new Map(gardens.map((garden) => [garden.id, garden])), [gardens]);
  const batchMap = useMemo(() => new Map(batches.map((batch) => [batch.id, batch])), [batches]);

  const rows = useMemo(
    () => filterFixes(fixesTable.rows, batches, gardens, fixFilters),
    [batches, fixFilters, fixesTable.rows, gardens],
  );

  const stats = useMemo(() => {
    const count = rows.length;
    const avgWokTemp = count > 0 ? roundTo(rows.reduce((acc, row) => acc + row.wokTempC, 0) / count, 1) : 0;
    const avgFixMin = count > 0 ? roundTo(rows.reduce((acc, row) => acc + row.fixMin, 0) / count, 1) : 0;
    const avgRollMin = count > 0 ? roundTo(rows.reduce((acc, row) => acc + row.rollMin, 0) / count, 1) : 0;
    const fixedBatches = new Set(rows.map((row) => row.batchId)).size;
    return { count, avgWokTemp, avgFixMin, avgRollMin, fixedBatches };
  }, [rows]);

  const selectConfigs: FilterSelectConfig[] = [
    {
      key: 'gardenIds',
      label: '按山场筛选',
      options: gardens.map((garden) => ({ value: garden.id, label: garden.name })),
    },
    {
      key: 'batchIds',
      label: '按批次筛选',
      options: batches.map((batch) => ({
        value: batch.id,
        label: batchLabel(batch, gardenMap.get(batch.gardenId)?.name),
      })),
      width: 240,
    },
    {
      key: 'pressures',
      label: '按揉捻压力筛选',
      options: ROLL_PRESSURE_OPTIONS.map((value) => ({ value, label: `${value}压` })),
      width: 176,
    },
  ];

  const openModal = (fix?: Fix): void => {
    setEditingFix(fix ?? null);
    setModalOpen(true);
    if (fix) {
      form.setFieldsValue({
        batchId: fix.batchId,
        wokTempC: fix.wokTempC,
        fixMin: fix.fixMin,
        rollPressure: fix.rollPressure,
        rollMin: fix.rollMin,
        operator: fix.operator,
      });
    } else {
      form.setFieldsValue({
        batchId: batches[0]?.id,
        wokTempC: 180,
        fixMin: 6,
        rollPressure: '中',
        rollMin: 10,
        operator: '',
      });
    }
  };

  const submit = async (values: FixDraft): Promise<void> => {
    try {
      if (editingFix) {
        await fixesTable.update(editingFix.id, values);
        message.success('杀青揉捻记录已更新');
      } else {
        await fixesTable.create(values);
        message.success('杀青揉捻记录已登记');
      }
      const nextState = await markBatchState(values.batchId, '已杀青');
      if (nextState) {
        message.success(`批次工序状态已回写为「${nextState}」`);
      }
      setModalOpen(false);
      setEditingFix(null);
      await loadBatches();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '杀青揉捻记录保存失败');
    }
  };

  const confirmDelete = (fix: Fix): void => {
    const batch = batchMap.get(fix.batchId);
    modal.confirm({
      title: `删除「${fix.operator || '未署名'}」的杀青揉捻记录？`,
      content: `所属批次：${batch ? batchLabel(batch, gardenMap.get(batch.gardenId)?.name) : '未知'}。批次当前工序状态不会被回退。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await fixesTable.remove(fix.id);
          message.success('记录已删除');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  const markFixed = async (fix: Fix): Promise<void> => {
    const nextState = await markBatchState(fix.batchId, '已杀青');
    message.success(`批次工序状态：${nextState ?? '已是已杀青或更后道工序'}`);
  };

  const columns: ColumnsType<Fix> = [
    {
      title: '茶青批次',
      key: 'batch',
      width: 250,
      render: (_: unknown, row) => {
        const batch = batchMap.get(row.batchId);
        if (!batch) return <Tag color="red">批次已删除</Tag>;
        return (
          <Space size={6} wrap>
            <span>{batchLabel(batch, gardenMap.get(batch.gardenId)?.name)}</span>
            <GradeTag kind="tenderness" value={batch.tenderness} />
          </Space>
        );
      },
    },
    {
      title: '锅温',
      dataIndex: 'wokTempC',
      width: 100,
      render: (value: number) => `${value} ℃`,
    },
    {
      title: '杀青时长',
      dataIndex: 'fixMin',
      width: 110,
      render: (value: number) => `${value} 分钟`,
    },
    {
      title: '杀青档位',
      key: 'level',
      width: 120,
      render: (_: unknown, row) => {
        const level = judgeFixLevel(row.wokTempC, row.fixMin, row.rollPressure);
        return <Tag color={level === '适中' ? 'green' : level === '偏轻' ? 'blue' : 'orange'}>{level}</Tag>;
      },
    },
    {
      title: '揉捻压力',
      dataIndex: 'rollPressure',
      width: 110,
      render: (value: Fix['rollPressure']) => <GradeTag kind="pressure" value={value} />,
    },
    {
      title: '揉捻时长',
      dataIndex: 'rollMin',
      width: 110,
      render: (value: number) => `${value} 分钟`,
    },
    { title: '操作人', dataIndex: 'operator', width: 120 },
    {
      title: '批次工序状态',
      key: 'state',
      width: 130,
      render: (_: unknown, row) => {
        const batch = batchMap.get(row.batchId);
        return batch ? <GradeTag kind="state" value={batch.state} /> : '—';
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_: unknown, row) => (
        <Space size={2} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openModal(row)}>
            编辑
          </Button>
          <Button size="small" type="link" icon={<RollbackOutlined />} onClick={() => void markFixed(row)}>
            回写已杀青
          </Button>
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
            杀青揉捻记录
          </Typography.Title>
          <div className="page-hint">
            登记锅温与杀青时长、揉捻压力与时长；登记完成后自动把批次工序状态推进到「已杀青」。
          </div>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void fixesTable.refresh()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()} disabled={batches.length === 0}>
            登记杀青揉捻
          </Button>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="记录数" value={stats.count} suffix={`/ ${fixesTable.count}`} tone="primary" />
        <StatBadge label="平均锅温" value={stats.avgWokTemp} suffix="℃" tone="warning" />
        <StatBadge label="平均杀青时长" value={stats.avgFixMin} suffix="分钟" />
        <StatBadge label="平均揉捻时长" value={stats.avgRollMin} suffix="分钟" tone="info" />
        <StatBadge label="覆盖批次数" value={stats.fixedBatches} suffix="个" tone="success" />
      </div>

      <FilterBar
        value={fixFilters}
        onChange={setFixFilters}
        selects={selectConfigs}
        onReset={resetFixFilters}
        placeholder="搜索操作人 / 批次 / 锅温"
      />

      {fixesTable.error ? (
        <EmptyPanel size="small" title="本地数据读取失败" description={fixesTable.error} secondaryText="重试" onSecondary={() => void fixesTable.refresh()} />
      ) : rows.length === 0 ? (
        <EmptyPanel
          title={fixesTable.count === 0 ? '还没有杀青揉捻记录' : '没有命中筛选条件的记录'}
          description={
            fixesTable.count === 0
              ? '做青走水到位后即可登记锅温与揉捻参数，系统会把批次推进到「已杀青」。'
              : '试试调整关键字、山场、批次或揉捻压力。'
          }
          actionText={fixesTable.count === 0 ? '登记杀青揉捻' : undefined}
          onAction={fixesTable.count === 0 ? () => openModal() : undefined}
          secondaryText={fixesTable.count === 0 ? undefined : '重置筛选'}
          onSecondary={fixesTable.count === 0 ? undefined : resetFixFilters}
        />
      ) : (
        <Card className="panel-card" loading={fixesTable.loading}>
          <Table<Fix> rowKey="id" size="small" dataSource={rows} columns={columns} pagination={{ pageSize: 8 }} scroll={{ x: 1280 }} />
        </Card>
      )}

      <Modal
        open={modalOpen}
        title={editingFix ? '编辑杀青揉捻记录' : '登记杀青揉捻'}
        okText={editingFix ? '保存' : '登记并推进状态'}
        cancelText="取消"
        onCancel={() => {
          setModalOpen(false);
          setEditingFix(null);
        }}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(values: FixDraft) => void submit(values)}>
          <Row gutter={12}>
            <Col span={24}>
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
            </Col>
            <Col span={12}>
              <Form.Item
                label="锅温（℃）"
                name="wokTempC"
                rules={[
                  { required: true, message: '请填写锅温' },
                  {
                    type: 'number',
                    min: FIX_LIMITS.wokTempC.min,
                    max: FIX_LIMITS.wokTempC.max,
                    message: `锅温需在 ${FIX_LIMITS.wokTempC.min}-${FIX_LIMITS.wokTempC.max} ℃`,
                  },
                ]}
              >
                <InputNumber min={FIX_LIMITS.wokTempC.min} max={FIX_LIMITS.wokTempC.max} step={5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="杀青时长（分钟）"
                name="fixMin"
                rules={[
                  { required: true, message: '请填写杀青时长' },
                  {
                    type: 'number',
                    min: FIX_LIMITS.fixMin.min,
                    max: FIX_LIMITS.fixMin.max,
                    message: `杀青时长需在 ${FIX_LIMITS.fixMin.min}-${FIX_LIMITS.fixMin.max} 分钟`,
                  },
                ]}
              >
                <InputNumber min={FIX_LIMITS.fixMin.min} max={FIX_LIMITS.fixMin.max} step={0.5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="揉捻压力" name="rollPressure" rules={[{ required: true, message: '请选择揉捻压力' }]}>
                <Select options={ROLL_PRESSURE_OPTIONS.map((value) => ({ value, label: `${value}压` }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="揉捻时长（分钟）"
                name="rollMin"
                rules={[
                  { required: true, message: '请填写揉捻时长' },
                  {
                    type: 'number',
                    min: FIX_LIMITS.rollMin.min,
                    max: FIX_LIMITS.rollMin.max,
                    message: `揉捻时长需在 ${FIX_LIMITS.rollMin.min}-${FIX_LIMITS.rollMin.max} 分钟`,
                  },
                ]}
              >
                <InputNumber min={FIX_LIMITS.rollMin.min} max={FIX_LIMITS.rollMin.max} step={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item
                label="操作人"
                name="operator"
                rules={[
                  { required: true, message: '请填写操作人' },
                  { max: 12, message: '操作人姓名不超过 12 个字' },
                ]}
              >
                <Input placeholder="例如 陈水金" allowClear />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}
