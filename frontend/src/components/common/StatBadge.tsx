/**
 * <StatBadge> 统计徽标：标签 + 数值 + 可选后缀与色调。
 * 被做青页（轮次累计时长、失水率）、焙火页（热负荷、复焙提醒）、山场页与审评页消费。
 */
import type { ReactNode } from 'react';
import { Tooltip } from 'antd';

export type StatTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface StatBadgeProps {
  /** 指标名称，例如「累计摇青」 */
  label: string;
  /** 指标数值 */
  value: ReactNode;
  /** 单位后缀，例如「分钟」「℃·h」 */
  suffix?: string;
  /** 色调 */
  tone?: StatTone;
  /** 前置图标 */
  icon?: ReactNode;
  /** 悬浮说明 */
  hint?: string;
  /** 是否使用紧凑样式 */
  size?: 'small' | 'default';
}

const TONE_STYLE: Record<StatTone, { border: string; background: string; value: string }> = {
  default: { border: 'rgba(47, 81, 54, 0.18)', background: '#fffdf7', value: '#2f3a2c' },
  primary: { border: 'rgba(47, 81, 54, 0.34)', background: '#f1f7ee', value: '#2f5136' },
  success: { border: 'rgba(56, 158, 13, 0.32)', background: '#f2fbe9', value: '#237804' },
  warning: { border: 'rgba(212, 160, 23, 0.35)', background: '#fffbe6', value: '#ad6800' },
  danger: { border: 'rgba(207, 19, 34, 0.3)', background: '#fff1f0', value: '#a8071a' },
  info: { border: 'rgba(22, 119, 255, 0.28)', background: '#f0f7ff', value: '#0958d9' },
};

export function StatBadge({
  label,
  value,
  suffix,
  tone = 'default',
  icon,
  hint,
  size = 'default',
}: StatBadgeProps) {
  const palette = TONE_STYLE[tone];
  const compact = size === 'small';
  const content = (
    <div
      className="stat-badge"
      style={{
        border: `1px solid ${palette.border}`,
        background: palette.background,
        padding: compact ? '6px 10px' : '10px 14px',
        borderRadius: 10,
        minWidth: compact ? 96 : 120,
      }}
    >
      <div style={{ fontSize: compact ? 11 : 12, color: 'rgba(43, 42, 38, 0.62)', display: 'flex', gap: 6 }}>
        {icon}
        <span>{label}</span>
      </div>
      <div style={{ fontSize: compact ? 16 : 20, fontWeight: 600, color: palette.value, lineHeight: 1.4 }}>
        {value}
        {suffix ? <span style={{ fontSize: 12, marginLeft: 4, fontWeight: 400 }}>{suffix}</span> : null}
      </div>
    </div>
  );
  return hint ? <Tooltip title={hint}>{content}</Tooltip> : content;
}

export default StatBadge;
