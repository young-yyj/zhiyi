// 悬浮球外观：品牌化自定义（青绿渐变 + 正圆），与扩展图标一致，
// 不再沿用上游 M3 的容器色 / 圆角方形。
export const FLOATING_BUTTON_STYLES = String.raw`
.kt-content-fab.MuiFab-root {
  width: var(--kt-fab-size, 56px);
  height: var(--kt-fab-size, 56px);
  min-width: var(--kt-fab-size, 56px);
  min-height: var(--kt-fab-size, 56px);
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: linear-gradient(135deg, #2EE59D 0%, #0FB8FF 100%);
  box-shadow: var(--kt-shadow-2);
  color: #ffffff;
  cursor: pointer;
  transition: filter .2s ease, box-shadow .2s ease, transform .2s var(--kt-spring);
}
@media (hover: hover) {
  .kt-content-fab.MuiFab-root:hover {
    background: linear-gradient(135deg, #2EE59D 0%, #0FB8FF 100%);
    filter: brightness(1.06);
  }
}
.kt-content-fab.MuiFab-root.Mui-focusVisible,
.kt-content-fab.MuiFab-root[aria-expanded="true"],
.kt-content-fab.MuiFab-root:active {
  background: linear-gradient(135deg, #2EE59D 0%, #0FB8FF 100%);
  filter: brightness(0.96);
}
.kt-content-fab.MuiFab-root:active { transform: scale(.96); }
.kt-content-fab.MuiFab-root.Mui-focusVisible { outline: none; box-shadow: var(--kt-shadow-2), inset 0 0 0 3px var(--kt-pri); }
.kt-content-fab .MuiSpeedDialIcon-root { width: var(--kt-fab-icon-size, 24px); height: var(--kt-fab-icon-size, 24px); display: grid; place-items: center; }
.kt-content-fab .MuiSvgIcon-root { width: var(--kt-fab-icon-size, 24px); height: var(--kt-fab-icon-size, 24px); font-size: var(--kt-fab-icon-size, 24px); }
`;
