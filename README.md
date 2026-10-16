# 主线 · Mainline

把科研、创业和生活放在同一个个人工作台里，让重要的事持续向前。

Mainline 是一个本地运行的可视化个人秘书：四象限管理、两级项目、长期成长、周/月安排、文件整理与 AI 辅助排期。数据保存在使用者自己的电脑上。

仓库中的展示内容只用虚构示例，例如“社区读书会 → 确认场地和时间”和“周末骑行 → 规划路线和集合点”。这些示例不会自动写入应用。你实际创建的任务、聊天、日程、笔记和密钥只保存在本机数据目录，不随源码或 EXE 上传。发布前可运行 `python tools/check_public_upload.py` 检查 Git 暂存内容中的私人数据文件及密钥特征。

## 功能

- **四象限**：按重要、紧急划分事项，支持拖动、完成、编辑与回收站。
- **项目**：先按通信组等类别浏览，再查看具体项目的负责人、进度、里程碑和任务；聚餐等活动无需进度。
- **长期成长**：将长期目标与持续投入放在一起，支持定期回顾、关联任务与首页提醒。
- **个人笔记**：记录整体反思和每个具体项目的思考；支持搜索、续写、归档和恢复，并为秘书提供有界的相关上下文。
- **项目文档**：每个具体项目可关联任意可访问的本机文件夹；在项目里浏览文档、创建子文件夹、放入文件，并用电脑默认程序打开常见文档。文档原件留在选定位置。
- **周与月**：查看会议、约饭、时间块、截止日期和重复安排。
- **AI 秘书**：自然语言梳理、进度回顾、计划讨论；建议经过选择后才应用。
- **文件**：读取 Word `.docx`、PPT `.pptx`、PDF、Excel `.xlsx` 和文本，依据文字整理行动。
- **排期与专注**：保留固定安排、深度工作和缓冲，记录真实专注时间。
- **本地保存**：SQLite、导出/恢复、数据库备份。
- **微信提醒**：可选 Server酱 Turbo，提醒合并发送，按免费额度每天最多 5 次尝试；可开启 Windows 关窗后定时检查。

## Windows 下载安装

**[下载最新版单文件 Mainline.exe](https://github.com/qinq3132-cmyk/MainLine/raw/refs/heads/main/Mainline-Desktop/downloads/Mainline-2026-10-16-v12.1.exe)**（Windows 64 位，2026-10-16 更新版）。下载后将 EXE 放在自己选择的文件夹，双击运行；无需安装 Python，也无需下载源码。它是免安装桌面版，不是 Setup 安装器。V12.1 小版本修复笔记工具栏文字重叠；四象限将执行时间、截止日期和周期日期放在同一时间顺序中，完全未定日期的事项靠后，同日仅有日期的事项排在定时事项之后；首次启动仍可能因自解压稍慢。

关闭旧版窗口后再运行新版。聊天、日程、任务等记录默认保存在 `%LOCALAPPDATA%\Mainline\data`，更新 EXE 不会重置这些记录，首次运行新版本还会自动备份数据库。模型 API Key 和 Server酱 SendKey **都不包含在下载包中**，请在程序的“偏好与数据”中自行配置。详细步骤、旧网页数据迁移方法和校验值见[Windows EXE 安装说明](Mainline-Desktop/Windows-EXE-安装.md)。

桌面版的个人笔记支持大屏 Markdown 写作、专注模式、字号与行距调整、本机图片粘贴和拖入、自动保存、草稿续写及历史版本恢复。可按整体或项目保存；导出为 `.md`，含图片时打包为 `.zip`。笔记图片与文字一起保存在本机数据库，升级继续保留原记录。

如需保留文件夹版，可使用[桌面版源码和说明](Mainline-Desktop/README.md)自行构建。单文件版与文件夹版使用同一个本地数据目录。

## 从源码运行网页版本

只有从源码运行网页版本时，才需要 Python 3.11 或更新版本及现代浏览器；运行不需要 Node.js。

```powershell
git clone https://github.com/qinq3132-cmyk/MainLine.git
Set-Location MainLine
python -m pip install -r personal-desk/requirements.txt
```

Windows 双击 **启动主线.cmd**，或运行：

```powershell
python personal-desk/server.py --open-browser
```

打开 `http://127.0.0.1:5179`。Windows 后台启动后，用 **停止主线.cmd** 结束后台；从终端启动时可按 Ctrl+C 退出。关闭网页本身不会停止后台。

## 配置自己的模型

**不需要安装或配置 OpenCode。** 支持提供 OpenAI Chat Completions 兼容接口的服务，也可接入兼容接口的本地模型服务。

### 方式一：直接在页面填写

进入 **偏好与数据 → 模型连接 → 配置自己的 API**：

1. 填写连接名称、API 根地址、模型 ID（每行一个）和自己的 API Key。
2. 点击 **保存模型配置**。
3. 点击 **测试模型连接**。也可以在秘书面板切换已配置的模型。

密钥不回显；修改配置时留空表示保留原密钥，需要移除时勾选“清除已保存的密钥”。保存设置不等于连接已验证，连接测试会实际调用所选服务。

### 方式二：独立 JSON 文件

将 [配置示例](personal-desk/llm-config.example.json) 复制为 `personal-desk/data/llm-config.json`，填写自己的 API 根地址与模型 ID。示例使用 `{env:MY_MODEL_API_KEY}` 引用环境变量，也可在本机文件中填写自己的密钥。然后重新读取模型配置或重启。

指定其他配置文件：

```powershell
$env:MAINLINE_CONFIG = 'C:\MyConfig\llm-config.json'
python personal-desk/server.py --open-browser
```

### 方式三：环境变量

```powershell
$env:MAINLINE_BASE_URL = 'https://api.example.com/v1'
$env:MAINLINE_MODEL = 'your-model-id'
$env:MAINLINE_API_KEY = '填写自己的API密钥'
python personal-desk/server.py --open-browser
```

`api.example.com` 与 `your-model-id` 都是占位值。服务地址填写 API 根地址，后台会追加 `/chat/completions`。环境变量覆盖独立文件中的相应字段；环境变量配置生效时，页面会提示通过环境变量修改。

### 可选：兼容 OpenCode

已有 OpenCode 配置的使用者可以继续读取本机配置。默认保留兼容，可在设置里关闭；独立 JSON 文件也可用 `"use_opencode": false` 完全禁用该入口。它不是运行或调用模型的前提。

## 数据与隐私

- 每位用户自行提供 API 凭据，仓库仅包含占位示例。
- 网页源码版的数据默认在 `personal-desk/data/`；桌面 EXE 版默认在 `%LOCALAPPDATA%\Mainline\data`。旧网页数据在桌面版首次运行且目标数据目录为空时可安全复制，原目录保留。独立密钥配置跟随各自的数据目录，`MAINLINE_CONFIG` 可单独指定位置。
- 密钥只供后台调用，不写入任务数据库、任务导出或接口返回；配置文件存储在本机，**并非加密保险箱**，请使用自己的用户目录并妥善保管。聊天输入、日程及相关记录会保存在本地数据库，JSON 导出也包含聊天；附件原件需要复制整个数据目录。
- AI 请求会向你选定的服务发送相关任务、目标、输入和本次选择的附件文字。没有模型配置时，本地管理和手动安排仍可使用。
- 网页不加载外部字体、脚本或图片。服务只监听 `127.0.0.1`。
- 忽略规则排除数据目录、密钥配置、环境文件、日志与本地测试产物。分享备份或复制整个数据目录时，应另行检查其中内容。

文件分析目前针对可提取文字，不识别扫描页、图片和图表布局；旧 `.doc` / `.ppt` 请先另存为新格式。提醒需要后台运行；电脑关机或睡眠期间不执行，浏览器桌面通知需要页面保持打开并允许通知。当前时区为 Asia/Shanghai。

## 文档与开发

- [完整使用说明](personal-desk/README.md)
- [桌面版使用说明](Mainline-Desktop/README.md)
- [Windows EXE 安装与升级](Mainline-Desktop/Windows-EXE-安装.md)
- [Windows EXE 打包指南](personal-desk/Windows-EXE-打包指南.md)

```powershell
Set-Location personal-desk
python -m unittest discover -s tests -v
node --check public/app.js
```

测试使用临时数据库与模拟模型，不需要真实 API Key。前端为原生 HTML/CSS/JavaScript，后台使用 Python 标准库，PDF 文字提取依赖 pypdf。
