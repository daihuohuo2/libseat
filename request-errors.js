'use strict';
function queryError(response, fallback) {
  const error = Error(response?.message || response?.msg || fallback);
  error.code = response?.code;
  return error;
}
function retryableRead(error) {
  if (Number(error?.code) === 10001) return false;
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || Number(error?.code) === 429
    || Number(error?.code) >= 500 && Number(error?.code) <= 599
    || /abort|timeout|timed?\s*out|network|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|超时|网络|服务器异常|服务繁忙|请求排队/i.test(String(error?.message || error));
}
module.exports = { queryError, retryableRead };
