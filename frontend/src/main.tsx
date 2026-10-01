import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './styles/main.css';
import { appRoutes } from './router';

/** 岩茶主题：墨绿 + 茶褐 + 炭金 */
const theme = {
  token: {
    colorPrimary: '#2f5136',
    colorInfo: '#2f5136',
    colorSuccess: '#3f7d3f',
    colorWarning: '#c9963c',
    colorError: '#b0413e',
    colorTextBase: '#2b2a26',
    borderRadius: 8,
    fontFamily:
      '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "PingFang SC", "Microsoft YaHei", serif',
  },
  components: {
    Layout: { headerBg: '#fffdf7', siderBg: '#25361f', bodyBg: '#f5f1e6' },
    Card: { headerBg: '#faf7ee' },
    Table: { headerBg: '#f3efe2' },
  },
};

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载节点');
}

/** 路由由 src/router/index.tsx 提供，App 负责整体布局与外层导航 */
const router = createBrowserRouter(appRoutes);

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
