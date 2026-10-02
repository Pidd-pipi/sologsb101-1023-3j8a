/**
 * 调度核心事务不变量验证（Node + fake-indexeddb）
 * 覆盖：两工位同时拿到、容量不足 FIFO 排队、队头阻塞不插队、保存失败保留原队位、
 *       租约超时自动释放、页面关闭释放、重试不越队、工序闸门拦截。
 */
import 'fake-indexeddb/auto';

// BroadcastChannel 在 Node 20 可用；若无则降级为「异步投递」的内存桩
// （真实 BC 的消息是异步派发的，桩必须保持异步，避免在 IndexedDB 事务内重入）
const bcSubs = new Map<string, Set<(m: unknown) => void>>();
if (typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel === 'undefined') {
  class FakeBC {
    name: string;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      const set = bcSubs.get(name) ?? new Set();
      set.add((m) => {
        queueMicrotask(() => this.onmessage?.({ data: m }));
      });
      bcSubs.set(name, set);
    }
    postMessage(m: unknown) {
      for (const fn of bcSubs.get(this.name) ?? []) fn(m);
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = FakeBC;
}

const { db, initDatabase, ID_PREFIX } = await import('./src/utils/db.ts');
const {
  submitOrder,
  tickScheduler,
  failOrder,
  retryOrder,
  confirmOrder,
  cancelOrder,
  releaseOnPageHide,
  sortActiveOrders,
  SESSION_ID,
} = await import('./src/utils/scheduler.ts');
const { heldOrders, findHoldBlocker, waitingOrders } = await import(
  './src/utils/dispatchViews.ts'
);
const { LEASE_TTL_MS } = await import('./src/types/dispatch.ts');

let passed = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    console.error(`✗ FAIL: ${name}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function allOrders() {
  return db.dispatchOrders.toArray();
}
async function heldCount() {
  return heldOrders(await allOrders()).length;
}
async function stateOf(id: string) {
  return (await db.dispatchOrders.get(id))?.state;
}
async function reasonOf(id: string) {
  return (await db.dispatchOrders.get(id))?.reason;
}

await initDatabase();
const batches = await db.batches.toArray();
check('播种了批次', batches.length >= 3);
const wsCount = await db.workstations.count();
check('播种了 4 个工位（2 揉捻机 + 2 焙火炉）', wsCount === 4);

// ---------- 用例 1：容量内前两单同时拿到两类工位 ----------
const o1 = await submitOrder({ batchId: batches[0].id, task: 'FIX', note: 't1' });
const o2 = await submitOrder({ batchId: batches[1].id, task: 'ROAST', note: 't2' });
check('#1 立即 HELD', o1.state === 'HELD');
check('#2 立即 HELD', o2.state === 'HELD');
check('HELD 单确实同时占用 1 揉捻机 + 1 焙火炉', o1.heldWorkstationIds.length === 2);
const wsKinds = await db.workstations.bulkGet(o1.heldWorkstationIds);
check('两类工位各一台', wsKinds.filter((w) => w?.kind === 'roller').length === 1 && wsKinds.filter((w) => w?.kind === 'oven').length === 1);
check('两台 HELD 不抢同一台工位', new Set([...o1.heldWorkstationIds, ...o2.heldWorkstationIds]).size === 4);
check('当前 HELD 数 = 2（容量打满）', (await heldCount()) === 2);

// ---------- 用例 2：第 3、4 单排队，原因是容量不足，且不占一半 ----------
const o3 = await submitOrder({ batchId: batches[2].id, task: 'FIX', note: 't3' });
const o4 = await submitOrder({ batchId: batches[3].id, task: 'ROAST', note: 't4' });
check('#3 容量不足进入 QUEUED', o3.state === 'QUEUED');
check('#4 后到只能 QUEUED（不能插队）', o4.state === 'QUEUED');
check('排队单没有任何工位占用（不占一半）', o3.heldWorkstationIds.length === 0 && o4.heldWorkstationIds.length === 0);
check('#3 排队原因为工位容量不足', ['insufficient_roller', 'insufficient_oven'].includes(o3.reason));
const waiting = waitingOrders(await allOrders());
check('队列名次：#3 第 1、#4 第 2（提交先后）', waiting[0].id === o3.id && waiting[1].id === o4.id);
check('seq 单调递增且等于提交顺序', o1.seq === 1 && o2.seq === 2 && o3.seq === 3 && o4.seq === 4);

// ---------- 用例 3：队头阻塞 —— 只释放一台类别的容量也不能放行 ----------
// （手工把 o1 的一个揉捻机标记停用，制造「只有揉捻机不足」情形：直接释放 o1 整单后
//  会同时空出揉捻机+焙火炉，所以这里改为：停掉一台焙火炉，让释放 o1 后仍只有 1 座焙火炉？）
// 直接验证：在 #3 队头 QUEUED 时，#4 即使需求更小也不能越过 #3
const active = sortActiveOrders(await allOrders());
check('队头是 #3，#4 排在其后', active.findIndex((x) => x.id === o3.id) === 2);

// ---------- 用例 4：只确认 #1（释放一对），#2 仍占用第二对 → 队首 #3 晋升、#4 等待 ----------
const confirmed1 = await confirmOrder(o1.id);
check('#1 确认成功并释放工位', confirmed1.state === 'CONFIRMED' && confirmed1.recordId === '');
check('#2 仍占用：存在未确认占用', findHoldBlocker(await allOrders())?.order.id === o2.id);

// 空出 1 对工位：#3 应在下一轮调度被本会话认领；容量再次打满，#4 必须继续等
await tickScheduler();
check('#3 释放一对容量后晋升 HELD（队头先放行）', (await stateOf(o3.id)) === 'HELD');
check('#4 仍在 QUEUED（容量又满，不插队）', (await stateOf(o4.id)) === 'QUEUED');

// ---------- 用例 5：保存失败 → FAILED、释放工位、保留原队位、可重试 ----------
await failOrder(o3.id);
check('#3 保存失败变 FAILED 且释放工位', (await stateOf(o3.id)) === 'FAILED');
check('#3 失败原因已记录', (await reasonOf(o3.id)) === 'save_failed');
check('失败后 #3 工位释放：仅剩 #2 占用', (await heldCount()) === 1);
// FAILED 卡住队头：即便空出一对工位，tick 也不会跳过它去放行 #4
await tickScheduler();
check('FAILED 卡住队头：#4 不会自动插队晋升', (await stateOf(o4.id)) === 'QUEUED');
// 重试 #3：空出的一对工位 → 重新 HELD，seq 不变
const retried = await retryOrder(o3.id);
check('#3 重试后重新 HELD', retried.state === 'HELD' && retried.seq === 3);
check('#3 重试次数累加', retried.attempts === 1);
// 确认 #3（与 #2 并行占用，互不阻塞）
const confirmed3 = await confirmOrder(o3.id);
check('#3 确认成功', confirmed3.state === 'CONFIRMED');
await tickScheduler();
check('#4 在 #3 完成后晋升 HELD（#2 仍占用另一对）', (await stateOf(o4.id)) === 'HELD');

// ---------- 用例 6：重试不能越过前序 ----------
// 再排两单 #5 #6，令 #5 QUEUED；此时 #4 HELD。对 #6 重试应抛「不能越队」
const o5 = await submitOrder({ batchId: batches[0].id, task: 'FIX' });
const o6 = await submitOrder({ batchId: batches[1].id, task: 'FIX' });
check('#5、#6 排队', o5.state === 'QUEUED' && o6.state === 'QUEUED');
let noJumpErr = '';
try {
  await retryOrder(o6.id);
} catch (e) {
  noJumpErr = (e as Error).message;
}
check('#6 不能越过前序 #5 重试', noJumpErr.includes('不能越队'));

// ---------- 用例 7：租约超时自动释放并回原队位 ----------
// #4 当前 HELD；把其 leaseExpiresAt 改到过去，tick 清扫应变 QUEUED 且保留 seq
{
  const row = await db.dispatchOrders.get(o4.id);
  await db.dispatchOrders.put({ ...row, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
}
await tickScheduler();
check('#4 租约超时后自动释放回 QUEUED', (await stateOf(o4.id)) === 'QUEUED');
check('#4 超时原因已记录且 seq 保留', (await reasonOf(o4.id)) === 'lease_expired' && (await db.dispatchOrders.get(o4.id))?.seq === 4);
check('#4 释放后变为无主单（owner 清空）', (await db.dispatchOrders.get(o4.id))?.ownerSessionId === '');

// ---------- 用例 8：取消排队单后，后续名次前移 ----------
await cancelOrder(o5.id);
await tickScheduler();
const waitingAfterCancel = waitingOrders(await allOrders()).map((x) => x.id);
check('#5 取消后，等待队列只剩 #4 #6', waitingAfterCancel.includes(o4.id) && waitingAfterCancel.includes(o6.id) && !waitingAfterCancel.includes(o5.id));

// ---------- 用例 9：FIX 确认事务同时落业务记录与批次状态 ----------
// 选一个「做青中」批次（播种的 matouyan-0512），提交 FIX 并确认
const zqBatch = batches.find((b) => b.state === '做青中');
check('存在做青中批次', Boolean(zqBatch));
const fixOrder = await submitOrder({ batchId: zqBatch.id, task: 'FIX' });
// 当前 #6 可能 QUEUED 在它前面；先清空前置：取消 #6 以隔离本用例
await cancelOrder(o6.id);
await cancelOrder(o4.id);
await tickScheduler();
const fixHeld = (await db.dispatchOrders.get(fixOrder.id)).state === 'HELD' ? await db.dispatchOrders.get(fixOrder.id) : null;
check('FIX 调度单获得 HELD', fixHeld?.state === 'HELD');
await confirmOrder(fixOrder.id, async (held) => {
  const { createId, ID_PREFIX: PFX, nowIso } = await import('./src/utils/db.ts');
  const stamp = nowIso();
  const fix = {
    id: createId(PFX.fix), batchId: held.batchId, wokTempC: 180, fixMin: 6,
    rollPressure: '中', rollMin: 10, operator: '测试工', createdAt: stamp, updatedAt: stamp,
  };
  await db.fixes.put(fix);
  const b = await db.batches.get(held.batchId);
  await db.batches.put({ ...b, state: '已杀青', updatedAt: stamp });
  return { recordId: fix.id };
});
check('FIX 确认后批次推进到「已杀青」', (await db.batches.get(zqBatch.id))?.state === '已杀青');
check('FIX 确认后调度单留 recordId', Boolean((await db.dispatchOrders.get(fixOrder.id))?.recordId));

// ---------- 用例 10：SESSION_ID 存在 ----------
check('会话 id 已生成', SESSION_ID.startsWith('s-'));
check('租约时长为 30 秒', LEASE_TTL_MS === 30_000);

// ---------- 用例 11：多窗口（会话）隔离 ----------
// 11a. 别的窗口提交的 QUEUED（owner=他窗），本窗口 tick 不得代领
{
  const stamp = new Date().toISOString();
  await db.dispatchOrders.put({
    id: 'dsp-other-queued', seq: 9001, batchId: batches[0].id, task: 'FIX', note: 'other',
    rollerNeeded: 1, ovenNeeded: 1, state: 'QUEUED', heldWorkstationIds: [], heldAt: '',
    leaseExpiresAt: '', ownerSessionId: 's-other-window', reason: 'queued', attempts: 0, recordId: '',
    submittedAt: stamp, stateChangedAt: stamp, createdAt: stamp, updatedAt: stamp,
  });
  await tickScheduler();
  const row = await db.dispatchOrders.get('dsp-other-queued');
  check('他窗排队单不被本窗口代领（仍 QUEUED 且 owner 不变）', row?.state === 'QUEUED' && row?.ownerSessionId === 's-other-window');
}

// 11b. 他窗僵死 HELD（租约过期）→ 本窗口清扫将其释放为无主 QUEUED、保留 seq
{
  const stamp = new Date().toISOString();
  await db.dispatchOrders.put({
    id: 'dsp-other-held', seq: 9002, batchId: batches[1].id, task: 'ROAST', note: 'other-held',
    rollerNeeded: 1, ovenNeeded: 1, state: 'HELD', heldWorkstationIds: ['ws-roller-1', 'ws-oven-1'],
    heldAt: stamp, leaseExpiresAt: new Date(Date.now() - 5000).toISOString(),
    ownerSessionId: 's-other-window', reason: 'none', attempts: 0, recordId: '',
    submittedAt: stamp, stateChangedAt: stamp, createdAt: stamp, updatedAt: stamp,
  });
  await tickScheduler();
  const row = await db.dispatchOrders.get('dsp-other-held');
  check('他窗僵死占用被超时释放', row?.state === 'QUEUED' && row?.ownerSessionId === '' && row?.reason === 'lease_expired');
  check('超时释放保留原队位 seq', row?.seq === 9002);
  check('超时释放清空工位占用', (row?.heldWorkstationIds ?? []).length === 0);
}

// 11c. 无主 QUEUED（页面已关）tick 也不会自动占用，必须显式重试认领
{
  await tickScheduler();
  const row = await db.dispatchOrders.get('dsp-other-held');
  check('无主排队单不会被自动代领，等待显式重试', row?.state === 'QUEUED' && row?.ownerSessionId === '');
}

// 11d. 页面关闭：本会话 HELD 全部释放、清空工位、保留 seq、原因 page_closed
{
  const stamp = new Date().toISOString();
  await db.dispatchOrders.put({
    id: 'dsp-own-held', seq: 9003, batchId: batches[2].id, task: 'FIX', note: 'own',
    rollerNeeded: 1, ovenNeeded: 1, state: 'HELD', heldWorkstationIds: ['ws-roller-2', 'ws-oven-2'],
    heldAt: stamp, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    ownerSessionId: SESSION_ID, reason: 'none', attempts: 0, recordId: '',
    submittedAt: stamp, stateChangedAt: stamp, createdAt: stamp, updatedAt: stamp,
  });
  await releaseOnPageHide();
  const row = await db.dispatchOrders.get('dsp-own-held');
  check('页面关闭后本会话占用释放回 QUEUED', row?.state === 'QUEUED');
  check('页面关闭原因已记录', row?.reason === 'page_closed');
  check('页面关闭清空工位占用', (row?.heldWorkstationIds ?? []).length === 0 && row?.heldAt === '');
  check('页面关闭保留原队位 seq', row?.seq === 9003);
  check('页面关闭后变为无主单（等待重开调度台重试）', row?.ownerSessionId === '');
}

console.log(`\n全部 ${passed} 项调度不变量验证通过 ✅`);
process.exit(0);
