# 知了hub 管理后台

`admin-server/` 是与根目录静态前台物理隔离的管理服务。它提供唯一管理员密码 + TOTP 登录、可选的已配对设备挑战应答登录、SQLite持久化会话、作品/日记元数据与 Markdown 正文管理、受限文件上传、本地备份/恢复，以及实用优先的服务端 HTML 管理界面。当前仍只完成本地开发与部署前准备，没有真实部署。

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
- 作品与日记的新增、编辑，以及 SQLite 元数据与 Markdown 正文一致性。
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
- 内容版本历史与回滚不在本服务内实现，未来依赖对 `content/` 的人工 Git 提交。
- 已有本地手动备份/恢复、校验和、可选加密与保留策略；仍没有自动调度、异地副本、备份监控或服务器恢复演练。
- 不包含知天代码，不共享知天账号、会话、数据库或部署配置。
- 不包含安卓App代码；`zhiliaohub_app` 将作为独立仓库开发，本仓库只维护服务端协议。
