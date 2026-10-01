/**
 * 路由表：/gardens、/turns、/fixing、/roasting、/reviews、/blending
 * 页面按路由懒加载（构建时自动分包）；`/` 与未知路径统一重定向到第一个模块路径 /gardens。
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Skeleton } from 'antd';
import App from '../App';

const GardenList = lazy(() => import('../pages/GardenList'));
const TurnBoard = lazy(() => import('../pages/TurnBoard'));
const FixRecord = lazy(() => import('../pages/FixRecord'));
const RoastPlan = lazy(() => import('../pages/RoastPlan'));
const ReviewBoard = lazy(() => import('../pages/ReviewBoard'));
const BlendPlan = lazy(() => import('../pages/BlendPlan'));

/** 全部路由路径（逐字固定，禁止改动） */
export const ROUTES = {
  gardens: '/gardens',
  turns: '/turns',
  fixing: '/fixing',
  roasting: '/roasting',
  reviews: '/reviews',
  blending: '/blending',
} as const;

/** 导航标题：App 依据当前路径设置 document.title */
export const ROUTE_META: Record<string, string> = {
  [ROUTES.gardens]: '山场与批次台账',
  [ROUTES.turns]: '做青轮次编排',
  [ROUTES.fixing]: '杀青揉捻记录',
  [ROUTES.roasting]: '焙火曲线与复焙安排',
  [ROUTES.reviews]: '毛茶审评',
  [ROUTES.blending]: '拼配方案登记',
};

/** 侧边导航顺序 */
export const NAV_ORDER: string[] = [
  ROUTES.gardens,
  ROUTES.turns,
  ROUTES.fixing,
  ROUTES.roasting,
  ROUTES.reviews,
  ROUTES.blending,
];

/** 懒加载页面占位 */
function RouteFallback() {
  return <Skeleton active paragraph={{ rows: 6 }} style={{ background: '#fffdf7', padding: 16, borderRadius: 10 }} />;
}

/** 包裹懒加载页面，避免整页被 Suspense 卸载 */
function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.gardens} replace /> },
      { path: 'gardens', element: withSuspense(<GardenList />) },
      { path: 'turns', element: withSuspense(<TurnBoard />) },
      { path: 'fixing', element: withSuspense(<FixRecord />) },
      { path: 'roasting', element: withSuspense(<RoastPlan />) },
      { path: 'reviews', element: withSuspense(<ReviewBoard />) },
      { path: 'blending', element: withSuspense(<BlendPlan />) },
      { path: '*', element: <Navigate to={ROUTES.gardens} replace /> },
    ],
  },
];

export default appRoutes;
