/**
 * /gardens 山场与茶青批次台账
 * - 山场卡片回显批次数量、鲜叶合计与审评均分（消费 Garden / Batch / Review）
 * - 新建 / 编辑山场（Modal + Form 校验）、删除山场（级联删除批次及其工序子表）
 * - 批次登记、工序状态流转、做青时间线预览（消费 useTurnTimeline）
 * - 整库 JSON 导出 / 导入（消费 utils/export）
 */
import { useMemo, useRef, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import GradeTag from '../components/common/GradeTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useTurnTimeline } from '../hooks/useTurnTimeline';
import { filterGardens, useGardenStore } from '../stores/gardenStore';
import { useBatchStore } from '../stores/batchStore';
import { ALTITUDE_BANDS, CULTIVAR_OPTIONS, SOIL_OPTIONS, type Garden, type GardenDraft } from '../types/garden';
import { BATCH_STATES, TENDERNESS_OPTIONS, type Batch, type BatchDraft } from '../types/batch';
import {
  CULTIVAR_COLOR,
  SOIL_COLOR,
  altitudeBandLabel,
  averageScore,
  batchLabel,
  judgeWaterLoss,
  minutesToReadable,
  roundTo,
  todayIso,
} from '../utils/tea';
import { exportSnapshotJson, parseSnapshotJson, readJsonFile } from '../utils/export';
import { exportSnapshot, importSnapshot } from '../utils/db';

export default function GardenList() {
  const { message, modal } = App.useApp();
  const [gardenForm] = Form.useForm<GardenDraft>();
  const [batchForm] = Form.useForm<BatchDraft>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const gardens = useGardenStore((state) => state.gardens);
  const metrics = useGardenStore((state) => state.metrics);
  const filters = useGardenStore((state) => state.filters);
  const setFilters = useGardenStore((state) => state.setFilters);
  const resetFilters = useGardenStore((state) => state.resetFilters);
  const createGarden = useGardenStore((state) => state.createGarden);
  const updateGarden = useGardenStore((state) => state.updateGarden);
  const deleteGarden = useGardenStore((state) => state.deleteGarden);
  const loadGardens = useGardenStore((state) => state.loadGardens);
  const currentGardenId = useGardenStore((state) => state.currentGardenId);
  const selectGarden = useGardenStore((state) => state.selectGarden);

  const batches = useBatchStore((state) => state.batches);
  const createBatch = useBatchStore((state) => state.createBatch);
  const updateBatch = useBatchStore((state) => state.updateBatch);
  const deleteBatch = useBatchStore((state) => state.deleteBatch);
  const advanceBatchState = useBatchStore((state) => state.advanceBatchState);
  const loadBatches = useBatchStore((state) => state.loadBatches);
  const loadReviews = useBatchStore((state) => state.loadReviews);

  const [gardenModalOpen, setGardenModalOpen] = useState(false);
  const [editingGarden, setEditingGarden] = useState<Garden | null>(null);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null);
  const [drawerGardenId, setDrawerGardenId] = useState<string | null>(null);

  const rows = useMemo(() => filterGardens(gardens, filters), [gardens, filters]);

  const totals = useMemo(() => {
    const list = Object.values(metrics);
    const batchCount = list.reduce((acc, item) => acc + item.batchCount, 0);
    const freshLeafKg = roundTo(
      list.reduce((acc, item) => acc + item.freshLeafKg, 0),
      1,
    );
    const scores = rows
      .map((garden) => metrics[garden.id]?.averageScore)
      .filter((score): score is number => typeof score === 'number');
    return { batchCount, freshLeafKg, average: averageScore(scores) };
  }, [metrics, rows]);

  const detailBatches = useMemo(
    () =>
      batches
        .filter((batch) => batch.gardenId === drawerGardenId)
        .sort((a, b) => b.pickedAt.localeCompare(a.pickedAt)),
    [batches, drawerGardenId],
  );
  const timelineBatchId = detailBatches[0]?.id ?? null;
  const timeline = useTurnTimeline(timelineBatchId);
  const detailGarden = gardens.find((garden) => garden.id === drawerGardenId) ?? null;

  const selectConfigs: FilterSelectConfig[] = [
    { key: 'cultivars', label: '按品种筛选', options: CULTIVAR_OPTIONS.map((value) => ({ value, label: value })) },
    { key: 'soils', label: '按土壤筛选', options: SOIL_OPTIONS.map((value) => ({ value, label: value })) },
    {
      key: 'bands',
      label: '按海拔分段筛选',
      options: ALTITUDE_BANDS.map((band) => ({ value: band.key, label: band.label })),
      width: 190,
    },
  ];

  /* ------------------------------ 山场表单 ------------------------------ */

  const openGardenModal = (garden?: Garden): void => {
    setEditingGarden(garden ?? null);
    setGardenModalOpen(true);
    if (garden) {
      gardenForm.setFieldsValue({
        name: garden.name,
        altitudeM: garden.altitudeM,
        soil: garden.soil,
        cultivar: garden.cultivar,
        aspect: garden.aspect,
      });
    } else {
      gardenForm.setFieldsValue({ name: '', altitudeM: 300, soil: '砾壤', cultivar: '肉桂', aspect: '东南向' });
    }
  };

  const submitGarden = async (values: GardenDraft): Promise<void> => {
    try {
      if (editingGarden) {
        await updateGarden(editingGarden.id, values);
        message.success(`已更新山场「${values.name}」`);
      } else {
        const created = await createGarden(values);
        message.success(`已新建山场「${created.name}」，可直接挂茶青批次`);
      }
      setGardenModalOpen(false);
      setEditingGarden(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '山场保存失败');
    }
  };

  const confirmDeleteGarden = (garden: Garden): void => {
    const batchCount = metrics[garden.id]?.batchCount ?? 0;
    modal.confirm({
      title: `删除山场「${garden.name}」？`,
      content: `将级联删除该山场下的 ${batchCount} 个茶青批次，以及这些批次的做青轮次、杀青揉捻、焙火与审评记录。此操作不可撤销。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteGarden(garden.id);
          await Promise.all([loadBatches(), loadReviews()]);
          if (drawerGardenId === garden.id) setDrawerGardenId(null);
          message.success('山场及其关联工序记录已删除');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  /* ------------------------------ 批次表单 ------------------------------ */

  const openBatchModal = (gardenId: string, batch?: Batch): void => {
    setEditingBatch(batch ?? null);
    setBatchModalOpen(true);
    if (batch) {
      batchForm.setFieldsValue({
        gardenId: batch.gardenId,
        pickedAt: batch.pickedAt,
        freshLeafKg: batch.freshLeafKg,
        tenderness: batch.tenderness,
        weather: batch.weather,
        state: batch.state,
      });
    } else {
      batchForm.setFieldsValue({
        gardenId,
        pickedAt: todayIso(),
        freshLeafKg: 20,
        tenderness: '一芽三叶',
        weather: '晴',
        state: '做青中',
      });
    }
  };

  const submitBatch = async (values: BatchDraft): Promise<void> => {
    try {
      if (editingBatch) {
        await updateBatch(editingBatch.id, values);
        message.success('批次已更新');
      } else {
        await createBatch(values);
        message.success('已登记茶青批次，可进入做青轮次编排');
      }
      setBatchModalOpen(false);
      setEditingBatch(null);
      await loadGardens();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '批次保存失败');
    }
  };

  const confirmDeleteBatch = (batch: Batch, gardenName: string): void => {
    modal.confirm({
      title: `删除批次「${batchLabel(batch, gardenName)}」？`,
      content: '将级联删除该批次的做青轮次、杀青揉捻、焙火道次与审评记录。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteBatch(batch.id);
          await loadGardens();
          message.success('批次及其工序记录已删除');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  const handleAdvance = async (batch: Batch): Promise<void> => {
    const next = await advanceBatchState(batch.id);
    if (next) {
      await loadGardens();
      message.success(`批次状态已推进到「${next}」`);
    } else {
      message.info('该批次已完成全部工序（已审评）');
    }
  };

  /* ------------------------------ 导出 / 导入 ------------------------------ */

  const handleExport = async (): Promise<void> => {
    try {
      const filename = exportSnapshotJson(await exportSnapshot());
      message.success(`已导出整库存档：${filename}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导出失败');
    }
  };

  const handleImportFile = async (file: File): Promise<void> => {
    try {
      const snapshot = parseSnapshotJson(await readJsonFile(file));
      await importSnapshot(snapshot);
      await Promise.all([loadGardens(), loadBatches(), loadReviews()]);
      message.success(`导入成功：${snapshot.gardens.length} 个山场 / ${snapshot.batches.length} 个批次`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导入失败');
    }
  };

  /* -------------------------------- 列定义 -------------------------------- */

  const batchColumns: ColumnsType<Batch> = [
    { title: '采摘日', dataIndex: 'pickedAt', width: 110 },
    {
      title: '嫩度',
      dataIndex: 'tenderness',
      width: 170,
      render: (value: Batch['tenderness']) => <GradeTag kind="tenderness" value={value} />,
    },
    { title: '鲜叶(kg)', dataIndex: 'freshLeafKg', width: 90 },
    { title: '气象备注', dataIndex: 'weather', ellipsis: true },
    {
      title: '工序状态',
      dataIndex: 'state',
      width: 120,
      render: (value: Batch['state']) => <GradeTag kind="state" value={value} />,
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_: unknown, batch: Batch) => (
        <Space size={4} wrap>
          <Button size="small" type="link" onClick={() => void handleAdvance(batch)}>
            推进状态
          </Button>
          <Button size="small" type="link" onClick={() => openBatchModal(batch.gardenId, batch)}>
            编辑
          </Button>
          <Button size="small" type="link" danger onClick={() => confirmDeleteBatch(batch, detailGarden?.name ?? '')}>
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
            山场与茶青批次台账
          </Typography.Title>
          <div className="page-hint">
            登记山场地块（品种 / 土壤 / 海拔 / 朝向）并挂茶青批次；批次状态随做青、杀青、焙火、审评自动流转。
          </div>
        </div>
        <Space wrap>
          <Button icon={<DownloadOutlined />} onClick={() => void handleExport()}>
            导出整库 JSON
          </Button>
          <Button icon={<CloudUploadOutlined />} onClick={() => fileInputRef.current?.click()}>
            导入 JSON
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void handleImportFile(file);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void loadGardens()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openGardenModal()}>
            新建山场
          </Button>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="山场" value={rows.length} suffix={`/ ${gardens.length}`} tone="primary" />
        <StatBadge label="批次" value={totals.batchCount} suffix="个" />
        <StatBadge label="鲜叶合计" value={totals.freshLeafKg} suffix="kg" tone="info" />
        <StatBadge
          label="审评均分"
          value={totals.average === null ? '—' : totals.average}
          suffix="分"
          tone="warning"
          hint="按山场下已有审评记录加权总分求平均"
        />
      </div>

      <FilterBar
        value={filters}
        onChange={setFilters}
        selects={selectConfigs}
        onReset={resetFilters}
        placeholder="搜索山场名 / 朝向 / 品种"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            筛选条件会同步到地址栏，可直接分享当前视图
          </Typography.Text>
        }
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={gardens.length === 0 ? '还没有山场' : '没有命中筛选条件的山场'}
          description={
            gardens.length === 0
              ? '先建一个山场（例如牛栏坑 / 慧苑坑），再挂上当季茶青批次。'
              : '试试调整关键字、品种、土壤或海拔分段。'
          }
          actionText={gardens.length === 0 ? '新建山场' : undefined}
          onAction={gardens.length === 0 ? () => openGardenModal() : undefined}
          secondaryText={gardens.length === 0 ? '导入整库 JSON' : '重置筛选'}
          onSecondary={() =>
            gardens.length === 0 ? fileInputRef.current?.click() : resetFilters()
          }
        />
      ) : (
        <Row gutter={[14, 14]}>
          {rows.map((garden) => {
            const metric = metrics[garden.id];
            const gardenAverage = metric?.averageScore;
            return (
              <Col key={garden.id} xs={24} md={12} xl={8}>
                <Card
                  className="garden-card"
                  title={
                    <Space size={8} wrap>
                      <span>{garden.name}</span>
                      <Tag color={CULTIVAR_COLOR[garden.cultivar]}>{garden.cultivar}</Tag>
                      <Tag color={SOIL_COLOR[garden.soil]}>{garden.soil}</Tag>
                    </Space>
                  }
                  extra={
                    <Button
                      size="small"
                      type="link"
                      onClick={() => {
                        selectGarden(garden.id);
                        setDrawerGardenId(garden.id);
                      }}
                    >
                      详情
                    </Button>
                  }
                  actions={[
                    <Button key="batch" type="link" icon={<PlusOutlined />} onClick={() => openBatchModal(garden.id)}>
                      新建批次
                    </Button>,
                    <Button key="edit" type="link" icon={<EditOutlined />} onClick={() => openGardenModal(garden)}>
                      编辑
                    </Button>,
                    <Button key="del" type="link" danger icon={<DeleteOutlined />} onClick={() => confirmDeleteGarden(garden)}>
                      删除
                    </Button>,
                  ]}
                >
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Space size={8} wrap>
                      <Tag>{altitudeBandLabel(garden.altitudeM)}</Tag>
                      <Tag>{garden.altitudeM} m</Tag>
                      <Tag>{garden.aspect}</Tag>
                      {garden.id === currentGardenId ? <Tag color="#2f5136">当前山场</Tag> : null}
                    </Space>
                    <Space size={20} wrap>
                      <StatBadge size="small" label="批次" value={metric?.batchCount ?? 0} suffix="个" />
                      <StatBadge size="small" label="鲜叶" value={metric?.freshLeafKg ?? 0} suffix="kg" tone="info" />
                      {typeof gardenAverage === 'number' ? (
                        <StatBadge
                          size="small"
                          label="审评均分"
                          value={gardenAverage}
                          tone="warning"
                          hint={`最近采摘：${metric?.latestPickedAt ?? '—'}`}
                        />
                      ) : (
                        <StatBadge size="small" label="审评均分" value="暂无审评" />
                      )}
                    </Space>
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      {/* ------------------------------ 山场详情抽屉 ------------------------------ */}
      <Drawer
        width={860}
        open={drawerGardenId !== null}
        onClose={() => setDrawerGardenId(null)}
        title={detailGarden ? `${detailGarden.name} · 批次与做青时间线` : '山场详情'}
        extra={
          detailGarden ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openBatchModal(detailGarden.id)}>
              新建批次
            </Button>
          ) : null
        }
      >
        {detailBatches.length === 0 ? (
          <EmptyPanel
            size="small"
            title="该山场还没有茶青批次"
            description="登记采摘日期、鲜叶重量与嫩度后即可排做青轮次。"
            actionText="新建批次"
            onAction={() => detailGarden && openBatchModal(detailGarden.id)}
          />
        ) : (
          <>
            <Table<Batch>
              rowKey="id"
              size="small"
              dataSource={detailBatches}
              columns={batchColumns}
              pagination={false}
              scroll={{ x: 720 }}
            />
            <div className="panel-card" style={{ marginTop: 16 }}>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                做青时间线 · 最新批次 {detailBatches[0] ? detailBatches[0].pickedAt : ''}
              </Typography.Title>
              {timeline.items.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该批次还没有做青轮次" />
              ) : (
                <>
                  <div className="stat-row">
                    <StatBadge size="small" label="累计摇青" value={timeline.totalShakeMin} suffix="分钟" tone="primary" />
                    <StatBadge size="small" label="累计静置" value={timeline.totalRestMin} suffix="分钟" tone="info" />
                    <StatBadge size="small" label="做青总时长" value={minutesToReadable(timeline.totalMin)} />
                    <StatBadge
                      size="small"
                      label="末轮失水率"
                      value={timeline.finalWaterLossPct}
                      suffix="%"
                      tone={timeline.verdicts.waterLoss?.level === 'ok' ? 'success' : 'warning'}
                      hint={timeline.verdicts.waterLoss?.hint}
                    />
                    <StatBadge size="small" label="摇青占比" value={timeline.shakeRatioPct} suffix="%" />
                  </div>
                  <div className="timeline-track">
                    {timeline.segments.map((segment) => {
                      const ratio = timeline.totalMin > 0 ? (segment.durationMin / timeline.totalMin) * 100 : 0;
                      return (
                        <div
                          key={`${segment.turnId}-${segment.kind}`}
                          className={`timeline-segment ${segment.kind === 'shake' ? 'is-shake' : 'is-rest'}`}
                          style={{ width: `${ratio}%` }}
                          title={`第 ${segment.roundNo} 轮 ${segment.kind === 'shake' ? '摇青' : '静置'} ${segment.durationMin} 分钟`}
                        >
                          {ratio > 8 ? `${segment.kind === 'shake' ? '摇' : '静'}${segment.roundNo}` : ''}
                        </div>
                      );
                    })}
                  </div>
                  <div className="timeline-legend">
                    <span>■ 摇青段</span>
                    <span>■ 静置段</span>
                    <span>
                      走势：
                      {timeline.trend === 'rising' ? '失水持续上升' : timeline.trend === 'falling' ? '失水回落' : '失水平稳'}
                    </span>
                    <span>峰值失水速率 {timeline.peakWaterLossRatePerHour} 百分点/小时</span>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    {timeline.items.map((item) => (
                      <div key={item.turn.id} style={{ marginBottom: 6 }}>
                        <Space size={10} style={{ fontSize: 12 }}>
                          <span>第 {item.turn.roundNo} 轮</span>
                          <span>摇 {item.turn.shakeMin} 分钟 / 静 {item.turn.restMin} 分钟</span>
                          <span>累计 {item.accumulatedTotalMin} 分钟</span>
                          <span>失水 {item.waterLossPct}%</span>
                          <span>（{item.waterLossDeltaPct >= 0 ? '+' : ''}{item.waterLossDeltaPct} 百分点）</span>
                        </Space>
                        <Progress
                          percent={Math.min(100, (item.waterLossPct / 40) * 100)}
                          showInfo={false}
                          strokeColor={{ from: '#95c98a', to: '#c9963c' }}
                          size="small"
                        />
                      </div>
                    ))}
                    {timeline.verdicts.waterLoss ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        末轮判定：{judgeWaterLoss(timeline.finalWaterLossPct).label} · {timeline.verdicts.waterLoss.hint}
                      </Typography.Text>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </Drawer>

      {/* ------------------------------ 山场表单弹窗 ------------------------------ */}
      <Modal
        open={gardenModalOpen}
        title={editingGarden ? `编辑山场 · ${editingGarden.name}` : '新建山场'}
        okText={editingGarden ? '保存' : '创建'}
        cancelText="取消"
        onCancel={() => {
          setGardenModalOpen(false);
          setEditingGarden(null);
        }}
        onOk={() => gardenForm.submit()}
        destroyOnClose
      >
        <Form form={gardenForm} layout="vertical" onFinish={(values: GardenDraft) => void submitGarden(values)}>
          <Form.Item
            label="山场名"
            name="name"
            rules={[
              { required: true, message: '请填写山场名' },
              { max: 20, message: '山场名不超过 20 个字' },
            ]}
          >
            <Input placeholder="例如 牛栏坑 / 慧苑坑 / 马头岩" allowClear />
          </Form.Item>
          <Form.Item
            label="海拔（米）"
            name="altitudeM"
            rules={[
              { required: true, message: '请填写海拔' },
              { type: 'number', min: 50, max: 2000, message: '海拔需在 50-2000 米之间' },
            ]}
          >
            <InputNumber min={50} max={2000} step={10} style={{ width: '100%' }} addonAfter="m" />
          </Form.Item>
          <Form.Item label="土壤" name="soil" rules={[{ required: true, message: '请选择土壤类型' }]}>
            <Select options={SOIL_OPTIONS.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item label="主栽品种" name="cultivar" rules={[{ required: true, message: '请选择主栽品种' }]}>
            <Select options={CULTIVAR_OPTIONS.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item
            label="朝向"
            name="aspect"
            rules={[
              { required: true, message: '请填写朝向' },
              { max: 12, message: '朝向不超过 12 个字' },
            ]}
          >
            <Input placeholder="例如 东南向 / 北向" allowClear />
          </Form.Item>
        </Form>
      </Modal>

      {/* ------------------------------ 批次表单弹窗 ------------------------------ */}
      <Modal
        open={batchModalOpen}
        title={editingBatch ? '编辑茶青批次' : '新建茶青批次'}
        okText={editingBatch ? '保存' : '创建'}
        cancelText="取消"
        onCancel={() => {
          setBatchModalOpen(false);
          setEditingBatch(null);
        }}
        onOk={() => batchForm.submit()}
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical" onFinish={(values: BatchDraft) => void submitBatch(values)}>
          <Form.Item label="所属山场" name="gardenId" rules={[{ required: true, message: '请选择所属山场' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={gardens.map((garden) => ({ value: garden.id, label: `${garden.name}（${garden.cultivar}）` }))}
            />
          </Form.Item>
          <Form.Item
            label="采摘日期"
            name="pickedAt"
            rules={[
              { required: true, message: '请选择采摘日期' },
              {
                pattern: /^\d{4}-\d{2}-\d{2}$/,
                message: '日期格式需为 YYYY-MM-DD',
              },
            ]}
          >
            <Input placeholder="2025-04-26" />
          </Form.Item>
          <Form.Item
            label="鲜叶重量（kg）"
            name="freshLeafKg"
            rules={[
              { required: true, message: '请填写鲜叶重量' },
              { type: 'number', min: 1, max: 2000, message: '重量需在 1-2000 kg 之间' },
            ]}
          >
            <InputNumber min={1} max={2000} step={0.5} style={{ width: '100%' }} addonAfter="kg" />
          </Form.Item>
          <Form.Item label="嫩度" name="tenderness" rules={[{ required: true, message: '请选择嫩度' }]}>
            <Select options={TENDERNESS_OPTIONS.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item label="气象备注" name="weather" rules={[{ max: 60, message: '备注不超过 60 个字' }]}>
            <Input placeholder="例如 晴，北风 2 级，晨露已干" allowClear />
          </Form.Item>
          <Form.Item label="工序状态" name="state" rules={[{ required: true, message: '请选择工序状态' }]}>
            <Select options={BATCH_STATES.map((value) => ({ value, label: value }))} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
