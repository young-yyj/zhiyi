/**
 * @file styles.js
 * @description Material 3 styles for the selection translation panel.
 *
 * These rules require CSS variables from hooks/M3Theme, including --kt-sf0,
 * --kt-linev, and --kt-spring, plus the kt-m3-rise and kt-m3-pop keyframes
 * from src/styles/m3.js. Use them only inside M3Theme.
 *
 * DraggableResizable.js emits the KT-draggable* classes. Their overrides need
 * !important to take precedence over the nodes' MUI sx styles.
 */
export const SELECTION_STYLES = String.raw`
.KT-draggable { overflow: visible !important; border-radius: 16px !important; animation: kt-m3-rise .45s var(--kt-spring); }
.KT-draggable-header { overflow: visible; }

/* 划词触发按钮：与网页悬浮球统一为青绿渐变圆形 +「译」字。 */
.KT-tranbtn { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; appearance: none; background: linear-gradient(135deg, #2EE59D 0%, #0FB8FF 100%); box-shadow: var(--kt-shadow-2); color: #ffffff; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; line-height: 1; transition: filter .2s, transform .15s; }
@media (hover: hover) {
  .KT-tranbtn:hover { background: linear-gradient(135deg, #2EE59D 0%, #0FB8FF 100%); filter: brightness(1.06); }
}
.KT-tranbtn:active { background: linear-gradient(135deg, #2EE59D 0%, #0FB8FF 100%); filter: brightness(0.96); transform: scale(.94); }
.KT-tranbtn:focus { outline: none; box-shadow: var(--kt-shadow-2), inset 0 0 0 3px var(--kt-pri); }
@supports selector(:focus-visible) {
  .KT-tranbtn:focus { box-shadow: var(--kt-shadow-2); }
  .KT-tranbtn:focus-visible { outline: none; box-shadow: var(--kt-shadow-2), inset 0 0 0 3px var(--kt-pri); }
}
`;
