/**
 * 山场（Garden）：武夷岩茶的山场地块档案
 * 一个山场可以挂多个茶青批次，卡片上回显当年批次与审评均分。
 */

/** 土壤类型枚举：砾壤 / 红壤 / 沙壤 */
export const SOIL_OPTIONS = ['砾壤', '红壤', '沙壤'] as const;
export type Soil = (typeof SOIL_OPTIONS)[number];

/** 茶树品种枚举：水仙 / 肉桂 / 名丛 */
export const CULTIVAR_OPTIONS = ['水仙', '肉桂', '名丛'] as const;
export type Cultivar = (typeof CULTIVAR_OPTIONS)[number];

/** 山场海拔分段，用于列表筛选与回显 */
export interface AltitudeBand {
  key: string;
  label: string;
  minM: number;
  maxM: number;
}

export const ALTITUDE_BANDS: AltitudeBand[] = [
  { key: 'low', label: '低山（<300m）', minM: 0, maxM: 299 },
  { key: 'mid', label: '半岩（300-599m）', minM: 300, maxM: 599 },
  { key: 'high', label: '高山（≥600m）', minM: 600, maxM: 9999 },
];

/** 山场实体（持久化到 IndexedDB 的 gardens 表） */
export interface Garden {
  id: string;
  /** 山场名，例如「牛栏坑」「慧苑坑」 */
  name: string;
  /** 海拔（米） */
  altitudeM: number;
  /** 土壤：砾壤 / 红壤 / 沙壤 */
  soil: Soil;
  /** 主栽品种：水仙 / 肉桂 / 名丛 */
  cultivar: Cultivar;
  /** 朝向，例如「东南向」「北向」 */
  aspect: string;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 编辑山场表单草稿（不含系统字段） */
export interface GardenDraft {
  name: string;
  altitudeM: number;
  soil: Soil;
  cultivar: Cultivar;
  aspect: string;
}

/** 山场列表派生指标：当年批次数量与审评均分 */
export interface GardenMetrics {
  gardenId: string;
  batchCount: number;
  freshLeafKg: number;
  averageScore: number | null;
  latestPickedAt: string | null;
}
