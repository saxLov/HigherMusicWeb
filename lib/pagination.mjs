/* 完整读取平台分页数据。兼容平台把每页条数缩小的情况，不能仅凭短页判定结束。
 * 重复页、总数尚未读完的空页以及超过上限都明确报错，避免把半份购买记录当成完整结果。 */
import { listFrom } from './provider.mjs';

// Some endpoints cap pagesize below the requested value. A short page alone
// must not end a response that still advertises more records.
/* collectPages()：fetchPage(page, pagesize) 返回平台一页数据；pageSize 默认 100，maxPages 默认 100。
 * 有 total 时必须收齐声明数量；无 total 才以不足一页结束，防止平台缩小页大小造成漏歌。 */
export async function collectPages(fetchPage, { pageSize = 100, maxPages = 100 } = {}) {
  const all = [];
  const seenPages = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const body = await fetchPage(page, pageSize);
    const rows = listFrom(body);
    const rawTotal = body?.data?.total ?? body?.data?.count ?? body?.total;
    const total =
      rawTotal === null || rawTotal === undefined || rawTotal === ''
        ? NaN
        : Number(rawTotal);
    const hasTotal = Number.isInteger(total) && total >= 0;
    if (!rows.length) {
      if (hasTotal && all.length < total)
        throw new Error('平台分页提前结束，数据尚未读取完整，请重试。');
      return all;
    }
    const fingerprint = JSON.stringify(rows);
    if (seenPages.has(fingerprint))
      throw new Error('平台重复返回同一页，数据尚未读取完整，请重试。');
    seenPages.add(fingerprint);
    all.push(...rows);
    if (hasTotal) {
      if (all.length >= total) return all;
    } else if (rows.length < pageSize) return all;
  }
  throw new Error('数据超过分页读取上限，尚未读取完整。');
}
