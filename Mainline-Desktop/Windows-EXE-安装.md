# Mainline Windows EXE 安装与升级

## 直接下载

1. 点击[下载 Mainline-2026-10-15.exe](https://github.com/qinq3132-cmyk/MainLine/raw/refs/heads/main/Mainline-Desktop/downloads/Mainline-2026-10-15.exe)。这是 Windows 64 位单文件桌面版，下载后即可运行，不需要 Python 或源码。
2. 把 EXE 放在自己选择的固定文件夹，例如“文档”中的 `Mainline` 文件夹，然后双击打开。它是免安装版，不需要运行安装向导。首次打开可能因解压运行库而稍慢。
3. 在“偏好与数据 → 模型连接”中填写自己的模型服务地址、模型 ID 和 API Key。不配置模型时，本地任务和项目管理仍可使用。

若系统没有可用的 WebView2 运行环境，桌面窗口可能无法打开。请先安装微软官方 WebView2 Runtime，再重新运行 EXE。

## 数据、升级和卸载

任务、项目、附件及模型配置默认保存在 `%LOCALAPPDATA%\Mainline\data`，与 EXE 分开。升级时先关闭旧窗口，再将旧 EXE 换为新版；数据会继续使用原目录。如果曾设置 `MAINLINE_DATA_DIR`，升级时保持相同设置。

卸载程序时可删除 EXE。只有确实要清除自己的任务和模型配置时，才另外删除 `%LOCALAPPDATA%\Mainline\data`。备份建议从应用内“偏好与数据”导出，或在关闭程序后复制整个数据目录。

本次发布文件的 SHA-256：

```text
BC80FEC128029F0AE56947D409B96573644C0AA092D2361BEFAA342184E5120D
```

可在 PowerShell 中运行 `Get-FileHash .\Mainline-2026-10-15.exe -Algorithm SHA256` 核对下载文件。发布包不包含开发者的 API Key、本机任务数据库或附件。
