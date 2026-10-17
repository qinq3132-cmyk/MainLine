# Mainline 安装版 1.0

这是从免安装版 V12.1 派生的独立安装版本，从 **1.0** 开始迭代。旧版 EXE、旧版源码和原有安装说明没有被替换。

**[下载安装包 Mainline-Setup-1.0.exe](https://github.com/qinq3132-cmyk/MainLine/raw/refs/heads/main/Mainline-Desktop/downloads/Mainline-Setup-1.0.exe)**

## 安装与数据

1. 关闭正在使用的旧版 Mainline，再打开安装包，按中文向导安装。
2. 默认安装到 `%LOCALAPPDATA%\Programs\Mainline`，无需管理员权限。开始菜单中会出现 Mainline；桌面快捷方式可选。
3. 程序文件名固定为 `Mainline.exe`。后续安装版使用相同安装位置与应用标识升级。
4. 原有任务、聊天、日程、笔记、附件、模型配置和 SendKey 继续使用 `%LOCALAPPDATA%\Mainline\data`。若原来设置了 `MAINLINE_DATA_DIR`，请保持相同设置。
5. 首次打开安装版会先备份已有数据库。安装、重装和卸载均不会主动删除数据目录。旧版与安装版使用同一份数据，建议每次只运行一个版本。

安装包不包含开发者或用户的任务、聊天、笔记、附件、备份、API Key 或 SendKey。首次在其他电脑使用时，需要自行配置模型与微信提醒。

## 后台提醒的变化

- 正常打开应用不再创建、覆盖或修复 Windows 计划任务。
- 仅在“偏好与数据”中点击“开启关窗后提醒”或“修复关窗后提醒”时注册任务，使用当前用户的普通权限，只在登录期间运行，每 5 分钟检查一次。
- 设置页显示后台状态、任务名称、运行间隔和当前任务指向的程序位置。
- 旧任务指向旧版 EXE 时，安装版保留旧任务并显示修复入口；只有点击修复后才切换到安装版。也可以关闭原任务。
- 卸载时只清理明确指向本安装位置的 Mainline 后台任务；其他版本的任务保持不变，个人数据保留。
- Server酱发送限制仍为每天最多 5 次尝试，测试与失败计数；电脑关机、睡眠或退出登录时无法保证即时发送。

## Windows 防护测试结果

2026-10-17 在当前 Windows 电脑上，Defender 实时防护与行为监控保持开启，病毒库更新至 `1.461.65.0`。最终安装包及程序目录定向扫描均完成，相关威胁记录和检测／处置事件为 **0**。

实际安装、原生启动、提醒检查、重装及卸载验证通过；测试只使用预先初始化的虚构数据库。后台任务注册、查询和清理由独立测试进程调用安装版模块验证，使用唯一任务名称并推迟一年执行，测试后删除，未修改或执行用户真实的后台任务。

**这不是其他电脑的安全判定保证。** 本轮没有干净虚拟机测试，也没有模拟其他电脑通过浏览器下载后的 SmartScreen 信誉检查。安装包和主程序当前仍未数字签名，因此仍可能显示未知发布者或信誉警告。对于此前出现的行为检测，仍需在对方电脑分步验证首次启动及手动启用后台提醒；若再次报告威胁，保留检测名称和触发步骤，暂停运行并复核，不要求关闭 Defender 或设置排除项。

更多测试范围见 [1.0 验证记录](VALIDATION-1.0.md)。

## 文件校验

安装包 SHA-256：

```text
8FA83D64ACFC4A8FF922DC351EEA9C384998596F568D9C3FA9699C0FE2ED9B6E
```

也可以下载同目录的 `Mainline-Setup-1.0.sha256` 校验。

## 构建与验证

在此目录运行 `build.cmd`。构建需要已有的 `.venv-build` 环境和 Inno Setup 6.7.3 编译器；将已验证厂商签名的编译器部署到 `.tools\inno`。`.tools` 不进入 Git 或发布包。

`prepare.py` 将明确列出的 V12.1 运行源文件及公开界面资源复制到 `.build\1.0\source`，仅在副本应用安装版变更。它不读取个人数据库，并对上游源结构变化停止构建以要求重新审阅。

安装版使用 PyInstaller 文件夹模式，关闭 UPX。`Mainline-Installed.spec` 是可审阅的构建配置；`Mainline-Setup.iss` 只将构建出的程序目录纳入安装包。运行 `test_installer.py` 验证启动和任务操作，运行 `verify_installer.py` 验证真实安装流程，运行 `audit_release.py` 检查发布内容。`test_ui.cjs` 对安装版暂存资源执行提醒设置、四象限和笔记界面测试。`check_defender.ps1` 需要具备权限的 Windows PowerShell 5.1，仅扫描本安装版，不降低防护。

简体中文安装界面采用 Inno Setup 官方源码仓库 `is-6_7_3` 中的贡献翻译，原作者与说明保留在 `ChineseSimplified.isl` 中：[来源](https://github.com/jrsoftware/issrc/blob/is-6_7_3/Files/Languages/Unofficial/ChineseSimplified.isl)。构建工具及许可见 [Inno Setup](https://jrsoftware.org/isinfo.php)。
