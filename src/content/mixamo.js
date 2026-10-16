/**
 * 内容脚本：扩展拿不到页面的 localStorage，因此由它把
 *   - Mixamo 的 access_token（导出接口需要）
 *   - 当前页面的 hash 查询参数（用户选好的筛选/搜索条件）
 * 回传给 Service Worker。
 *
 * 本扩展不需要操作页面 DOM，内容脚本只负责「读」。
 */

function readContext() {
  let token = '';
  try {
    token = localStorage.getItem('access_token') || '';
  } catch (e) {
    token = '';
  }
  let firstName = '';
  try {
    firstName = localStorage.getItem('first_name') || '';
  } catch (e) { /* ignore */ }

  return {
    ok: true,
    token,
    firstName,
    hash: location.hash || '',
    url: location.href,
    title: document.title,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'MM_GET_CONTEXT':
    case 'MM_PING':
      sendResponse(readContext());
      return true;
    default:
      return false;
  }
});

// 页面加载完成后主动上报一次，便于弹窗立即显示登录态
chrome.runtime.sendMessage({ type: 'MM_CONTEXT_READY', context: readContext() }).catch(() => {});
