import { HolafToast } from '../../vendor/holaf/holaf-toast.js';

/**
 * Lightweight toast notifications backed by HolafToast (holaf-lib v0.5.0).
 * The public API (toast(message, type)) is preserved so no caller changes.
 *
 * The 'homy' / 'homy-light' toast themes are registered and applied globally
 * (HolafToast.setTheme) by ui/theme.js, so toasts follow the dashboard
 * dark/light switch. Position/duration keep the previous bottom-right, ~3.2s
 * behavior.
 */

HolafToast.configure({ position: 'bottom-right', newestFirst: true, duration: 3200 });

/** Show a toast. `type` ∈ 'info' | 'success' | 'warning' | 'error' (default info). */
export function toast(message, type = 'info') {
  HolafToast.show({ message, type, duration: 3200 });
}
