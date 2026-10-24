// Page zoom: an automatic factor for large screens times the user's own choice (Ctrl +/-/0).
// screen.width is in Windows' scaled units, so the display scale setting is already applied.
import { getCurrentWebview } from '@tauri-apps/api/webview';

export const STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];

// Large screens at low display scaling get a little extra size so text isn't tiny.
export function autoZoom(screenWidth = window.screen.width) {
  if (screenWidth >= 3400) return 1.3;
  if (screenWidth >= 2500) return 1.15;
  return 1;
}

export function nextStep(current, direction) {
  if (direction === 0) return 1;
  const i = STEPS.findIndex((s) => s >= current - 0.001);
  const at = i < 0 ? STEPS.length - 1 : i;
  return STEPS[Math.max(0, Math.min(STEPS.length - 1, at + direction))];
}

export async function applyZoom(user = 1) {
  const factor = Math.round(autoZoom() * user * 100) / 100;
  try {
    await getCurrentWebview().setZoom(factor);
  } catch {
    // Outside the app (tests, screenshots) there is no native webview to zoom.
  }
  return factor;
}
