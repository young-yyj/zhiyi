import { forwardRef } from "react";
import Fab from "@mui/material/Fab";
import SpeedDialIcon from "@mui/material/SpeedDialIcon";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ZhiyiIcon from "./ZhiyiIcon";
import { normalizeFabAppearance } from "../config/fab";

// 图标与按钮的基准比例沿用历史基线（56px 按钮配 24px 图标），
// 不随 DEFAULT_FAB.size 变化，避免小尺寸按钮被图标撑满。
const FAB_ICON_REFERENCE_SIZE = 56;

// Keep the content button and its settings preview visually identical.
const FloatingButton = forwardRef(function FloatingButton(
  { size, opensMenu = true, open = false, className = "", style, ...props },
  ref
) {
  const { size: buttonSize } = normalizeFabAppearance({ size });

  return (
    <Fab
      {...props}
      ref={ref}
      className={`kt-content-fab ${className}`.trim()}
      style={{
        "--kt-fab-size": `${buttonSize}px`,
        "--kt-fab-icon-size": `${Math.max(12, (buttonSize * 24) / FAB_ICON_REFERENCE_SIZE)}px`,
        ...style,
      }}
    >
      {opensMenu ? (
        <SpeedDialIcon
          icon={<ZhiyiIcon />}
          openIcon={<CloseRoundedIcon />}
          open={open}
        />
      ) : (
        <ZhiyiIcon />
      )}
    </Fab>
  );
});

export default FloatingButton;
