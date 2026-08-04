# 知了hub 管理后台

`admin-server/` 是与根目录静态前台物理隔离的本地管理服务。它提供唯一管理员密码 + TOTP 登录、作品/日记元数据与 Markdown 正文管理、受限文件上传，以及实用优先的服务端 HTML 管理界面。

## 本地运行

1. 复制 `.env.example` 为 `.env`，填写真实随机值。
2. 使用 bcrypt 生成管理员密码哈希；只把哈希写入 `ADMIN_PASSWORD_HASH`。
3. 使用 32 字节随机数据的 Base64 表示填写 `TOTP_ENCRYPTION_KEY`。
4. 在本目录运行 `npm install`，再运行 `npm start`。
5. 浏览器访问 `http://127.0.0.1:3001/admin/login`。

可用 Node.js 生成本地配置素材：

```powershell
node -e "require('bcrypt').hash(process.argv[1], 12).then(console.log)" "在本机输入的初始密码"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

第一条命令会把密码留在当前终端历史中；更稳妥的做法是临时执行后清理历史，或自行使用不会记录输入的 bcrypt 工具。真实 `.env`、SQLite 数据库和上传文件都由仓库根目录 `.gitignore` 排除。

## 测试

在 `admin-server/` 目录运行 `npm test`。当前 `tests/admin-server.test.js` 以独立用例或具名子用例覆盖：

- 未登录管理页面重定向与管理 API `401` 拦截。
- 错误/正确密码，以及首次 TOTP 绑定二维码、错误码和正确码。
- 已绑定 TOTP 的错误码、有效码和已使用验证码重放拒绝。
- session cookie 篡改后管理员身份失效。
- 写接口缺失或使用错误 CSRF 令牌时拒绝写入。
- 认证失败按 IP 限流，且不会锁定唯一管理员账号。
- 作品与日记的新增、编辑，以及 SQLite 元数据与 Markdown 正文一致性。
- 同一作品和同一日记在单进程并发更新时串行执行，最终元数据与正文来自同一次写入。
- Markdown 原子替换前模拟中断时保留旧文件并清理临时文件。
- TOTP 密钥 AES-256-GCM 加解密往返，以及密文/认证标签篡改拒绝。
- 真实 PNG 上传成功；非白名单扩展名、伪造文件签名和超限文件分别被拒绝。

当前测试不覆盖外部验证器设备的时钟差异、浏览器视觉、HTTPS/反向代理、持久化会话、备份恢复或多进程/多实例并发。现有 GitHub Actions 也不会安装后台依赖或执行 `npm test`；是否为后台建立独立 CI 需后续讨论。

## 当前边界

- 仅用于本地开发和单进程验证，没有域名、HTTPS、反向代理或真实部署配置。
- 会话当前使用 `express-session` 的进程内存存储；Phase B 部署前必须选择持久化会话存储。
- 内容版本历史与回滚不在本服务内实现，未来依赖对 `content/` 的人工 Git 提交。
- 当前没有自动备份机制；数据库、Markdown 和上传文件需要在部署方案中统一设计备份与恢复。
- 不包含知天代码，不共享知天账号、会话、数据库或部署配置。
