# 个人秘书：Windows EXE 打包指南

编写日期：2026-10-14。本文记录早期打包方案和构建思路，后文的“尚未生成 EXE”等表述仅反映编写时状态。最新版已经打包；下载安装请看 [Windows EXE 安装说明](Windows-EXE-安装.md)，当前功能和本地构建请看 [README](README.md)。

## 1. 先选交付形式

| 形式 | 用户打开后的体验 | 适用阶段 |
| --- | --- | --- |
| EXE + 默认浏览器 | 双击启动本机服务，浏览器打开现有界面 | 首个试用版，复用当前实现 |
| EXE + 独立窗口 | 像普通桌面软件一样打开，可以用 pywebview 包住现有页面 | 正式桌面产品 |
| Setup.exe 安装包 | 安装、桌面快捷方式、升级和卸载；应用仍可采用上面任一形式 | 对外分发 |

推荐先跑通 **PyInstaller 文件夹版 → 干净电脑验证 → 完善启动与配置 → Inno Setup 安装包**。独立窗口可以放在下一步，不必重写当前网页。

PyInstaller 会收集 Python 解释器和程序依赖，接收者无需另装 Python；Windows、macOS、Linux 需要分别构建，不能把 Windows EXE 当成跨平台软件。参见 [PyInstaller 工作方式](https://pyinstaller.org/en/stable/operating-mode.html)。

## 2. 当前项目哪些已经具备，哪些还要改

已具备：本机网页、Python 后台、SQLite 保存、任务与目标、附件文字提取、模型调用、导入导出，以及仅监听 `127.0.0.1` 的服务。

当前直接发布还有这些缺口：

1. **模型首次配置（已完成）**：使用者可在“偏好与数据 → 模型连接”中填写服务地址、模型 ID 与自己的 API Key，保存并测试；也支持独立 JSON 和环境变量。OpenCode 仅为可选兼容入口。
2. **持久数据目录**：当前默认是源码旁的 `data`。发行版应默认使用 `%LOCALAPPDATA%\Mainline\data`，把任务、附件、备份和日志放在这里。程序安装目录与用户数据分开。
3. **启动与退出**：当前 EXE 直接运行后台。正式启动器应检查重复运行、处理端口占用、等待服务就绪再开页面，并提供退出或托盘菜单。现有 PowerShell 启动脚本不会被下面的打包命令自动转成这些能力。
4. **无终端运行**：先用带终端的试用版排错。正式版记录文件日志并提供错误提示后，再使用 `--windowed`。
5. **通用默认设置**：当前初始项目是两个科研组、个人科研、创业和生活，时区固定上海。面向更多人时应允许首次选择领域、重命名项目，并明确首版适用的时区。
6. **字体与版本**：其他电脑可能没有本机思源字体，需要验证回退效果；若随程序分发字体，应同时保留其许可。升级前备份数据库，卸载默认保留用户数据。

## 3. 快速打出可试用的 EXE

下面是在 **Windows PowerShell** 中执行的命令。构建电脑需要 Python；接收者不需要。建议使用干净的 64 位 Python 环境构建首个 Windows x64 版本。

### 3.1 创建独立的构建环境

```powershell
Set-Location -LiteralPath 'C:\Projects\MainLine\personal-desk'
python -m venv .venv-build
.\.venv-build\Scripts\python.exe -m pip install --upgrade pip
.\.venv-build\Scripts\python.exe -m pip install pyinstaller pypdf
```

不需要激活环境，也无需更改 PowerShell 执行策略。独立环境能避免把科研 Python 环境中不相关的包一起带进构建。

### 3.2 构建文件夹版

```powershell
.\.venv-build\Scripts\python.exe -m PyInstaller --noconfirm --clean --onedir --console --name Mainline --add-data "public:public" --collect-all pypdf server.py
```

生成目录：

```text
dist/
  Mainline/
    Mainline.exe
    _internal/
      public/
      ...程序依赖...
```

**分发整个 `dist\Mainline` 文件夹，不能只拿走里面的 EXE。** `--add-data` 把网页资源加入程序；`documents.py` 由正常导入收集；`pypdf` 是 PDF 文字提取依赖。命令格式见 [PyInstaller 参数说明](https://pyinstaller.org/en/stable/usage.html)。

此命令只明确收集网页和依赖，不需要打包 `data`、测试文档、OpenCode 配置或自己的 API Key。发布前检查实际输出内容。

### 3.3 在当前电脑隔离试运行

你正在运行的正式指挥台占用 5179，测试版使用 **5181** 和独立数据目录：

```powershell
$deskTrialData = Join-Path $env:LOCALAPPDATA 'Mainline-Trial\data'
.\dist\Mainline\Mainline.exe --open-browser --port 5181 --data-dir "$deskTrialData"
```

这会启动浏览器版应用，并在独立目录保存测试数据。试用版保留终端窗口，按 Ctrl+C 退出服务；关闭网页本身不会停止后台。

如果端口已被其他服务占用，应换一个空闲端口，不要结束不相关的进程。当前后台尚未自动解决端口冲突或重复启动。

### 3.4 给试用者一个双击入口

在 `dist\Mainline` 内新增 `启动.cmd`，内容如下。它只是试用入口，不替代正式启动器：

```bat
@echo off
"%~dp0Mainline.exe" --open-browser --port 5181 --data-dir "%LOCALAPPDATA%\Mainline-Trial\data"
```

接收者解压整个文件夹，双击 `启动.cmd` 即可。此阶段仍保留终端便于排错。正式版应把参数和生命周期管理合并进 EXE，让用户直接双击 EXE。

## 4. 试用者如何配置自己的模型

在“偏好与数据 → 模型连接 → 配置自己的 API”填写 API 根地址、模型 ID 与自己的 API Key，保存后测试连接。可以关闭可选的 OpenCode 兼容入口，无需安装 OpenCode。

也可参考 `llm-config.example.json` 创建独立配置，默认在所选数据目录的 `llm-config.json`；`MAINLINE_CONFIG` 可指定别处。环境变量 `MAINLINE_BASE_URL`、`MAINLINE_MODEL`、`MAINLINE_API_KEY` 覆盖文件相应字段。具体示例见仓库根 README。

配置保存于本机文件，不回显密钥，不写入任务数据库或任务导出；配置文件并未加密。不要将自己的配置文件、数据目录或真实 API Key 加入发行包。

没有 API Key 时，本地管理和手动安排仍可用，AI 整理与回顾需要可用模型。接入本地兼容服务时按该服务自己的鉴权方式填写。

软件分发与 AI 额度是两件事。首版采用每位用户自行提供凭据；统一付费额度需要单独的服务端，不应把公共密钥写入 EXE。

## 5. 做成独立桌面窗口

可增加 `desktop.py` 启动器，用 **pywebview** 打开现有本机页面，保留 Python 后台与网页代码。它解决窗口外壳，不会自动解决配置、备份、退出和更新。

启动器应依次完成：确定用户数据目录 → 检查现有实例 → 启动本机后台 → 等待就绪 → 打开窗口 → 按约定退出或隐藏到托盘。

Windows 需要选定并验证 WebView 渲染后端；通常使用 Edge Chromium/WebView2，并为缺少相应运行环境的电脑准备安装检测。见 [pywebview 安装说明](https://pywebview.flowrl.com/guide/installation.html) 与 [冻结打包说明](https://pywebview.flowrl.com/guide/freezing.html)。

这一步需要实际新增启动器代码，不能只在当前构建命令后加一个参数就完成。

## 6. 做成 Setup.exe 安装包

文件夹版稳定后，用 Inno Setup 把整个发行文件夹做成安装包，负责安装路径、快捷方式和卸载。推荐按当前用户安装，不要求管理员权限；`PrivilegesRequired=lowest` 的含义见 [Inno Setup 官方说明](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm)。

下面是**正式启动器完成之后**可采用的基础模板。先保存为 `installer.iss`，最终名称、图标、版本及应用标识应在首次正式发布前确定并固定。不要把它误当作已经适配当前直接运行的 `server.py`：模板要求 EXE 自己默认使用用户数据目录并打开界面。

```ini
[Setup]
AppId=Mainline.Desktop
AppName=Mainline
AppVersion=0.1.0
DefaultDirName={localappdata}\Programs\Mainline
PrivilegesRequired=lowest
OutputDir=release
OutputBaseFilename=Mainline-Setup-0.1.0
Compression=lzma2
SolidCompression=yes

[Files]
Source: "dist\Mainline\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Mainline"; Filename: "{app}\Mainline.exe"
Name: "{userdesktop}\Mainline"; Filename: "{app}\Mainline.exe"

[Run]
Filename: "{app}\Mainline.exe"; Description: "打开 Mainline"; Flags: nowait postinstall skipifsilent
```

安装程序不应把用户数据库放在 `{app}`，卸载也不要增加清空个人数据的规则。升级前退出正在运行的应用，保留稳定的应用标识和数据目录，并验证旧版数据库升级后可继续打开。

## 7. 如果一定要“只有一个 EXE”

文件夹版通过测试后，可将 `--onedir` 改为 `--onefile`，重新构建：

```powershell
.\.venv-build\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile --console --name Mainline --add-data "public:public" --collect-all pypdf server.py
```

产物是 `dist\Mainline.exe`。试运行时仍需要传入外部 `--data-dir`。单文件模式会把资源解压到临时目录，退出时清理；**当前代码若直接双击这个单文件 EXE、没有传入外部数据目录，会把默认数据库建在资源目录里，不能用于正式分发。** 应先把后台默认数据路径改为 `%LOCALAPPDATA%`。

PyInstaller 也建议先验证文件夹模式，再尝试单文件；单文件启动存在额外解压步骤。见 [单文件工作方式](https://pyinstaller.org/en/stable/operating-mode.html#how-the-one-file-program-works) 和 [资源路径说明](https://pyinstaller.org/en/stable/runtime-information.html)。

“一个安装用的 Setup.exe”与“一个直接运行的单文件 EXE”不同。正式分发通常可以用单个安装包，安装后保留完整的应用文件夹。

## 8. 发给别人前，实际验收这些操作

在没有开发环境、没有 OpenCode 配置的普通 Windows 账号或虚拟机里测试，而不只在自己的科研电脑测试。

1. 首次打开成功，网页和字体正常，无需 Python；未配置模型也能管理本地事项。
2. 新建任务、长期目标、回顾记录，退出并重开后仍在；附件原件和提取文字仍在。
3. 自带 Key 配置和连接测试成功；两份 Word/PPT 能整理出可审核的建议。
4. 断网、错误 Key、端口被占用、重复点击时有清楚反馈。
5. 退出入口能结束对应后台；后台继续运行时提醒与前台通知的行为符合界面说明。
6. 导出、恢复、升级和卸载后的数据保留符合说明。
7. 发布目录不含自己的任务库、测试文件和密钥；检查依赖许可并随发行包保留适用的许可文件。

首版可先给少量同事试用。扩大公开分发时再加入代码签名和稳定的更新机制；签名流程可参考 [Inno Setup 签名卸载程序](https://jrsoftware.org/ishelp/topic_setup_signeduninstaller.htm)，签名不会替代功能验证。

## 建议的实际顺序

完成正式启动器与数据目录适配 → PyInstaller 文件夹版 → 干净 Windows 环境验收 → Inno Setup 安装包 → 需要时增加独立窗口和更新机制。

如果只是想先让同事试用，可以先按第 3、4 节构建浏览器版；如果要面向“大家都可以直接用”，应完成第 2 节的产品适配后再正式发布。
