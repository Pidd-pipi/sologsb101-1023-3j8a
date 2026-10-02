/**
 * 组件层冒烟测试（jsdom + fake-indexeddb）：
 * 挂载 RunDispatchDialog / DispatchBoard / DispatchBadge，跑一轮提交→占用→确认，
 * 确保渲染期无异常、弹窗队列 / 占用文案与工位释放都正确。
 */
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.DOMRect = dom.window.DOMRect ?? class DOMRect {
  x = 0; y = 0; width = 0; height = 0; top = 0; right = 0; bottom = 0; left = 0;
  static fromRect() { return new DOMRect(); }
};
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IntersectionObserver = class IntersectionObserver {
  root = null;
  rootMargin = '';
  thresholds = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
};
globalThis.getComputedStyle = dom.window.getComputedStyle;
// 把 jsdom window 上浏览器有、Node 没有的构造器批量挂到 globalThis
// （Ant Design 的 rc-* 组件会引用 ShadowRoot / getSelection / scrollTo 等）
for (const key of [
  'ShadowRoot', 'DocumentFragment', 'NodeList', 'Node', 'Range', 'Selection',
  'CSSStyleDeclaration', 'CSSStyleSheet', 'StyleSheet', 'HTMLAnchorElement',
  'HTMLButtonElement', 'HTMLFormElement', 'HTMLOptionElement', 'Text',
  'DOMPoint', 'DOMRectReadOnly', 'Document', 'Window', 'FileReader', 'Blob',
  'File', 'FormData', 'Headers', 'Request', 'Response', 'URL',
] as const) {
  const value = (dom.window as unknown as Record<string, unknown>)[key];
  if (value !== undefined && (globalThis as Record<string, unknown>)[key] === undefined) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}
dom.window.getSelection =
  dom.window.getSelection ??
  (() => ({
    removeAllRanges() {},
    addRange() {},
    getRangeAt: () => null,
    toString: () => '',
  }));
globalThis.getSelection = dom.window.getSelection.bind(dom.window) as unknown as typeof globalThis.getSelection;
globalThis.scrollTo = (() => undefined) as unknown as typeof globalThis.scrollTo;
dom.window.scrollTo = globalThis.scrollTo as unknown as typeof window.scrollTo;
dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
dom.window.HTMLElement.prototype.releasePointerCapture = () => undefined;
dom.window.HTMLElement.prototype.setPointerCapture = () => undefined;
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
globalThis.matchMedia =
  globalThis.matchMedia ||
  (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
dom.window.matchMedia = globalThis.matchMedia as unknown as typeof window.matchMedia;

const React = (await import('react')).default;
// 告知 React 当前处于 act 测试环境（消除 act 警告、保证副作用同步刷新）
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { ConfigProvider, App: AntdApp } = await import('antd');
const zhCN = (await import('antd/locale/zh_CN')).default;

const { db, initDatabase } = await import('./src/utils/db');
const { useDispatchStore } = await import('./src/stores/dispatchStore');
const { useGardenStore } = await import('./src/stores/gardenStore');
const { useBatchStore } = await import('./src/stores/batchStore');
const RunDispatchDialog = (await import('./src/components/common/RunDispatchDialog')).default;
const DispatchBoard = (await import('./src/pages/DispatchBoard')).default;
const { batchDispatchSummary } = await import('./src/utils/dispatchViews');
const DispatchBadge = (await import('./src/components/common/DispatchBadge')).default;
const { tickScheduler } = await import('./src/utils/scheduler');

let failures = 0;
function expect(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`✗ ${name}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

await initDatabase();

function flush(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ConfigProvider, { locale: zhCN }, React.createElement(AntdApp, null, node)));
  });
  return {
    container,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

// ---------- 1. DispatchBadge 渲染：未排队 / 排队 / 占用 / 失败 ----------
{
  const orders = await db.dispatchOrders.toArray();
  const workstations = await db.workstations.toArray();
  const batches = await db.batches.toArray();
  const summaryEmpty = batchDispatchSummary(batches[0].id, orders, workstations);
  const node1 = mount(React.createElement(DispatchBadge, { summary: summaryEmpty }));
  expect('旧批次无调度单显示「未排队」', node1.container.textContent?.includes('未排队') ?? false);
  node1.unmount();
}

// ---------- 2. DispatchBoard 挂载：4 个工位卡、提交表单渲染 ----------
{
  useDispatchStore.getState().initRuntime();
  await useGardenStore.getState().loadGardens();
  await useBatchStore.getState().loadBatches();
  const board = mount(React.createElement(DispatchBoard));
  await act(async () => {
    await flush(250);
  });
  const text = board.container.textContent ?? '';
  const bodyText = document.body.textContent ?? '';
  expect('调度台标题渲染', text.includes('工位调度台') || bodyText.includes('工位调度台'));
  expect('渲染 2 台揉捻机', bodyText.includes('揉捻机 R1') && bodyText.includes('揉捻机 R2'));
  expect('渲染 2 座焙火炉', bodyText.includes('焙火炉 O1') && bodyText.includes('焙火炉 O2'));
  expect('空闲状态可见', bodyText.includes('空闲'));
  board.unmount();
}

// ---------- 3. RunDispatchDialog：提交→HELD→确认 全流程（含业务落库） ----------
{
  const batches = await db.batches.toArray();
  const target = batches.find((b) => b.state === '做青中') ?? batches[0];
  let completed: string | null = null;
  const { unmount, container } = mount(React.createElement(RunDispatchDialog));
  await act(async () => {
    useDispatchStore.getState().openRun({
      batchId: target.id,
      task: 'FIX',
      note: '冒烟杀青',
      payload: {
        kind: 'FIX',
        draft: {
          batchId: target.id,
          wokTempC: 180,
          fixMin: 6,
          rollPressure: '中',
          rollMin: 10,
          operator: '冒烟工',
        },
      },
      onComplete: () => {
        completed = target.id;
      },
    });
    await flush(300);
  });
  // liveQuery 首次推送需要额外一拍（fake-indexeddb）
  await act(async () => {
    await useDispatchStore.getState().refresh();
    await flush(100);
  });

  const txt1 = (container.textContent ?? '') + (document.body.textContent ?? '');
  expect('弹窗提交后出现占用 / 排队文案', txt1.includes('占用') || txt1.includes('排队'));

  // 找到刚提交的调度单
  let orders = await db.dispatchOrders.toArray();
  let mine = orders.filter((o) => o.batchId === target.id).sort((a, b) => b.seq - a.seq)[0];
  expect('调度单已写入 IndexedDB', Boolean(mine));

  if (mine.state === 'QUEUED') {
    // 容量满则等待，直接在数据层确认不会自动越序；这里把其他 HELD 取消以推进
    await act(async () => {
      await flush(50);
    });
    orders = await db.dispatchOrders.toArray();
    mine = orders.find((o) => o.id === mine!.id)!;
  }

  expect('有容量时提交即 HELD（两类工位同时拿到）', mine.state === 'HELD' && mine.heldWorkstationIds.length === 2);
  expect('弹窗显示占用工位', txt1.includes('揉捻机') && txt1.includes('焙火炉'));
  expect('弹窗显示租约倒计时', /确认时间\s*\d+\s*秒/.test(txt1));
  if (!/确认时间\s*\d+\s*秒/.test(txt1)) {
  }

  // 点「确认并保存」（AntD Modal 通过 portal 挂到 document.body，全局查找）
  const buttons = Array.from(document.body.querySelectorAll('button'));
  const confirmBtn = buttons.find((b) => (b.textContent ?? '').includes('确认并保存')) as HTMLButtonElement | undefined;
  expect('确认按钮存在', Boolean(confirmBtn));
  if (confirmBtn) {
  }
  await act(async () => {
    if (confirmBtn && !confirmBtn.disabled) {
      confirmBtn.click();
    }
    await flush(200);
  });
  await tickScheduler();

  orders = await db.dispatchOrders.toArray();
  mine = orders.find((o) => o.id === mine!.id)!;
  expect('确认后调度单 CONFIRMED', mine.state === 'CONFIRMED');
  // CONFIRMED 后工位可被后续单使用：容量占用只统计 HELD；heldWorkstationIds 保留作留档
  const { heldOrders } = await import('./src/utils/dispatchViews');
  expect('确认后不再占用容量（HELD 列表为空）', heldOrders(orders).length === 0);
  expect('业务记录 fix 已落库', Boolean(await db.fixes.get(mine.recordId)));
  expect('完成回调被调用', completed === target.id);
  expect('弹窗已关闭', useDispatchStore.getState().pendingRun === null);
  unmount();
}

// ---------- 4. 无调度单的批次徽标在列表里仍是「未排队」 ----------
{
  const batches = await db.batches.toArray();
  const orders = await db.dispatchOrders.toArray();
  const workstations = await db.workstations.toArray();
  const noOrderBatch = batches.find((b) => !orders.some((o) => o.batchId === b.id && ['QUEUED', 'HELD', 'FAILED'].includes(o.state)));
  if (noOrderBatch) {
    const s = batchDispatchSummary(noOrderBatch.id, orders, workstations);
    const n = mount(React.createElement(DispatchBadge, { summary: s }));
    expect('旧批次无活跃调度单仍按未排队显示', n.container.textContent?.includes('未排队') ?? false);
    n.unmount();
  }
}

console.log(failures === 0 ? '\n组件冒烟测试全部通过 ✅' : `\n有 ${failures} 个冒烟失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
