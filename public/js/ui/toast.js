/**
 * Lightweight toast notifications. Creates a container on first use and
 * auto-dismisses each toast after a few seconds.
 */
let container = null;

export function toast(message, type = 'info') {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = message;
  container.appendChild(t);
  // force reflow so the transition plays
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3200);
}
