# 知了hub 管理后台

`admin-server/` 是与根目录静态前台物理隔离的管理服务。它提供唯一管理员密码 + TOTP 登录、可选的已配对设备挑战应答登录、SQLite持久化会话、作品/日记元数据与 Markdown 正文管理、保存即静态发布、受限文件上传、本地备份/恢复，以及实用优先的服务端 HTML 管理界面。当前仍只完成本地开发与部署前准备，没有真实部署。

## 本地运行

1. 复制 `.env.example` 为 `.env`，填写真实随机值。
2. 运行 `node scripts/hash-password.js`，在交互式终端中输入并确认管理员密码；只把输出的 bcrypt 哈希写入 `ADMIN_PASSWORD_HASH`。
3. 使用 32 字节随机数据的 Base64 表示填写 `TOTP_ENCRYPTION_KEY`。
4. 在本目录运行 `npm install`，再运行 `npm start`。
5. 浏览器访问 `http://127.0.0.1:3001/admin/login`。

可用 Node.js 生成本地配置素材：

```powershell
node scripts/hash-password.js
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

密码哈希工具要求在交互式终端中运行，输入不回显、不写日志或文件，标准输出只包含最终 bcrypt 哈希。真实 `.env`、SQLite 数据库和上传文件都由仓库根目录 `.gitignore` 排除。

### 同一 WiFi 局域网访问（开发期可选）

默认 `HOST=127.0.0.1` 只允许本机访问。需要让配套 Android App 通过同一 WiFi 直连时，可在可信任的家庭网络内把真实 `.env` 改为：

```dotenv
HOST=0.0.0.0
PORT=3001
```

重启后，启动日志会遍历本机网络接口，过滤回环、常见虚拟网卡和非 RFC1918 IPv4，并逐条显示所有候选地址，例如 `局域网访问地址（WLAN）：http://192.168.1.20:3001`。如果仍只监听 `127.0.0.1`，日志只会把这些 IP 标为“检测到”，并明确提示局域网访问尚未启用，不会把不可达地址误报为可访问。

手机与电脑必须连接同一 WiFi；Windows 防火墙只应在“专用网络”范围放行实际端口。该方式仍是未加密 HTTP，只适合可信任开发网络，不能暴露到公网，也不能替代生产 HTTPS。局域网 IP 变化后需在 App 内手动更新；本版本不实现 mDNS、自动发现或 IP 自动更新。USB 调试仍可继续使用 `adb reverse` 作为备选。

2026-08-07 已在真实 Android 设备上关闭全部 `adb reverse`，通过同一 WiFi 的 RFC1918 地址完成挑战应答登录、`/health` 在线、WiFi 断开超时提示及重连恢复验证；修改地址没有要求设备重新配对。

## 作品与日记静态发布

作品/日记的结构化字段保存在SQLite，正文保存在 `content/works/`、`content/notes/` 的Markdown文件。管理后台新增、编辑或删除成功后会立即全量发布，不设置草稿状态：

- 生成根目录 `works.html`、`notes.html` 及全部 `works-<slug>.html`、`notes-<slug>.html` 详情页。
- 使用 `src/templates/` 中的统一页面骨架和现有 `css/style.css`、`js/site.js`，访客访问生成页时不请求后台。
- 每个生成文件首行都有“此文件由知了hub后台自动生成，请勿手动编辑”标记；内容修改应通过管理后台，骨架修改应通过模板。
- 全量发布只清理带生成标记且已不在数据库中的详情页，不修改 `index.html`、`feedback.html`、`css/` 或 `js/`。
- 标题首次创建时生成稳定slug，重名追加数字后缀；后续修改标题不会改变既有URL。
- 管理面板显示“已发布”状态、最近发布时间和当前作品/日记数量，并提供手动“重新全量发布”用于故障恢复。

原8个作品与3篇占位日记已经完成一次性迁移。迁移脚本默认只做只读预览；只应在空内容表、后台已停止且尚未执行过迁移时使用：

```powershell
npm run migrate-existing-content
node scripts/migrate-existing-content.js --apply --confirm-server-stopped
```

脚本会主动探测配置端口，后台仍在监听时拒绝执行；同时拒绝覆盖已有Markdown、拒绝非空内容表并记录迁移标记，不能作为日常导入工具重复运行。

## 会话存储

登录会话保存在现有 `data/admin.sqlite3` 的 `sessions` 表，不再使用 `express-session` 默认的 MemoryStore。同一份 `SESSION_SECRET` 和数据库持久卷可使未过期会话在服务重启后继续有效；过期记录会在读取时及周期清理时失效。Cookie继续使用 `httpOnly`、`SameSite=Strict`，生产环境启用 `secure`。

- `SESSION_MAX_AGE_MS`：会话与Cookie有效期，默认8小时。
- `SESSION_CLEANUP_INTERVAL_MS`：后台清理过期记录的间隔，默认15分钟。
- 更换 `SESSION_SECRET` 会使已有签名Cookie失效；更换前应把它视为主动注销所有会话的运维操作。

## 设备配对与挑战应答登录

设备登录是密码+TOTP之外的第二种登录入口，不替代原流程。首次配对或更换设备仍必须先通过密码+TOTP登录网页后台，在 `/admin/device` 手动生成配对码。本仓库只提供服务端接口；配套安卓App将在独立仓库 `zhiliaohub_app` 中开发。

当前只允许一个有效设备：新配对成功会自动吊销旧设备及其未完成挑战。主动吊销后，旧公钥、未完成挑战和该设备建立的既有session都会立即失效；重新使用必须再次通过密码+TOTP生成配对码。

### 协议约定

- 设备密钥：ECDSA P-256（`prime256v1`），公钥使用PEM编码的SPKI `PUBLIC KEY`。
- 配对码：10个高辨识度字符，显示为 `XXXXX-XXXXX`；默认5分钟有效，只能使用一次，数据库只保存SHA-256摘要。
- 挑战：32字节随机值，默认2分钟有效；成功登录后原子标记为已使用，不能重放。
- 签名：安卓端使用 `SHA256withECDSA`，签名对象必须是接口返回的 `signedPayload` UTF-8字节；签名结果使用ASN.1 DER格式并以Base64提交。
- 登录结果：成功后返回现有 `zhiliaohub.admin.sid` session Cookie；App必须维护Cookie，生产环境只能通过HTTPS调用。

相关环境变量：

```dotenv
PAIRING_CODE_TTL_MS=300000
DEVICE_CHALLENGE_TTL_MS=120000
DEVICE_AUTH_RATE_LIMIT_WINDOW_MS=900000
DEVICE_AUTH_RATE_LIMIT_MAX=30
```

### 管理接口

以下接口需要已登录session与CSRF令牌；生成配对码还要求当前session明确由密码+TOTP建立，设备session调用会返回 `403`：

| 方法与路径 | 用途 |
|------|------|
| `GET /api/admin/device` | 查询当前有效设备的名称、配对时间、最近使用时间与公钥指纹 |
| `POST /api/admin/device/pairing-code` | 生成一次性配对码；请求头携带 `X-CSRF-Token` |
| `POST /api/admin/device/revoke` | 吊销当前设备；请求头携带 `X-CSRF-Token` |

配对码响应示例：

```json
{
  "pairingCode": "ABCDE-23456",
  "expiresAt": "2026-08-04T12:05:00.000Z"
}
```

### 安卓App公开接口

这些接口不要求已有session，但受IP限流，并分别要求有效配对码或有效设备签名。

1. `POST /api/device-auth/pair`

```json
{
  "pairingCode": "ABCDE-23456",
  "deviceName": "我的安卓设备",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

2. `POST /api/device-auth/challenge`，请求体可使用空JSON对象。响应中的 `signedPayload` 是唯一应签名内容，App不应自行拼接另一个版本：

```json
{
  "challengeId": "UUID",
  "challenge": "BASE64URL_RANDOM_VALUE",
  "signedPayload": "zhiliaohub-device-login:v1:UUID:BASE64URL_RANDOM_VALUE",
  "expiresAt": "2026-08-04T12:02:00.000Z",
  "signatureAlgorithm": "SHA256withECDSA",
  "signatureEncoding": "DER_BASE64"
}
```

3. `POST /api/device-auth/login`

```json
{
  "challengeId": "UUID",
  "signature": "BASE64_ENCODED_DER_ECDSA_SIGNATURE"
}
```

配对码无效/过期/已使用，签名错误，挑战过期/已使用或设备被吊销均返回认证失败，不会建立session。不提供二维码接口，也不接收或保存设备私钥。

## 配套App兼容性

- 设备认证接口自 `v1.2` 起提供。
- 当前已完成真实设备联调，确认可配合 [`zhiliaohub_app v0.1`](https://github.com/z987645344-arch/zhiliaohub_app/tree/v0.1) 使用。
- 后续服务端或App任一端发生破坏性接口变更时，必须在本节更新对应的最低兼容版本。
- 本仓库与 `zhiliaohub_app` 各自独立打版本标签，不强行对齐版本号；两端的配对关系只通过本兼容性说明记录。

## 备份与恢复

备份包含SQLite一致性快照、`content/works/`、`content/notes/` 和 `uploads/`。归档内的 `manifest.json` 记录每个文件的路径、字节数与SHA-256；恢复前会逐项校验，归档中存在未声明文件也会拒绝恢复。

```powershell
# 创建备份；默认写入 backups/，只保留最近7份
npm run backup

# 恢复会替换数据库、正文和上传目录，必须先停止管理服务
npm run restore -- --archive backups/backup-YYYYMMDDTHHMMSSmmmZ.tar.gz --force
```

如在真实 `.env` 中提供至少16个字符的 `BACKUP_ENCRYPTION_PASSWORD`，新归档后缀为 `.tar.gz.enc`，使用scrypt派生密钥并以AES-256-GCM加密；恢复同样从环境变量读取密码，不接受命令行明文密码。`BACKUP_RETENTION_COUNT` 默认7，`BACKUP_DIR` 可指向服务器上的独立持久目录。

备份脚本可借助SQLite在线备份API取得有效数据库快照，但数据库、Markdown和上传目录无法形成跨文件系统事务。为获得单一一致恢复点，生产操作应先暂停后台写入，最好停止服务，再运行备份；恢复时必须停止服务，避免SQLite WAL或正在写入的文件与恢复结果冲突。当前只有本地备份与恢复，没有定时调度、异地副本或灾难恢复监控。

SQLite快照也包含备份时尚未过期的session记录。灾难恢复后如需强制注销所有旧会话，应更换为新的高强度 `SESSION_SECRET`，再启动服务；这会使旧Cookie签名全部失效。

部署片段及需要人工填写的占位项见 `deploy/README.md`；这些片段尚未合并进任何服务器配置。

## 测试

在 `admin-server/` 目录运行 `npm test`。当前 `tests/` 以独立用例或具名子用例覆盖：

- 未登录管理页面重定向与管理 API `401` 拦截。
- 错误/正确密码，以及首次 TOTP 绑定二维码、错误码和正确码。
- 已绑定 TOTP 的错误码、有效码和已使用验证码重放拒绝。
- session cookie 篡改后管理员身份失效。
- 未过期session在服务重启后保持登录，过期session失效且管理员身份被清理。
- 写接口缺失或使用错误 CSRF 令牌时拒绝写入。
- 认证失败按 IP 限流，且不会锁定唯一管理员账号。
- 作品与日记的新增、编辑、删除，以及 SQLite、Markdown与生成静态页面的一致性和旧详情页清理。
- 一次性迁移在隔离目录导入8个作品与3篇日记、保留知天特殊状态并拒绝重复执行。
- slug重名处理、元数据HTML转义、危险Markdown链接/原始HTML处理，以及发布不触碰首页、反馈页、CSS和JS。
- 同一作品和同一日记在单进程并发更新时串行执行，最终元数据与正文来自同一次写入。
- Markdown 原子替换前模拟中断时保留旧文件并清理临时文件。
- TOTP 密钥 AES-256-GCM 加解密往返，以及密文/认证标签篡改拒绝。
- 真实 PNG 上传成功；非白名单扩展名、伪造文件签名和超限文件分别被拒绝。
- 加密备份在原始SQLite、Markdown和上传数据被破坏后完整恢复，错误密码拒绝解密。
- 备份保留策略只留下最近N份归档。
- 配对码必须由密码+TOTP会话生成，且过期或重用均被拒绝。
- P-256设备正确签名登录、错误签名拒绝、挑战重放与过期拒绝。
- 设备吊销立即失效、重新配对恢复以及新设备自动替换旧设备。

当前测试不覆盖外部验证器设备的时钟差异、浏览器视觉、HTTPS/反向代理、真实容器运行、异地备份或多进程/多实例并发。现有 GitHub Actions 也不会安装后台依赖或执行 `npm test`；是否为后台建立独立 CI 需后续讨论。

## 当前边界

- 仅完成本地开发与部署前准备；Docker/代理片段尚未合并或启用，没有真实域名、HTTPS或部署操作。
- 会话已持久化到SQLite，仍只按单进程/单实例设计；必须把数据库挂载到持久卷并妥善保管 `SESSION_SECRET`。
- 内容版本历史与业务级回滚不在本服务内实现，未来依赖对Markdown和生成HTML的人工 Git 提交；单次发布写入失败只负责恢复发布前文件。
- 已有本地手动备份/恢复、校验和、可选加密与保留策略；仍没有自动调度、异地副本、备份监控或服务器恢复演练。
- 不包含知天代码，不共享知天账号、会话、数据库或部署配置。
- 不包含安卓App代码；`zhiliaohub_app` 将作为独立仓库开发，本仓库只维护服务端协议。
