# 岩茶做青与焙火工序台（gbtearock）

面向武夷岩茶初制车间与茶厂的工艺留档工具：按山场批次记录晒青、做青、杀青、揉捻、焙火各道工序的温湿度与时长参数，并组织毛茶审评与拼配。核心动作是「**建山场与茶青批次 → 排做青轮次（摇青与静置交替）→ 录杀青揉捻参数 → 排焙火曲线与复焙安排 → 录审评评分 → 登记拼配方案**」。

纯前端单页应用，**无后端 / 无数据库服务 / 无 API 服务**，所有数据保存在访问者本机浏览器（IndexedDB）里。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先准备环境变量
cp .env.example .env

# 2. 一条命令构建并启动
docker compose up -d --build
```

启动后访问：**http://localhost:22823**

常用命令：

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `docker compose ps` |
| 查看日志 | `docker compose logs -f frontend` |
| 停止服务 | `docker compose down` |
| 改端口后重建 | 编辑 `.env` 中的 `FRONTEND_PORT` 后执行 `docker compose up -d --build` |
| 校验编排文件 | `docker compose config --quiet` |

> 顶层已写 `name: gbtearock` 兜底，即使本项目放在中文目录下，`docker compose config --quiet` 也不会因为项目名为空而报错。
> 端口覆盖：`.env` 里的 `FRONTEND_PORT` 是「宿主端口 → 容器 80」的左侧值，默认 `22823`。

---

## 二、项目简介

| 路由 | 模块 | 说明 |
| --- | --- | --- |
| `/gardens` | 山场与茶青批次台账 | 建山场（品种 / 土壤 / 海拔 / 朝向），卡片回显批次数、鲜叶合计与审评均分；登记批次并推进工序状态；整库 JSON 导出 / 导入 |
| `/turns` | 做青轮次编排 | 摇青 / 静置交替时间线与累计时长、失水率走势；**HTML5 原生拖拽排序**写回 `roundNo`；复制上一轮参数后微调、参数模板存 / 套用 |
| `/fixing` | 杀青揉捻记录 | 锅温、杀青时长、揉捻压力与时长、操作人登记；登记后自动把批次回写为「已杀青」 |
| `/roasting` | 焙火曲线与复焙安排 | 多道次按序排列（上移 / 下移写回 `passNo`）、足火判定（轻火 / 中火 / 足火）、复焙提醒（逾期 / 今日 / 7 日内 / 已排期） |
| `/dispatch` | 工位调度台 | 揉捻机 + 焙火炉**原子占用**（不占一半）、容量不足按提交先后 FIFO 排队（队头阻塞不插队）、30 秒租约 + 心跳 + 超时自动释放、页面关闭释放保留原队位、保存失败可重试、占用未确认时工序闸门拦截 |
| `/reviews` | 毛茶审评 | 香气 30% / 汤色 20% / 滋味 35% / 叶底 15% 加权换算总分，按总分排序并生成拼配候选清单 |
| `/blending` | 拼配方案登记与结构版本导出 | 按总分组合批次与占比、**占比校验（合计必须 100%）**、方案 JSON 与整库结构版本 JSON 导出 |

批次工序状态按工序自动流转：**做青中 → 已杀青 → 已焙火 → 已审评**（只向后推进，不回退）。

---

## 三、技术栈

| 分类 | 选型 | 版本 |
| --- | --- | --- |
| 框架 | React | 18.3 |
| 语言 | TypeScript（`strict` + `noUnusedLocals/Parameters`） | 5.6 |
| UI 组件 | Ant Design（`@ant-design/icons`） | 5.22 |
| 构建 | Vite | 5.4 |
| 状态管理 | Zustand | 4.5 |
| 路由 | React Router（`createBrowserRouter`） | 6.28 |
| 本地数据库 | Dexie（IndexedDB 封装，含结构版本号与升级迁移） | 4.0 |
| 日期处理 | dayjs | 1.11 |
| 容器 | 多阶段构建：`node:20-alpine` → `nginx:alpine` | — |

---

## 四、本地开发

```bash
cd frontend
npm install
npm run dev       # http://localhost:22823
npm run build     # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview   # 预览 dist 产物，http://localhost:22823
npm test          # 调度不变量（49 项事务用例）+ 组件冒烟（jsdom）两套验证
```

测试脚本（纯 Node，无需浏览器）：

| 命令 | 内容 |
| --- | --- |
| `npm run test:dispatch` | fake-indexeddb 下验证调度事务：原子双工位占用、FIFO / 队头阻塞、失败保位、租约超时、页面关闭释放、多窗口会话隔离、工序闸门 |
| `npm run test:smoke` | jsdom 挂载调度台 / 占用弹窗 / 名次徽标，跑通「提交 → 占用 → 确认落库」并校验三处同源展示 |

---

## 五、目录结构

```
sologsb101-1023/
├── README.md                       # 本文档
├── docker-compose.yml              # 不写 version 字段；顶层 name: gbtearock
├── .env / .env.example             # COMPOSE_PROJECT_NAME / FRONTEND_PORT（内容一致）
├── .gitignore
├── sologsb101-1023.md              # 提示词原文（只读）
└── frontend/
    ├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip + /assets/ 长缓存
    ├── .dockerignore
    ├── package.json / package-lock.json
    ├── tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx                # 入口：ConfigProvider(zhCN) + AntdApp + RouterProvider
        ├── App.tsx                 # 外壳：侧边导航、当前山场/批次、行数统计、首次初始化 + 播种
        ├── vite-env.d.ts
        ├── styles/main.css         # 墨绿/茶褐/炭金主题与拖拽、时间线样式
        ├── types/                  # 实体类型
        │   ├── garden.ts           # 山场：name / altitudeM / soil / cultivar / aspect
        │   ├── batch.ts            # 茶青批次：gardenId / pickedAt / freshLeafKg / tenderness / weather / state
        │   ├── turn.ts             # 做青轮次：batchId / roundNo / shakeMin / restMin / roomTempC / humidityPct / waterLossPct
        │   ├── fix.ts              # 杀青揉捻：batchId / wokTempC / fixMin / rollPressure / rollMin / operator
        │   ├── roast.ts            # 焙火：batchId / passNo / tempC / hours / charcoal / nextRoastDate / state
        │   ├── review.ts           # 审评：batchId / reviewedAt / aroma / liquorColor / taste / leafBase / totalScore / blendNote
        │   └── dispatch.ts         # 工位调度：Workstation（揉捻机/焙火炉）+ DispatchOrder（状态机/租约/异常原因）
        ├── stores/                 # Zustand：跨页状态全部放这里
        │   ├── gardenStore.ts      # 山场列表、派生指标、当前选中山场、筛选条件
        │   ├── batchStore.ts       # 批次与工序流转（推进前查占用闸门）、杀青/审评/拼配筛选、拼配方案草稿
        │   ├── turnStore.ts        # 当前批次轮次、参数模板、拖拽重排（写回 roundNo）
        │   ├── roastStore.ts       # 焙火道次顺序、复焙提醒、足火判定（推进前查占用闸门）
        │   └── dispatchStore.ts    # 工位/调度单 liveQuery、心跳续租、超时清扫、pagehide 释放、全局占用弹窗
        ├── components/common/      # 共享组件
        │   ├── GradeTag.tsx        # 嫩度 / 火功 / 评分 / 工序状态 / 焙火状态 / 揉捻压力标签
        │   ├── DispatchBadge.tsx   # 调度名次 / 占用工位 / 异常原因徽标（台账、杀青、焙火三处同源）
        │   ├── RunDispatchDialog.tsx # 全局占用执行弹窗：提交→排队→占用(倒计时)→确认 / 失败重试
        │   ├── FilterBar.tsx       # 关键字 + 多个下拉多选，并同步 URL query
        │   ├── StatBadge.tsx       # 统计徽标（累计时长、失水率、均分、热负荷…）
        │   └── EmptyPanel.tsx      # 空数据引导 + 主/次操作按钮
        ├── hooks/
        │   ├── useTurnTimeline.ts  # 轮次累计摇青/静置时长、交替时间线段、失水率走势
        │   └── useIdbTable.ts      # Dexie 表响应式订阅 + 增删改查封装
        ├── utils/
        │   ├── tea.ts              # 嫩度/火功枚举映射、温湿度与失水率区间判定、评分加权换算、拼配候选
        │   ├── scheduler.ts        # 调度核心：跨表事务原子占用、FIFO 队头阻塞、租约/心跳/清扫/释放/重试、跨窗口广播
        │   ├── dispatchViews.ts    # 名次/占用/容量派生视图 + 未确认占用工序闸门（三处展示同源）
        │   ├── db.ts               # Dexie 实例、八张表、version(1)~(3) 迁移、播种、快照导入导出
        │   └── export.ts           # 批次工艺记录 / 整库存档 / 拼配方案 JSON 导出与校验
        ├── pages/                  # 七个页面，与路由一一对应
        │   ├── GardenList.tsx      # /gardens
        │   ├── TurnBoard.tsx       # /turns
        │   ├── FixRecord.tsx       # /fixing（新登记走占用弹窗）
        │   ├── RoastPlan.tsx       # /roasting（新道次走占用弹窗）
        │   ├── DispatchBoard.tsx   # /dispatch 工位调度台
        │   ├── ReviewBoard.tsx     # /reviews
        │   └── BlendPlan.tsx       # /blending
        └── router/index.tsx        # 路由表：/ 与未知路径重定向到 /gardens，页面懒加载
```

---

## 六、IndexedDB 库名与数据存储说明

- **库名**：`gbtearock`（`src/utils/db.ts` 中的 `DB_NAME`）
- **结构版本号**：`DB_VERSION = 3`
  - `version(1)` 初版结构：六张分表的最小索引
  - `version(2).stores(...)` 补齐外键 / 状态 / 日期索引，并 `.upgrade()` **真实迁移历史数据**：补齐 `createdAt` / `updatedAt`、山场补齐朝向与土壤品种兜底值、批次工序状态归一化、轮次与焙火数值截断到合法区间、审评总分由「四项简单平均」改为「分项加权换算」后重算。
  - `version(3).stores(...)` 纯新增两张工位调度表 `workstations` / `dispatchOrders`（既有六表无需改动数据）；v2 旧库打开即自动升级，旧批次没有调度单时各处统一显示「未排队」。
- **分表**：`gardens`、`batches`、`turns`、`fixes`、`roasts`、`reviews`、`workstations`、`dispatchOrders`（每条业务记录都有 `id` / `createdAt` / `updatedAt`）
- **工位调度模型**：
  - `workstations` 固定播种 **2 台揉捻机 + 2 座焙火炉**（同一时刻最多放行 2 个任务，第 3 个起排队），可在调度台停用 / 启用。
  - `dispatchOrders` 状态机：`QUEUED 排队 → HELD 占用中 → CONFIRMED 已确认`，旁路 `FAILED 保存失败`（同队位可重试）/ `CANCELLED 已取消`。
  - 每个任务**必须在同一个 IndexedDB 跨表事务里同时拿到 1 台揉捻机 + 1 座焙火炉**才进入 HELD，容量任一类不足即按单调 `seq`（提交先后）排队；队头不满足时后续一律等待（**队头阻塞，不占一半、不许插队**）。
  - **租约**：HELD 带 30 秒 `leaseExpiresAt`，本窗口 10 秒心跳续租；页面关闭触发 `pagehide` 立即释放，其他窗口 5 秒清扫兜底把僵死占用超时释放——都回到无主 QUEUED 并**保留原 seq（原队位）**，在调度台「重试」即可重新认领。
  - **多窗口**：同浏览器多标签共享同一 IndexedDB，配合 `BroadcastChannel` 跨窗口即时重算；提交会话只认领自己排队中的单子，不代领他窗 / 无主单。
  - **工序闸门**：存在未确认 HELD 时，批次状态推进、焙火道次推进、编辑表单向后改状态都被拒绝；业务记录落库与「HELD → CONFIRMED 释放工位」在同一事务内，失败整体回滚。
  - 山场台账、杀青揉捻记录、焙火安排、调度台共用 `dispatchViews.ts` 的同一组纯函数渲染**名次、占用工位与异常原因**。
- **首屏自动播种**：`initDatabase()` 中 `if ((await db.gardens.count()) === 0) { await seedDatabase() }`，播种 3 层互相引用的演示数据 —— 3 个山场 → 4 个茶青批次 → 每个批次下 2-3 条做青轮次、1 条杀青揉捻、1-2 道焙火、1 条审评，父→子→孙贯通；另播 4 个固定工位。播种使用固定 id + `bulkPut`，**幂等**，重复执行不会产生重复行。
- **级联删除**：删除山场会级联删除其批次与批次下的轮次 / 杀青 / 焙火 / 审评 / 调度单；删除批次会级联删除其全部工序子表（均使用 `db.transaction`）。
- **导出 / 导入**：山场页支持「导出整库 JSON / 导入 JSON」（Blob + `URL.createObjectURL` + `a.download`，导入前做结构与库名校验，校验失败弹错误提示）；拼配页支持拼配方案 JSON 与整库结构版本 JSON 导出。
- **无命名卷、无数据库服务**：容器只托管静态文件，数据完全存在浏览器本地，换浏览器或清空站点数据即清空。

---

## 七、常见问题

1. **端口被占用**：修改 `.env` 中的 `FRONTEND_PORT`（例如 `FRONTEND_PORT=22824`）后 `docker compose up -d --build`。
2. **刷新子路由 404**：已由 `nginx.conf` 的 `try_files $uri $uri/ /index.html;` 处理，`/gardens`、`/turns` 等路径可直接刷新。
3. **favicon 403**：`public/favicon.svg` 在宿主机上是 `0600` 权限，`COPY` 会保留权限位导致 nginx worker（uid=101）读不到；`Dockerfile` 在 `COPY --from=builder /app/dist` 之后紧跟 `RUN chmod -R a+rX /usr/share/nginx/html` 归一化权限，避免 403。
4. **数据只在本浏览器**：演示数据首次打开自动生成；想恢复初始状态可在浏览器 DevTools → Application → IndexedDB 删除 `gbtearock`，或重新导入一份整库存档。
5. **修改结构版本**：调整实体字段后请把 `DB_VERSION` 加一并补充 `.upgrade()` 迁移逻辑，否则老浏览器里的历史数据不会被修正。
6. **工位一直被锁**：占用确认窗口为 30 秒，正常确认或关闭页面会立即释放；若标签页被直接杀掉，其他窗口 5 秒内会清扫超时占用，单子回到原队位，在 `/dispatch` 点「重试占用」即可，不需要清库。
7. **改了工位数量 / 容量**：在 `/dispatch` 工位卡上「停用 / 启用」即可即时重算队列（默认 2 揉捻机 + 2 焙火炉）；`clearAllTables()` 清业务数据时保留工位、只清调度单。
