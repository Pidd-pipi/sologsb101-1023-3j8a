/**
 * /blending 拼配方案登记与结构版本导出
 * - 按审评总分排序生成拼配候选清单，勾选毛茶并分配占比
 * - 拼配占比校验（合计必须等于 100%），校验通过后可落库写入审评记录的拼配去向
 * - 拼配方案 JSON 导出 + 整库结构版本 JSON 导出（消费 utils/export）
 */
import { useMemo, useState } from 'react';
import { Alert, App, Button, Card, Col, Divider, Input, InputNumber, Row, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ClearOutlined, DownloadOutlined, ExportOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import GradeTag from '../components/common/GradeTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useIdbTable } from '../hooks/useIdbTable';
import { useGardenStore } from '../stores/gardenStore';
import { filterBlendCandidates, useBatchStore } from '../stores/batchStore';
import { db, exportSnapshot } from '../utils/db';
import {
  blendNoteOf,
  buildBlendPlanPayload,
  exportBlendPlanJson,
  exportSnapshotJson,
  validateBlendPlan,
  type BlendPlanItem,
} from '../utils/export';
import { BATCH_STATES } from '../types/batch';
import type { BlendCandidate, Review } from '../types/review';
import { SCORE_BANDS, buildBlendCandidates, isBlendCandidate, roundTo } from '../utils/tea';

export default function BlendPlan() {
  const { message } = App.useApp();

  const gardens = useGardenStore((state) => state.gardens);
  const batches = useBatchStore((state) => state.batches);
  const blendFilters = useBatchStore((state) => state.blendFilters);
  const setBlendFilters = useBatchStore((state) => state.setBlendFilters);
  const resetBlendFilters = useBatchStore((state) => state.resetBlendFilters);
  const blendDraft = useBatchStore((state) => state.blendDraft);
  const blendPlanName = useBatchStore((state) => state.blendPlanName);
  const setBlendPlanName = useBatchStore((state) => state.setBlendPlanName);
  const toggleBlendBatch = useBatchStore((state) => state.toggleBlendBatch);
  const setBlendRatio = useBatchStore((state) => state.setBlendRatio);
  const setBlendDraft = useBatchStore((state) => state.setBlendDraft);
  const autoFillBlendDraft = useBatchStore((state) => state.autoFillBlendDraft);
  const clearBlendDraft = useBatchStore((state) => state.clearBlendDraft);

  const reviewsTable = useIdbTable<Review>(db.reviews, {
    prefix: 'review',
    sort: (a, b) => b.totalScore - a.totalScore,
  });
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(
    () => buildBlendCandidates(reviewsTable.rows, batches, gardens),
    [batches, gardens, reviewsTable.rows],
  );
  const rows = useMemo(() => filterBlendCandidates(candidates, blendFilters), [blendFilters, candidates]);

  const selectedKeys = useMemo(() => blendDraft.map((item) => item.batchId), [blendDraft]);
  const ratioOf = (batchId: string): number => blendDraft.find((item) => item.batchId === batchId)?.ratioPct ?? 0;

  const planItems = useMemo<BlendPlanItem[]>(() => {
    const list: BlendPlanItem[] = [];
    blendDraft.forEach((draft) => {
      const candidate = candidates.find((item) => item.batchId === draft.batchId);
      if (!candidate) return;
      const review = reviewsTable.rows.find((item) => item.id === draft.reviewId);
      list.push({
        batchId: candidate.batchId,
        batchLabel: candidate.batchLabel,
        gardenName: candidate.gardenName,
        cultivar: candidate.cultivar,
        totalScore: candidate.totalScore,
        ratioPct: draft.ratioPct,
        reviewId: draft.reviewId,
        blendNote: review?.blendNote ?? '',
      });
    });
    return list;
  }, [blendDraft, candidates, reviewsTable.rows]);

  const validationError = planItems.length === 0 ? '请先勾选 2 款以上毛茶' : validateBlendPlan(planItems);
  const totalRatio = roundTo(
    planItems.reduce((acc, item) => acc + item.ratioPct, 0),
    1,
  );

  const selectConfigs: FilterSelectConfig[] = [
    {
      key: 'gardenIds',
      label: '按山场筛选',
      options: gardens.map((garden) => ({ value: garden.id, label: garden.name })),
    },
    {
      key: 'bands',
      label: '按总分区间筛选',
      options: SCORE_BANDS.map((band) => ({ value: band.key, label: band.label })),
      width: 190,
    },
    {
      key: 'states',
      label: '按批次状态筛选',
      options: BATCH_STATES.map((value) => ({ value, label: value })),
      width: 168,
    },
  ];

  const handleAutoFill = (): void => {
    if (candidates.length === 0) {
      message.warning('还没有审评记录，无法生成拼配候选');
      return;
    }
    autoFillBlendDraft(candidates, 3);
    message.success('已按审评总分权重自动配比前 3 款候选（合计 100%）');
  };

  const handleSave = async (): Promise<void> => {
    if (validationError) {
      message.error(validationError);
      return;
    }
    setSaving(true);
    try {
      for (const item of planItems) {
        await reviewsTable.update(item.reviewId, { blendNote: blendNoteOf(blendPlanName, item, planItems) });
      }
      message.success(`拼配方案「${blendPlanName}」已写入 ${planItems.length} 条审评记录的拼配去向`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '拼配方案保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleExportPlan = (): void => {
    try {
      const filename = exportBlendPlanJson(buildBlendPlanPayload(blendPlanName, planItems));
      message.success(`已导出拼配方案 JSON：${filename}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导出失败');
    }
  };

  const handleExportSnapshot = async (): Promise<void> => {
    try {
      const snapshot = await exportSnapshot();
      const filename = exportSnapshotJson(snapshot);
      message.success(`已导出整库结构版本 v${snapshot.schemaVersion}：${filename}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导出失败');
    }
  };

  const columns: ColumnsType<BlendCandidate> = [
    {
      title: '名次',
      key: 'rank',
      width: 70,
      render: (_: unknown, row) => `第 ${rows.findIndex((item) => item.batchId === row.batchId) + 1} 名`,
    },
    { title: '毛茶批次', dataIndex: 'batchLabel', width: 250 },
    { title: '山场', dataIndex: 'gardenName', width: 120 },
    {
      title: '品种',
      dataIndex: 'cultivar',
      width: 90,
      render: (value: string) => <Tag color="green">{value}</Tag>,
    },
    { title: '采摘日', dataIndex: 'pickedAt', width: 110 },
    {
      title: '审评总分',
      dataIndex: 'totalScore',
      width: 190,
      sorter: (a, b) => a.totalScore - b.totalScore,
      defaultSortOrder: 'descend',
      render: (value: number) => <GradeTag kind="score" value={value} />,
    },
    {
      title: '候选资格',
      key: 'candidate',
      width: 110,
      render: (_: unknown, row) => (isBlendCandidate(row.totalScore) ? <Tag color="volcano">候选</Tag> : <Tag>待复评</Tag>),
    },
    {
      title: '工序状态',
      dataIndex: 'state',
      width: 120,
      render: (value: string) => <GradeTag kind="state" value={value} />,
    },
    {
      title: '拼配占比（%）',
      key: 'ratio',
      width: 170,
      render: (_: unknown, row) => {
        const selected = selectedKeys.includes(row.batchId);
        return (
          <InputNumber
            min={0}
            max={100}
            step={1}
            disabled={!selected}
            value={selected ? ratioOf(row.batchId) : 0}
            onChange={(value) => setBlendRatio(row.batchId, typeof value === 'number' ? value : 0)}
            style={{ width: 110 }}
            addonAfter="%"
          />
        );
      },
    },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            拼配方案登记与结构版本导出
          </Typography.Title>
          <div className="page-hint">
            按审评总分组合批次并分配占比；占比合计必须等于 100%，保存后写入审评记录的「拼配去向」字段。
          </div>
        </div>
        <Space wrap>
          <Input
            style={{ width: 200 }}
            value={blendPlanName}
            onChange={(event) => setBlendPlanName(event.target.value)}
            placeholder="拼配方案名称"
            addonBefore="方案"
          />
          <Button icon={<ThunderboltOutlined />} onClick={handleAutoFill}>
            按总分自动配比
          </Button>
          <Button icon={<ClearOutlined />} onClick={() => clearBlendDraft()} disabled={blendDraft.length === 0}>
            清空选择
          </Button>
          <Button icon={<SaveOutlined />} loading={saving} disabled={Boolean(validationError)} onClick={() => void handleSave()}>
            保存方案
          </Button>
          <Button icon={<ExportOutlined />} disabled={Boolean(validationError)} onClick={handleExportPlan}>
            导出拼配 JSON
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => void handleExportSnapshot()}>
            导出整库结构版本
          </Button>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="审评记录" value={candidates.length} suffix="条" tone="primary" />
        <StatBadge label="命中筛选" value={rows.length} suffix="条" />
        <StatBadge label="已选毛茶" value={planItems.length} suffix="款" tone="info" />
        <StatBadge
          label="占比合计"
          value={totalRatio}
          suffix="%"
          tone={totalRatio === 100 ? 'success' : 'danger'}
          hint={validationError ?? '占比校验通过'}
        />
        <StatBadge
          label="候选门槛"
          value={candidates.filter((item) => isBlendCandidate(item.totalScore)).length}
          suffix="款"
          tone="warning"
          hint="审评总分 ≥ 85 分"
        />
      </div>

      <FilterBar
        value={blendFilters}
        onChange={setBlendFilters}
        selects={selectConfigs}
        onReset={resetBlendFilters}
        placeholder="搜索山场 / 批次 / 品种"
      />

      {planItems.length > 0 && validationError ? (
        <Alert type="warning" showIcon style={{ marginBottom: 14 }} message="拼配占比校验未通过" description={validationError} />
      ) : null}
      {planItems.length > 0 && !validationError ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 14 }}
          message={`占比校验通过：${planItems.length} 款毛茶合计 ${totalRatio}%`}
          description={planItems
            .slice()
            .sort((a, b) => b.ratioPct - a.ratioPct)
            .map((item) => `${item.batchLabel} ${item.ratioPct}%`)
            .join(' ｜ ')}
        />
      ) : null}

      {candidates.length === 0 ? (
        <EmptyPanel
          title="还没有可拼配的审评数据"
          description="先到「毛茶审评」登记香气 / 汤色 / 滋味 / 叶底得分，系统会按总分排序生成拼配候选。"
        />
      ) : rows.length === 0 ? (
        <EmptyPanel
          size="small"
          title="没有命中筛选条件的候选毛茶"
          description="试试调整关键字、山场、总分区间或批次状态。"
          secondaryText="重置筛选"
          onSecondary={resetBlendFilters}
        />
      ) : (
        <Row gutter={[14, 14]}>
          <Col xs={24} xl={16}>
            <Card className="panel-card" title="拼配候选清单（按总分排序）" loading={reviewsTable.loading}>
              <Table<BlendCandidate>
                rowKey="batchId"
                size="small"
                dataSource={rows}
                columns={columns}
                pagination={{ pageSize: 8 }}
                scroll={{ x: 1320 }}
                rowSelection={{
                  selectedRowKeys: selectedKeys,
                  onChange: (keys) => {
                    const next = keys as string[];
                    // 以勾选结果为准同步草稿：新增的补进草稿，取消的移除
                    selectedKeys
                      .filter((key) => !next.includes(key))
                      .forEach((key) => {
                        const candidate = candidates.find((item) => item.batchId === key);
                        if (candidate) toggleBlendBatch(candidate.batchId, candidate.reviewId);
                      });
                    next
                      .filter((key) => !selectedKeys.includes(key))
                      .forEach((key) => {
                        const candidate = candidates.find((item) => item.batchId === key);
                        if (candidate) toggleBlendBatch(candidate.batchId, candidate.reviewId);
                      });
                  },
                }}
              />
            </Card>
          </Col>
          <Col xs={24} xl={8}>
            <Card className="panel-card" title="方案预览">
              {planItems.length === 0 ? (
                <Typography.Text type="secondary">
                  勾选左侧候选毛茶后，这里会显示拼配比例与预计拼配文案。
                </Typography.Text>
              ) : (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Typography.Text strong>{blendPlanName || '未命名拼配方案'}</Typography.Text>
                  {planItems
                    .slice()
                    .sort((a, b) => b.ratioPct - a.ratioPct)
                    .map((item) => (
                      <div key={item.batchId} className="candidate-row">
                        <Space size={8} wrap>
                          <Tag color="green">{item.cultivar}</Tag>
                          <span>{item.batchLabel}</span>
                          <GradeTag kind="score" value={item.totalScore} showIcon={false} />
                          <strong className={totalRatio === 100 ? 'ratio-sum-ok' : 'ratio-sum-bad'}>{item.ratioPct}%</strong>
                        </Space>
                      </div>
                    ))}
                  <Divider style={{ margin: '8px 0' }} />
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      合计占比：
                    </Typography.Text>
                    <strong className={totalRatio === 100 ? 'ratio-sum-ok' : 'ratio-sum-bad'}> {totalRatio}%</strong>
                  </div>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                    {planItems[0] ? blendNoteOf(blendPlanName, planItems[0], planItems) : ''}
                  </Typography.Paragraph>
                  <Space wrap>
                    <Button
                      size="small"
                      onClick={() => {
                        autoFillBlendDraft(candidates, 3);
                        message.success('已重新按总分权重配比');
                      }}
                    >
                      重新配比
                    </Button>
                    <Button size="small" onClick={() => setBlendDraft([])} disabled={planItems.length === 0}>
                      清空草稿
                    </Button>
                  </Space>
                </Space>
              )}
            </Card>
            <Card className="panel-card" title="占比校验说明" style={{ marginTop: 14 }}>
              <Space direction="vertical" size={6}>
                <Typography.Text style={{ fontSize: 12 }}>1. 至少选择 2 款毛茶，单项占比需大于 0。</Typography.Text>
                <Typography.Text style={{ fontSize: 12 }}>2. 所有占比之和必须等于 100%（允许 0.1% 浮点误差）。</Typography.Text>
                <Typography.Text style={{ fontSize: 12 }}>3. 校验通过后才能保存方案或导出拼配 JSON。</Typography.Text>
                <Typography.Text type={validationError ? 'warning' : 'success'} style={{ fontSize: 12 }}>
                  当前状态：{validationError ?? '校验通过，可保存 / 导出'}
                </Typography.Text>
              </Space>
            </Card>
          </Col>
        </Row>
      )}
    </div>
  );
}
