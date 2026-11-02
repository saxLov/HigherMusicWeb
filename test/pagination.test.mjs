/* 自动检查：分页完整性：平台缩小每页数量、重复页、提前空页和读取上限。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPages } from '../lib/pagination.mjs';

test('平台缩小每页数量时仍读取总数中的全部记录', async () => {
  const calls = [];
  const rows = Array.from({ length: 32 }, (_, id) => ({ id }));
  const result = await collectPages(
    async (page) => {
      calls.push(page);
      return { data: { total: 32, info: rows.slice((page - 1) * 15, page * 15) } };
    },
    { pageSize: 50 },
  );
  assert.equal(result.length, 32);
  assert.deepEqual(calls, [1, 2, 3]);
});
test('重复页不能被冒充为完整购买记录', async () => {
  await assert.rejects(
    collectPages(async () => ({ data: { total: 100, info: [{ id: 1 }] } })),
    /重复/,
  );
});
test('总数未读完时空页不能被当成成功', async () => {
  await assert.rejects(
    collectPages(async (page) => ({
      data: { total: 2, info: page === 1 ? [{ id: 1 }] : [] },
    })),
    /提前结束/,
  );
});
test('无总数且恰好满页时需要读取下一页', async () => {
  let calls = 0;
  const result = await collectPages(
    async (page) => {
      calls++;
      return { data: { info: page === 1 ? [{ id: 1 }, { id: 2 }] : [] } };
    },
    { pageSize: 2 },
  );
  assert.equal(result.length, 2);
  assert.equal(calls, 2);
});
test('超过读取上限必须明确失败，不能返回半份数据', async () => {
  await assert.rejects(
    collectPages(async (page) => ({ data: { total: 100, info: [{ id: page }] } }), {
      maxPages: 2,
    }),
    /上限/,
  );
});
