# OpenTk Codex配置工具

一个用于管理本机 Codex 配置文件和 OIDC 登录的 Electron 桌面工具。

## 运行

```powershell
npm install
npm start
```

首次点击右上角关闭按钮时，可以选择退出应用或最小化到系统托盘；选择会保存到应用配置，之后关闭按钮会直接执行该操作。

应用自身配置和登录会话保存在 `%APPDATA%\\codex_img_autoconfig`。

## 打包 Windows 可执行文件

默认生成免安装的单文件 `.exe`：

```powershell
npm run build:win
```

生成可选择安装目录的安装包：

```powershell
npm run build:win:installer
```

也可以直接运行脚本并指定架构：

```powershell
.\scripts\build-win.ps1 -Target portable -Arch x64
```

在 macOS 上生成 Intel 和 Apple Silicon 的 DMG、ZIP 安装包：

```bash
npm run build:mac
```

macOS 构建必须在 macOS 机器或 macOS GitHub Actions runner 上执行。未配置 Apple Developer 证书时会生成未签名应用，首次打开可能需要在系统安全设置中手动允许。

打包产物位于 `dist` 目录。首次打包前需要执行一次 `npm install`。

## GitHub 在线更新

安装版通过 `electron-updater` 从 `hasagiiii/codex_img_autoconfig` 的 GitHub Releases 检查更新。设置页可以检查、下载并重启安装新版本，应用启动后也会自动检查一次。

发布新版本时，先修改 `package.json` 的版本号并推送对应标签：

```powershell
npm version patch
git push origin main --follow-tags
```

`v*` 标签会触发 `.github/workflows/release.yml`，运行测试并同时发布 Windows NSIS 安装包、portable 便携版及 macOS DMG/ZIP 和对应更新元数据。自动更新面向安装版；portable 版本仍需手动替换。公开客户端不能在程序中保存 GitHub Token，因此供普通用户更新的 GitHub 仓库和 Release 需要公开可下载。

应用会把 Codex 配置目录中的以下文件作为一组管理，并在左侧切换：

- `auth.json`
- `config.toml`
- `.env`（文件不存在时不展示）

默认会从以下位置定位这组文件所在目录：

- `%USERPROFILE%\\.codex\\config.toml`
- `%USERPROFILE%\\.codex\\config.json`
- `%APPDATA%\\Codex\\config.toml`
- `%APPDATA%\\OpenAI\\Codex\\config.toml`

也可以通过 `CODEX_CONFIG_PATH` 指定配置文件路径；应用会使用该路径所在目录作为配置文件组目录。前两个文件即使尚不存在也会显示为“待创建”，保存时会自动创建。保存时会在原文件旁生成带时间戳的 `.opentk-backup-*` 备份，备份可在界面中打开双栏 diff 查看。

Codex 配置页支持选择自定义配置目录。选择后会持久化使用该目录，并管理其中的 `auth.json`、`config.toml`、`.env` 和备份文件；也可以在侧栏恢复默认自动定位目录。

## OIDC 登录

默认本机回调地址：

```text
http://localhost:53777/oauth/callback
```

请将该地址加入 OIDC Provider 的 Allowed Redirect URIs。应用会在登录时监听本机固定端口，并通过系统默认浏览器完成授权。应用作为 Public Client，使用 Authorization Code Flow、PKCE S256、state 和 nonce，不保存或发送 Client Secret。登录令牌使用 Electron `safeStorage` 加密后保存在应用数据目录。

OIDC 配置项包括：

- Issuer URL
- Client ID
- Scopes
- Loopback Redirect URI

客户端认证方式固定为 `none`，Provider 端必须为该 Client ID 启用 Public Client 和 PKCE S256。登录成功后，Codex 文件页左侧会通过 `{Issuer}/oidc/resource/api-keys` 读取 API Key 列表，并支持复制当前选中的 Key。
