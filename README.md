# Hermes Wallpaper Engine 插件

把 Wallpaper Engine 的**当前壁纸**实时带到 [Hermes Desktop](https://hermes.com) 的窗口背景里——不只是静态封面，而是真正的内容：视频循环播放、动图/图片背景、网页壁纸、场景壁纸透明透出。

## 功能

| 壁纸类型 | 处理方式 |
| --- | --- |
| 视频（.mp4/.webm/.mov） | 窗口内 `<video>` 循环播放 |
| 网页（index.html） | `<iframe>` 嵌入（file:// 下脚本资源受限，部分网页壁纸可能黑屏，见限制） |
| GIF / 图片 | `background-image` 渲染（大动图走验证过的可靠路径） |
| 场景（scene.pkg） | 格式封闭、外部无法渲染 → **自动开启 Hermes Clear 透明模式**，桌面上的 WE 实时场景直接透过窗口显示，还原度 100% |

其他能力：

- **永不黑屏**：任何媒体探测失败 → 自动降级（真实媒体 → 透出桌面 → 内置默认壁纸）
- **自动恢复**：场景壁纸触发 Clear 时记住你原来的透明设置，切回视频壁纸时自动还原；你中途手动调过设置则不覆盖
- **gif 封面不渲染**：`preview.gif`（无论是否动画）只当封面、永不当作媒体
- **15s 轮询**：在 WE 里切换壁纸后自动跟随
- 状态栏 chip 显示当前模式（壁纸 / 透出 / 离线）

## 安装

把本仓库按原目录结构复制进 Hermes 的配置目录（`%LOCALAPPDATA%\hermes`）：

```
hermes-wallpaper-engine/
├── desktop-plugins/wallpaper-engine/plugin.js        →  <HERMES_HOME>\desktop-plugins\wallpaper-engine\plugin.js
└── plugins/wallpaper-engine/dashboard/
    ├── plugin_api.py                                  →  <HERMES_HOME>\plugins\wallpaper-engine\dashboard\plugin_api.py
    └── scene_to_media.py                              →  <HERMES_HOME>\plugins\wallpaper-engine\dashboard\scene_to_media.py
```

（`HERMES_HOME` 通常是 `C:\Users\<你>\AppData\Local\hermes`，也支持 `~\AppData\Roaming\hermes` 等变体，以后端实际加载位置为准。）

**完全重启 Hermes Desktop**（含 Python 后端）后生效。前端改动可以 `Ctrl+K` Reload desktop plugins，后端改动必须完全重启。

## 使用

- 在 Wallpaper Engine 里切换壁纸，Hermes 每 15 秒自动跟随
- Palette 命令：
  - `WE: Cycle Background Opacity` —— 循环切换内容层不透明度（55% → 35% → 70% → 85%）
  - `WE: 场景壁纸自动透出 (Auto Clear)` —— 开关场景壁纸的自动透明透出
  - `WE: Live Wallpaper Mode` —— 手动透出提示
- 想一直看到桌面实时壁纸：设置 → 外观 → Window Translucency → Clear

## 场景壁纸（scene.pkg）说明

`scene.pkg` 是 Wallpaper Engine 的**封闭格式**，只有 WE 自己的引擎（Chromium + WebGL + 场景脚本系统）能渲染，没有任何浏览器/插件能解码。插件采取的方案是：检测到场景壁纸时**自动开启 Hermes 的 Clear 透明模式**——让正在桌面运行的 WE 引擎把场景实时渲染出来，透过 Hermes 透明窗口直接显示。这比任何封面/截图都完整：粒子、着色器、音频响应全部保留，且零性能损耗。

后端还附带 `scene_to_media.py`（可选工具）：如果不想用透明模式，可以把桌面上的真实场景画面截取为 `render.jpg` / `render.gif`，插件会当作真媒体播放。`python scene_to_media.py`（`--all` 转换全部场景壁纸）。

## 配置

后端 `plugin_api.py` 顶部：

```python
STEAM_BASE = Path(r"D:\Program Files (x86)\Steam")
WE_CONFIG = STEAM_BASE / "steamapps" / "common" / "wallpaper_engine" / "config.json"
WORKSHOP_BASE = STEAM_BASE / "steamapps" / "workshop" / "content" / "431960"
```

按你的 Steam / WE 安装位置修改。

依赖：Python 3（后端运行环境，Hermes 自带）；`scene_to_media.py` 需要 `pip install pillow`。

## 已知限制

- **场景壁纸**无法在 Hermes 窗口内嵌渲染（格式封闭），使用透明透出方案
- **网页壁纸**通过 `file://` iframe 加载时，Chromium 安全模型会拦截其脚本/样式资源（`ERR_FAILED`），部分依赖 JS 的网页壁纸会黑屏——这是浏览器安全限制，不是插件 bug
- 多显示器：后端按 WE 配置的 Monitor0/1 读取，`scene_to_media.py` 当前截取整个虚拟桌面
