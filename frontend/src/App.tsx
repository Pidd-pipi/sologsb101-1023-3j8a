/**
 * 应用外壳：侧边导航（6 个工序模块）+ 顶部上下文（当前山场 / 批次 / 各表行数）+ 内容区。
 * 负责首次进入时打开 IndexedDB 并播种演示数据，随后加载各 store 的跨页数据。
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Badge, Button, Layout, Menu, Space, Tag, Typography, message } from 'antd';
import {
  AppstoreOutlined,
  ExperimentOutlined,
  FireOutlined,
  GoldOutlined,
  ProfileOutlined,
  StarOutlined,
} from '@ant-design/icons';
import { NAV_ORDER, ROUTES, ROUTE_META } from './router';
import { useGardenStore } from './stores/gardenStore';
import { useBatchStore } from './stores/batchStore';
import { useRoastStore } from './stores/roastStore';
import { initDatabase } from './utils/db';
import { batchLabel } from './utils/tea';

const { Header, Sider, Content, Footer } = Layout;

/** 导航图标：按字面路径索引，避免在模块初始化期读取 router 的导出（消除 App ↔ router 循环依赖） */
const NAV_ICON: Record<string, ReactNode> = {
  '/gardens': <AppstoreOutlined />,
  '/turns': <ExperimentOutlined />,
  '/fixing': <GoldOutlined />,
  '/roasting': <FireOutlined />,
  '/reviews': <StarOutlined />,
  '/blending': <ProfileOutlined />,
};

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();

  const gardens = useGardenStore((state) => state.gardens);
  const counts = useGardenStore((state) => state.counts);
  const currentGardenId = useGardenStore((state) => state.currentGardenId);
  const loadGardens = useGardenStore((state) => state.loadGardens);
  const refreshCounts = useGardenStore((state) => state.refreshCounts);

  const batches = useBatchStore((state) => state.batches);
  const currentBatchId = useBatchStore((state) => state.currentBatchId);
  const loadBatches = useBatchStore((state) => state.loadBatches);
  const loadReviews = useBatchStore((state) => state.loadReviews);

  const loadRoasts = useRoastStore((state) => state.loadRoasts);

  // 首次进入：打开数据库（必要时播种）→ 加载各 store 的跨页数据
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initDatabase();
        if (cancelled) return;
        await Promise.all([loadGardens(), loadBatches(), loadRoasts(), loadReviews()]);
      } catch (error) {
        if (cancelled) return;
        messageApi.error(`本地数据库初始化失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBatches, loadGardens, loadReviews, loadRoasts, messageApi]);

  // 导航标题（每个路由带 meta.title 的等价实现）
  useEffect(() => {
    const title = ROUTE_META[location.pathname] ?? '山场与批次台账';
    document.title = `${title} · 岩茶做青与焙火工序台`;
  }, [location.pathname]);

  const currentGarden = useMemo(
    () => gardens.find((garden) => garden.id === currentGardenId) ?? null,
    [gardens, currentGardenId],
  );
  const currentBatch = useMemo(
    () => batches.find((batch) => batch.id === currentBatchId) ?? null,
    [batches, currentBatchId],
  );

  const selectedKeys = [location.pathname.startsWith('/') ? location.pathname : ROUTES.gardens];

  return (
    <>
      {contextHolder}
      <Layout style={{ minHeight: '100vh' }}>
        <Sider width={236} breakpoint="lg" collapsedWidth={0} className="app-sider">
          <div style={{ padding: '20px 16px 10px' }}>
            <Typography.Title level={5} style={{ color: '#eef5e6', margin: 0 }}>
              岩茶做青与焙火工序台
            </Typography.Title>
            <Typography.Text style={{ color: 'rgba(238,245,230,0.62)', fontSize: 12 }}>
              gbtearock · 初制工艺留档
            </Typography.Text>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={selectedKeys}
            style={{ background: 'transparent' }}
            onClick={({ key }) => navigate(key)}
            items={NAV_ORDER.map((path) => ({
              key: path,
              icon: NAV_ICON[path],
              label: ROUTE_META[path] ?? path,
            }))}
          />
          <div style={{ padding: '14px 16px', color: 'rgba(238,245,230,0.66)', fontSize: 12, lineHeight: 1.9 }}>
            <div>山场 {counts.gardens ?? 0} · 批次 {counts.batches ?? 0}</div>
            <div>轮次 {counts.turns ?? 0} · 杀青 {counts.fixes ?? 0}</div>
            <div>焙火 {counts.roasts ?? 0} · 审评 {counts.reviews ?? 0}</div>
          </div>
        </Sider>

        <Layout>
          <Header className="app-header">
            <Space size={10} wrap>
              <Typography.Text strong>当前山场：</Typography.Text>
              {currentGarden ? (
                <Tag color="#2f5136">
                  {currentGarden.name} · {currentGarden.cultivar} · {currentGarden.altitudeM}m
                </Tag>
              ) : (
                <Tag>未选择</Tag>
              )}
              <Typography.Text strong>当前批次：</Typography.Text>
              {currentBatch ? (
                <Tag color="gold">{batchLabel(currentBatch, currentGarden?.name)}</Tag>
              ) : (
                <Tag>未选择</Tag>
              )}
              <Tag>{ROUTE_META[location.pathname] ?? '山场与批次台账'}</Tag>
            </Space>
            <Space wrap>
              <Badge count={counts.turns ?? 0} showZero color="#52c41a" title="做青轮次总数" />
              <Badge count={counts.roasts ?? 0} showZero color="#fa8c16" title="焙火道次总数" />
              <Badge count={counts.reviews ?? 0} showZero color="#722ed1" title="审评记录总数" />
              <Button size="small" onClick={() => void refreshCounts()}>
                刷新统计
              </Button>
              <Button size="small" type="primary" onClick={() => navigate(ROUTES.gardens)}>
                返回台账
              </Button>
            </Space>
          </Header>

          <Content style={{ padding: 20, minHeight: 320 }}>
            <Outlet />
          </Content>

          <Footer style={{ textAlign: 'center', background: 'transparent', color: 'rgba(0,0,0,0.45)' }}>
            数据仅保存在本机浏览器（IndexedDB · 库名 gbtearock）·
            <Link to={ROUTES.gardens} style={{ marginLeft: 6 }}>
              返回山场台账
            </Link>
          </Footer>
        </Layout>
      </Layout>
    </>
  );
}
