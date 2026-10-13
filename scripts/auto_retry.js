/* === ANTIGRAVITY 2.0 AUTO-RETRY INJECTION === */
(function() {
  const CONFIG = { checkIntervalMs: 2000, retryDelayMs: 3000, cooldownMs: 5000 };
  const RETRY_LABELS = new Set(['retry', 'try again', '重试', '重試', '再试一次', '再試一次']);
  const ERROR_SELECTOR = '[role="alert"], [data-state="error"], [data-status="error"], [data-testid="agent-error"], .agent-error, .task-error, .error-message';
  const ERROR_MESSAGES = /encountered an error|agent execution terminated|an error was thrown|遇到错误|遇到錯誤|抛出了一个错误|拋出了一個錯誤/i;
  let retryCount = 0;
  let isProcessing = false;
  let lastRetryTime = 0;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function retryContext(el) {
    if (!isVisible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
    // A visible action label takes precedence over an outdated aria/title label.
    const labels = text ? [text] : [el.getAttribute('aria-label'), el.getAttribute('title')];
    if (!labels.some(label => RETRY_LABELS.has(String(label || '').trim().toLowerCase()))) return null;
    const explicitError = el.closest(ERROR_SELECTOR);
    if (explicitError && isVisible(explicitError)) return explicitError;
    // Some client versions render a small error card without semantic attributes.
    // Limit the search to nearby ancestors; never infer an error from page text.
    let parent = el.parentElement;
    for (let depth = 0; depth < 3 && parent && parent !== document.body && parent !== document.documentElement; depth++, parent = parent.parentElement) {
      const message = (parent.innerText || parent.textContent || '').trim();
      if (message.length < 500 && ERROR_MESSAGES.test(message) && isVisible(parent)) return parent;
    }
    return null;
  }

  function findRetryButton() {
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const context = retryContext(el);
      if (context) return { el, context };
    }
    return null;
  }

  function setupObserver() {
    console.log('[Auto-Retry 2.0] 自动重试已激活，仅匹配错误提示中的重试按钮。');
    setInterval(() => {
      if (isProcessing || Date.now() - lastRetryTime < CONFIG.cooldownMs) return;
      const match = findRetryButton();
      if (!match) return;
      isProcessing = true;
      setTimeout(() => {
        try {
          // The element, action and error context must still be current.
          if (retryContext(match.el) === match.context) {
            match.el.click();
            retryCount++;
            lastRetryTime = Date.now();
            console.log('[Auto-Retry 2.0] 已触发第 ' + retryCount + ' 次重试。');
          }
        } catch (err) {
          console.error('[Auto-Retry 2.0] 点击失败:', err);
        } finally {
          isProcessing = false;
        }
      }, CONFIG.retryDelayMs);
    }, CONFIG.checkIntervalMs);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', setupObserver, { once: true });
  } else {
    setupObserver();
  }
})();
/* === END ANTIGRAVITY 2.0 AUTO-RETRY INJECTION === */
