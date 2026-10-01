/**
 * <FilterBar> 列表筛选栏：关键字 + 多个下拉多选，并把筛选条件同步到 URL query。
 * 被山场页、做青页、杀青页、焙火页、审评页、拼配页消费。
 *
 * 设计约定（全部页面统一）：
 * - 筛选条件保存在各自 Zustand store 的 filters 字段里（跨页状态不留在组件内部 state）
 * - FilterBar 只负责渲染与读写 URL query：kw=<关键字>、f_<selectKey>=<值1>,<值2>
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Input, Select, Space, Tooltip } from 'antd';
import { ClearOutlined, FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';

/** 单个下拉筛选项 */
export interface FilterSelectOption {
  label: string;
  value: string;
}

/** 一个下拉多选的配置 */
export interface FilterSelectConfig {
  /** 字段名，例如 batches / states / cultivars */
  key: string;
  /** 占位文案 */
  label: string;
  options: FilterSelectOption[];
  width?: number;
}

/** 页面筛选条件的统一结构 */
export interface FilterValue {
  keyword: string;
  selects: Record<string, string[]>;
}

export interface FilterBarProps {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
  selects: FilterSelectConfig[];
  placeholder?: string;
  /** 追加在筛选栏右侧的自定义节点（新建按钮等） */
  extra?: ReactNode;
  /** 重置按钮回调；不传则用 emptyFilterValue 自动重置 */
  onReset?: () => void;
}

const KEYWORD_PARAM = 'kw';
const SELECT_PREFIX = 'f_';

/* ------------------------------ 纯函数助手 ------------------------------ */

/** 生成指定下拉键的空筛选值 */
export function emptyFilterValue(selectKeys: string[] = []): FilterValue {
  const selects: Record<string, string[]> = {};
  selectKeys.forEach((key) => {
    selects[key] = [];
  });
  return { keyword: '', selects };
}

/** 读取某个下拉键的选中值 */
export function pickedSelect(value: FilterValue, key: string): string[] {
  return value.selects[key] ?? [];
}

/** 判断某个值是否命中选中集合（空集合表示不筛选） */
export function pickedIncludes(value: FilterValue, key: string, candidate: string): boolean {
  const picked = pickedSelect(value, key);
  return picked.length === 0 || picked.includes(candidate);
}

/** 关键字模糊匹配（空关键字命中全部） */
export function matchKeyword(keyword: string, ...fields: Array<string | number | null | undefined>): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => String(field ?? '').toLowerCase().includes(needle));
}

/** 已启用的筛选条件数量（用于徽标） */
export function countActiveFilters(value: FilterValue): number {
  const selectCount = Object.values(value.selects).reduce((acc, values) => acc + (values.length > 0 ? 1 : 0), 0);
  return selectCount + (value.keyword.trim() ? 1 : 0);
}

/** URL query → FilterValue */
function parseQuery(params: URLSearchParams, selectKeys: string[]): FilterValue {
  const selects: Record<string, string[]> = {};
  selectKeys.forEach((key) => {
    const raw = params.get(`${SELECT_PREFIX}${key}`);
    selects[key] = raw ? raw.split(',').filter(Boolean) : [];
  });
  return { keyword: params.get(KEYWORD_PARAM) ?? '', selects };
}

/** FilterValue → URLSearchParams */
function toQuery(value: FilterValue): URLSearchParams {
  const params = new URLSearchParams();
  if (value.keyword.trim()) params.set(KEYWORD_PARAM, value.keyword.trim());
  Object.entries(value.selects).forEach(([key, values]) => {
    if (values.length > 0) params.set(`${SELECT_PREFIX}${key}`, values.join(','));
  });
  return params;
}

/* -------------------------------- 组件 -------------------------------- */

export function FilterBar({
  value,
  onChange,
  selects,
  placeholder = '按关键字搜索…',
  extra,
  onReset,
}: FilterBarProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const hydratedRef = useRef(false);
  const selectKeys = selects.map((item) => item.key).join(',');

  // 首次挂载：把地址栏里的筛选条件回填到 store，保证刷新/分享链接后筛选依然生效
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const keys = selectKeys ? selectKeys.split(',') : [];
    const fromUrl = parseQuery(searchParams, keys);
    if (JSON.stringify(fromUrl) !== JSON.stringify(value)) {
      onChange(fromUrl);
    }
  }, [onChange, searchParams, selectKeys, value]);

  const commit = (next: FilterValue): void => {
    onChange(next);
    setSearchParams(toQuery(next), { replace: true });
  };

  const setSelect = (key: string, values: string[]): void => {
    commit({ ...value, selects: { ...value.selects, [key]: values } });
  };

  const handleReset = (): void => {
    const next = emptyFilterValue(selects.map((item) => item.key));
    commit(next);
    if (onReset) onReset();
  };

  const activeCount = countActiveFilters(value);

  return (
    <div className="filter-bar">
      <Space wrap size={10} align="center">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={placeholder}
          style={{ width: 240 }}
          value={value.keyword}
          onChange={(event) => commit({ ...value, keyword: event.target.value })}
        />
        {selects.map((item) => (
          <Select
            key={item.key}
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder={item.label}
            style={{ minWidth: item.width ?? 168 }}
            value={pickedSelect(value, item.key)}
            options={item.options}
            onChange={(values: string[]) => setSelect(item.key, values)}
          />
        ))}
        <Tooltip title={activeCount > 0 ? `已启用 ${activeCount} 个筛选条件` : '未启用筛选条件'}>
          <Button icon={<FilterOutlined />} disabled>
            筛选 {activeCount > 0 ? activeCount : ''}
          </Button>
        </Tooltip>
        <Button icon={<ClearOutlined />} onClick={handleReset} disabled={activeCount === 0}>
          重置
        </Button>
      </Space>
      {extra ? <Space wrap size={10}>{extra}</Space> : null}
    </div>
  );
}

export default FilterBar;
