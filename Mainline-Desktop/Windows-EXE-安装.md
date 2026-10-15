# Mainline Windows EXE 安装与升级

## 直接下载

1. 点击[下载 Mainline-2026-10-15-v5.exe](https://github.com/qinq3132-cmyk/MainLine/raw/refs/heads/main/Mainline-Desktop/downloads/Mainline-2026-10-15-v5.exe)。这是 Windows 64 位单文件桌面版，下载后即可运行，不需要 Python 或源码。
2. 把 EXE 放在自己选择的固定文件夹，例如“文档”中的 `Mainline` 文件夹，然后双击打开。它是免安装版，不需要运行安装向导。首次打开可能因解压运行库而稍慢。
3. 在“偏好与数据 → 模型连接”中填写自己的模型服务地址、模型 ID 和 API Key。不配置模型时，本地任务和项目管理仍可使用。
4. 如需微信提醒，在[Server酱官网](https://sct.ftqq.com/docs/getting-started/sendkey/)用微信获取 Turbo SendKey，进入“偏好与数据 → 手机微信提醒”，填入 SendKey 并开启。可按需点击“开启关窗后提醒”；电脑保持开机和登录时，Windows 会每 5 分钟检查一次。

在具体项目中点击“项目文档”，可以选择任意有权限访问的本机文件夹，或输入完整路径创建新文件夹。之后可在界面中新建子文件夹、放入文件和浏览文档。关联路径保存在数据库中，外部文件夹里的原件不会被 EXE 或 JSON 导出打包；换电脑时要自行复制这些文件夹并重新关联。

若系统没有可用的 WebView2 运行环境，桌面窗口可能无法打开。请先安装微软官方 WebView2 Runtime，再重新运行 EXE。

## 数据、升级和卸载

聊天、日程、任务、项目、笔记、附件及配置默认保存在 `%LOCALAPPDATA%\Mainline\data`，与 EXE 分开。升级时先关闭旧窗口，再将旧 EXE 换为新版；数据会继续使用原目录。每个新版本首次启动会在 `backups` 目录创建升级前数据库快照，绝不因替换 EXE 清空旧记录。如果曾设置 `MAINLINE_DATA_DIR`，升级时保持相同设置。

如果从此仓库的旧网页版本升级，首次把新版 EXE 放在 `Mainline-Desktop/downloads` 或仓库内运行，且桌面数据目录还没有 `desk.sqlite3`，它会复制 `personal-desk/data` 中的数据库和附件，原件保留。若已经在其他位置运行过桌面版，优先继续使用现有桌面数据；不要用旧库覆盖它。需要手动迁移时，可在启动前设置 `MAINLINE_LEGACY_DATA_DIR` 指向旧 `data` 文件夹。搬迁前建议在“偏好与数据”中手动创建一次备份。

JSON 导出现在包含聊天、日程事项、提醒、项目、目标、笔记和设置，但不含附件原件或任何密钥。要完整转移个人记忆和附件，请在程序停止后复制整个数据目录，勿上传到公开仓库。微信提醒每个本地日最多 5 次发送尝试；测试和失败也计数，超额的提醒保留在本机。关闭窗口后定时检查需要 Windows 任务计划；电脑关机或睡眠时无法即时推送。

卸载程序时可删除 EXE。只有确实要清除自己的任务和模型配置时，才另外删除 `%LOCALAPPDATA%\Mainline\data`。备份建议从应用内“偏好与数据”导出，或在关闭程序后复制整个数据目录。

本次发布文件的 SHA-256：

```text
2238E5258CAD2D13EB380C84E2242E57865983AF5DED6A2F250F5069259EE00A
```

可在 PowerShell 中运行 `Get-FileHash .\Mainline-2026-10-15-v5.exe -Algorithm SHA256` 核对下载文件。发布包不包含开发者的 API Key、SendKey、本机任务数据库或附件。
