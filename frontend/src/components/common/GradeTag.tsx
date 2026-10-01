/**
 * <GradeTag> 等级 / 档次标签：按嫩度、火功、评分区间、工序状态与揉捻压力渲染不同底色与图标。
 * 被山场页、做青页、杀青页、焙火页、审评页、拼配页消费。
 */
import type { ReactNode } from 'react';
import { Tag } from 'antd';
import {
  ClockCircleOutlined,
  ExperimentOutlined,
  FireOutlined,
  StarFilled,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { Tenderness } from '../../types/batch';
import { BATCH_STATES, type BatchState } from '../../types/batch';
import { ROLL_PRESSURE_OPTIONS, type RollPressure } from '../../types/fix';
import { ROAST_STATES, type FireLevel, type RoastState } from '../../types/roast';
import {
  BATCH_STATE_COLOR,
  FIRE_LEVEL_COLOR,
  ROLL_PRESSURE_COLOR,
  ROAST_STATE_COLOR,
  TENDERNESS_COLOR,
  TENDERNESS_LABEL,
  scoreColor,
  scoreGrade,
  scoreStars,
} from '../../utils/tea';

/** 标签类别：嫩度 / 火功 / 评分 / 工序状态 / 焙火状态 / 揉捻压力 */
export type GradeKind = 'tenderness' | 'fire' | 'score' | 'state' | 'roastState' | 'pressure';

export interface GradeTagProps {
  kind: GradeKind;
  /** 取值：嫩度与火功为字符串，评分为数值 */
  value: string | number;
  /** 是否显示图标（默认 true） */
  showIcon?: boolean;
  /** 自定义图标，覆盖默认图标 */
  icon?: ReactNode;
  /** 追加后缀，例如「分」 */
  suffix?: string;
}

interface ResolvedTag {
  text: string;
  color: string;
  icon: ReactNode;
}

function isTenderness(value: string): value is Tenderness {
  return value in TENDERNESS_COLOR;
}

function isBatchState(value: string): value is BatchState {
  return (BATCH_STATES as readonly string[]).includes(value);
}

function isRoastState(value: string): value is RoastState {
  return (ROAST_STATES as readonly string[]).includes(value);
}

function isPressure(value: string): value is RollPressure {
  return (ROLL_PRESSURE_OPTIONS as readonly string[]).includes(value);
}

/** 解析出标签文案、底色与图标 */
export function resolveGradeTag(kind: GradeKind, value: string | number): ResolvedTag {
  switch (kind) {
    case 'tenderness': {
      const text = String(value);
      return {
        text: isTenderness(text) ? TENDERNESS_LABEL[text] : text,
        color: isTenderness(text) ? TENDERNESS_COLOR[text] : 'default',
        icon: <ExperimentOutlined />,
      };
    }
    case 'fire': {
      const text = String(value) as FireLevel;
      return {
        text: `${text === '足火' ? '足火（吃火到位）' : text}`,
        color: FIRE_LEVEL_COLOR[text] ?? 'default',
        icon: <FireOutlined />,
      };
    }
    case 'score': {
      const score = Number(value);
      const stars = scoreStars(score);
      return {
        text: `${Number.isFinite(score) ? score.toFixed(1) : '—'} 分 · ${scoreGrade(Number.isFinite(score) ? score : 0)}`,
        color: scoreColor(Number.isFinite(score) ? score : 0),
        icon: <StarFilled style={{ color: stars >= 4 ? '#d4380d' : '#d4a017' }} />,
      };
    }
    case 'state': {
      const text = String(value);
      return {
        text,
        color: isBatchState(text) ? BATCH_STATE_COLOR[text] : 'default',
        icon: <ClockCircleOutlined />,
      };
    }
    case 'roastState': {
      const text = String(value);
      return {
        text,
        color: isRoastState(text) ? ROAST_STATE_COLOR[text] : 'default',
        icon: <FireOutlined />,
      };
    }
    case 'pressure': {
      const text = String(value);
      return {
        text: `${text}压`,
        color: isPressure(text) ? ROLL_PRESSURE_COLOR[text] : 'default',
        icon: <ThunderboltOutlined />,
      };
    }
    default:
      return { text: String(value), color: 'default', icon: null };
  }
}

export function GradeTag({ kind, value, showIcon = true, icon, suffix }: GradeTagProps) {
  const resolved = resolveGradeTag(kind, value);
  return (
    <Tag color={resolved.color} icon={showIcon ? (icon ?? resolved.icon) : undefined} style={{ marginInlineEnd: 0 }}>
      {resolved.text}
      {suffix ?? ''}
    </Tag>
  );
}

export default GradeTag;
