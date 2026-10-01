/**
 * 审评（Review）：毛茶分项打分与拼配去向
 * 香气 / 汤色 / 滋味 / 叶底四项打分，加权换算总分。
 */

/** 分项打分维度键 */
export type ReviewScoreKey = 'aroma' | 'liquorColor' | 'taste' | 'leafBase';

/** 单项满分与总分满值 */
export const REVIEW_SCORE_MAX = 100;
export const REVIEW_TOTAL_MAX = 100;

/** 分项权重（香气 30% / 汤色 20% / 滋味 35% / 叶底 15%） */
export const REVIEW_WEIGHTS: Record<ReviewScoreKey, number> = {
  aroma: 0.3,
  liquorColor: 0.2,
  taste: 0.35,
  leafBase: 0.15,
};

/** 分项中文名 */
export const REVIEW_SCORE_LABEL: Record<ReviewScoreKey, string> = {
  aroma: '香气',
  liquorColor: '汤色',
  taste: '滋味',
  leafBase: '叶底',
};

/** 总分达到该值即进入拼配候选清单 */
export const BLEND_CANDIDATE_SCORE = 85;

/** 审评实体（持久化到 IndexedDB 的 reviews 表） */
export interface Review {
  id: string;
  /** 所属批次 id（batchId 外键） */
  batchId: string;
  /** 审评日期 YYYY-MM-DD */
  reviewedAt: string;
  /** 香气得分 */
  aroma: number;
  /** 汤色得分 */
  liquorColor: number;
  /** 滋味得分 */
  taste: number;
  /** 叶底得分 */
  leafBase: number;
  /** 加权总分 */
  totalScore: number;
  /** 拼配去向，例如「拼配方案 A · 40%」 */
  blendNote: string;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 编辑审评表单草稿（总分由分项换算，不接受手工录入） */
export interface ReviewDraft {
  batchId: string;
  reviewedAt: string;
  aroma: number;
  liquorColor: number;
  taste: number;
  leafBase: number;
  blendNote: string;
}

/** 拼配候选项：按总分排序后的审评 + 批次信息 */
export interface BlendCandidate {
  reviewId: string;
  batchId: string;
  batchLabel: string;
  gardenId: string;
  gardenName: string;
  cultivar: string;
  totalScore: number;
  state: string;
  pickedAt: string;
}
