export const FAB_MIN_OPACITY = 0.1;
export const FAB_MIN_SIZE = 24;
export const FAB_MAX_SIZE = 96;

export const FAB_CLICK_ACTION_MENU = 0;
export const FAB_CLICK_ACTION_TRANSLATE = 1;
export const FAB_CLICK_ACTION_POPUP = 2;

export const DEFAULT_FAB = {
  isHide: false, // 默认显示悬浮按钮
  hideExceptionList: "",
  halfHide: false, // 默认不做半隐藏，完整显示
  opacity: 1, // 默认完全不透明
  size: 28, // 默认小巧尺寸
};

// Older stored configurations do not contain appearance preferences.
export function normalizeFabAppearance(config) {
  return {
    halfHide:
      typeof config?.halfHide === "boolean"
        ? config.halfHide
        : DEFAULT_FAB.halfHide,
    opacity:
      typeof config?.opacity === "number" && Number.isFinite(config.opacity)
        ? Math.min(1, Math.max(FAB_MIN_OPACITY, config.opacity))
        : DEFAULT_FAB.opacity,
    size:
      typeof config?.size === "number" && Number.isFinite(config.size)
        ? Math.round(
            Math.min(FAB_MAX_SIZE, Math.max(FAB_MIN_SIZE, config.size))
          )
        : DEFAULT_FAB.size,
  };
}
