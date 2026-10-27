import SvgIcon from "@mui/material/SvgIcon";
import { ZHI_PATH } from "../libs/zhiPath";

// 品牌图标「芷」：颜色跟随 currentColor，尺寸由 MUI SvgIcon 的 fontSize 控制。
export default function ZhiyiIcon(props) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24" data-testid="ZhiyiIcon">
      <path d={ZHI_PATH} />
    </SvgIcon>
  );
}
