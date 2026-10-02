/**
 * <DispatchBadge> 调度名次 / 占用 / 异常原因徽标
 * 山场台账（批次行）、杀青揉捻记录、调度台三处共用，保证同一份名次与异常原因。
 * 旧批次没有调度单时统一渲染灰色「未排队」。
 */
import { Tooltip, Tag, Typography } from 'antd';
import {
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  LockOutlined,
  MinusCircleOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import type { BatchDispatchSummary } from '../../utils/dispatchViews';
import { DISPATCH_TASK_LABEL } from '../../types/dispatch';

export interface DispatchBadgeProps {
  summary: BatchDispatchSummary;
  /** 是否以 Tooltip 展开占用工位与异常原因（列表窄列场景） */
  withTooltip?: boolean;
}

const STATE_COLOR: Record<string, string> = {
  QUEUED: 'gold',
  HELD: 'volcano',
  CONFIRMED: 'green',
  FAILED: 'red',
  CANCELLED: 'default',
};

export function DispatchBadgeText({ summary }: { summary: BatchDispatchSummary }) {
  const { order } = summary;
  if (!order) {
    return (
      <Tag icon={<MinusCircleOutlined />} color="default" style={{ marginInlineEnd: 0 }}>
        未排队
      </Tag>
    );
  }
  if (order.state === 'HELD') {
    const names = summary.heldWorkstationNames.join('、') || '工位';
    return (
      <span>
        <Tag icon={<LockOutlined />} color={STATE_COLOR.HELD} style={{ marginInlineEnd: 0 }}>
          #{order.seq} 占用中
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
          {DISPATCH_TASK_LABEL[order.task]} · {names}
        </Typography.Text>
      </span>
    );
  }
  if (order.state === 'FAILED') {
    return (
      <Tag icon={<ExclamationCircleOutlined />} color={STATE_COLOR.FAILED} style={{ marginInlineEnd: 0 }}>
        #{order.seq} 保存失败 · 第 {summary.queuePosition ?? '-'} 位
      </Tag>
    );
  }
  if (order.state === 'CONFIRMED') {
    return (
      <Tag icon={<CheckCircleOutlined />} color={STATE_COLOR.CONFIRMED} style={{ marginInlineEnd: 0 }}>
        #{order.seq} 已确认
      </Tag>
    );
  }
  if (order.state === 'CANCELLED') {
    return (
      <Tag color={STATE_COLOR.CANCELLED} style={{ marginInlineEnd: 0 }}>
        #{order.seq} 已取消
      </Tag>
    );
  }
  return (
    <span>
      <Tag icon={<ClockCircleOutlined />} color={STATE_COLOR.QUEUED} style={{ marginInlineEnd: 0 }}>
        #{order.seq} 排队第 {summary.queuePosition ?? '-'} / {summary.queueLength}
      </Tag>
      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
        {DISPATCH_TASK_LABEL[order.task]}
      </Typography.Text>
    </span>
  );
}

export default function DispatchBadge({ summary, withTooltip = true }: DispatchBadgeProps) {
  const node = <DispatchBadgeText summary={summary} />;
  if (!withTooltip) return node;
  const lines: string[] = [];
  const { order } = summary;
  if (!order) {
    lines.push(summary.reasonText);
  } else {
    lines.push(`调度单 #${order.seq} · ${DISPATCH_TASK_LABEL[order.task]}`);
    if (order.state === 'HELD') {
      lines.push(`占用工位：${summary.heldWorkstationNames.join('、') || '—'}`);
      lines.push(summary.reasonText === '—' ? '等待确认，确认前工序不得向后推进' : summary.reasonText);
    } else if (order.state === 'QUEUED' || order.state === 'FAILED') {
      lines.push(`队列名次：第 ${summary.queuePosition ?? '-'} 位（共 ${summary.queueLength} 个等待）`);
      lines.push(`异常原因：${summary.reasonText}`);
    } else {
      lines.push(`异常原因：${summary.reasonText}`);
    }
  }
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{lines.join('\n')}</span>} placement="topLeft">
      {node}
    </Tooltip>
  );
}
