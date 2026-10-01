/**
 * <EmptyPanel> 空数据引导与新建入口（可带次操作，如「重置筛选」「导入 JSON」）。
 * 被全部列表页消费。
 */
import { Button, Empty, Space, Typography } from 'antd';
import type { ReactNode } from 'react';
import { PlusOutlined } from '@ant-design/icons';

export interface EmptyPanelProps {
  /** 标题，例如「还没有山场」 */
  title: string;
  /** 说明文案 */
  description?: ReactNode;
  /** 主操作按钮文案；不传则不渲染 */
  actionText?: string;
  /** 主操作回调 */
  onAction?: () => void;
  /** 次操作按钮文案 */
  secondaryText?: string;
  onSecondary?: () => void;
  /** 附加内容 */
  extra?: ReactNode;
  size?: 'small' | 'default';
}

export function EmptyPanel({
  title,
  description,
  actionText,
  onAction,
  secondaryText,
  onSecondary,
  extra,
  size = 'default',
}: EmptyPanelProps) {
  return (
    <div className="empty-panel" style={{ padding: size === 'small' ? '20px 12px' : '44px 24px' }}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        imageStyle={{ height: size === 'small' ? 40 : 60 }}
        description={
          <Space direction="vertical" size={4}>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {title}
            </Typography.Text>
            {description ? (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {description}
              </Typography.Text>
            ) : null}
          </Space>
        }
      >
        {actionText || secondaryText ? (
          <Space wrap>
            {actionText && onAction ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={onAction}>
                {actionText}
              </Button>
            ) : null}
            {secondaryText && onSecondary ? <Button onClick={onSecondary}>{secondaryText}</Button> : null}
          </Space>
        ) : null}
      </Empty>
      {extra ? <div style={{ marginTop: 12 }}>{extra}</div> : null}
    </div>
  );
}

export default EmptyPanel;
