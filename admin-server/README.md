# 知了hub 管理后台

`admin-server/` 是与根目录静态前台物理隔离的管理服务。它提供唯一管理员密码 + TOTP 登录、已配对设备挑战应答登录、SQLite持久化会话、作品/日记元数据与 Markdown 正文管理、保存即静态发布、反馈审核、小作坊、受限文件上传和备份/恢复，以及实用优先的服务端 HTML 管理界面。当前已随主站部署到 `https://zhiliaohub.com`；本节“本地运行”仍用于开发和隔离验证，生产更新方式见 `deploy/README.md`。

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

- 生成根目录 `works.html`、三个固定作品分类页、`notes.html`、`feedback.html` 及全部 `works-<slug>.html`、`notes-<slug>.html` 详情页。
- 使用 `src/templates/` 中的统一页面骨架和现有 `css/style.css`、`js/site.js`，访客访问生成页时不请求后台。
- 每个生成文件首行都有“此文件由知了hub后台自动生成，请勿手动编辑”标记；内容修改应通过管理后台，骨架修改应通过模板。
- 全量发布只清理带生成标记且已不在数据库中的详情页和受控作品媒体副本，不修改手写的 `index.html`、`tools.html`、`css/` 或 `js/`；`feedback.html` 本身属于生成目标。
- 标题首次创建时生成稳定slug，重名追加数字后缀；后续修改标题不会改变既有URL。
- 管理面板显示“已发布”状态、最近发布时间和当前作品/日记数量，并提供手动“重新全量发布”用于故障恢复。

原8个作品与3篇占位日记已经完成一次性迁移。迁移脚本默认只做只读预览；只应在空内容表、后台已停止且尚未执行过迁移时使用：

```powershell
npm run migrate-existing-content
node scripts/migrate-existing-content.js --apply --confirm-server-stopped
```

脚本会主动探测配置端口，后台仍在监听时拒绝执行；同时拒绝覆盖已有Markdown、拒绝非空内容表并记录迁移标记，不能作为日常导入工具重复运行。

“编辑作品重构”阶段一已为 `works` 增加封面、下载、体验链接、主媒体、辅图和版本日志共8个可空字段，并把现有作品分类一次性迁为“程序/影视/生活”枚举范围。当前真实数据为程序4条、影视4条、生活0条。阶段二已把这些字段接入独立作品表单：封面可拖动选区内部调整位置、拖动四角按16:9缩放，主媒体、多个辅媒体和ZIP可通过现有受保护上传接口写入，版本日志继续使用Markdown。后台CSP只为该原生表单脚本开放同源脚本，并只为本地图片裁剪预览额外开放 `blob:` 图片源，不允许内联或第三方脚本。

全量发布会把作品实际引用的后台上传文件复制到前台 `assets/works/covers/`、`assets/works/main/`、`assets/works/gallery/` 和 `assets/works/downloads/`，并清理不再被任何作品引用的前台副本；上传源文件保留在后台。阶段三已经把封面、主/辅媒体、版本日志以及按条目配置的下载/体验入口接入Steam风格前台模板。

2026-08-08 已在真实管理后台完成测试作品新增、媒体上传、裁剪封面、分类/媒体编辑和删除；数据库最终恢复8个作品/3篇日记，四个前台媒体目录清空，1280px与390px均无横向溢出或控制台错误。该人工结果不改变下方自动化测试与CI的覆盖边界。

## 上传边界

上传白名单包括JPEG、PNG、WebP、GIF、AVIF、PDF、Markdown、MP3、WAV、OGG、MP4、WebM和ZIP。服务同时检查扩展名、MIME与文件签名；ZIP接受 `application/zip` 或 `application/x-zip-compressed`，并要求PK文件头。

默认单文件上限统一为100MiB，可用 `UPLOAD_MAX_BYTES` 调低或调整。本阶段选择统一上限以覆盖开发期视频和压缩包，同时避免默认放宽到1GiB；按文件类型设置不同上限留待后续阶段实现。真实上传文件继续由 `.gitignore` 排除。

## 小作坊ZIP静态项目

已登录管理员可访问 `/admin/lab`，上传包含根目录 `index.html` 及配套网页资源的ZIP。服务会先扫描完整压缩包，拒绝绝对路径、盘符、`..` 路径穿越、符号链接、加密条目、非网页资源扩展名和缺少入口页的项目；默认最多500个ZIP条目、总解压后大小100MiB，并在实际解压时再次统计输出字节。通过校验后，项目进入 `lab-storage/<slug>/`，本地通过 `/lab/<slug>/` 只读访问。

后台可复制访问链接、切换是否显示在 `works.html` 底部，以及删除项目。显示状态变化与删除会触发全量发布；没有可见项目时不生成空的小作坊区块。真实项目目录由 `.gitignore` 排除，只保留 `lab-storage/.gitkeep`。

```dotenv
LAB_MAX_FILES=500
LAB_MAX_UNCOMPRESSED_BYTES=104857600
LAB_BASE_URL=http://localhost:3001/lab
# LAB_STORAGE_DIR=D:\absolute\persistent\lab-storage
```

`/lab` 路由在管理员session中间件之前挂载，响应不创建或更新session，并设置限制跨域连接、表单提交和框架嵌入的CSP。当前主站虽已上线，localhost同源测试仍无法证明小作坊真实子域名不会携带管理Cookie；启用独立子域名时应采用 `deploy/lab-subdomain.md` 中的独立Nginx静态server块，把 `LAB_BASE_URL` 改为真实HTTPS子域名，并确认管理员Cookie未配置父域 `Domain`。这项隔离效果仍属于生产部署待验收项，不能用本地测试结果代替。

## 反馈评论提交、后台审核与静态发布

`POST /api/feedback/comments` 无需登录和CSRF令牌，接受JSON或普通表单编码。接口只负责把留言写入SQLite审核队列，不提供公开读取接口，也不直接触发静态发布；公开内容由全量发布时生成到 `feedback.html`。

```json
{
  "parent_id": null,
  "author_name": "访客称呼",
  "author_email": "optional@example.com",
  "body": "留言正文",
  "website": ""
}
```

- `author_name` 必填，去除首尾空白后最多80个字符。
- `author_email` 可空；填写时必须是合理邮箱格式且不超过254个字符。
- `body` 去除首尾空白后为2至2000个字符。
- `parent_id` 可空；填写时必须指向一条已批准的顶层留言。待审核、已拒绝、不存在的留言以及已有回复都不能作为回复目标，因此评论最多两层。
- `website` 是后续前台表单使用的视觉隐藏蜜罐字段。只要有内容，接口仍返回普通 `202` 成功响应，但不会写入数据库。
- 所有真实写入记录一律为 `pending`，不会自动公开。成功响应不返回数据库ID，避免蜜罐响应与正常响应出现可探测差异。
- 请求按Express识别的客户端IP限流，默认每15分钟最多5次；IP同时写入记录，仅供限流与滥用追踪，不通过公开接口返回。

相关环境变量：

```dotenv
FEEDBACK_RATE_LIMIT_WINDOW_MS=900000
FEEDBACK_RATE_LIMIT_MAX=5
```

已登录管理员可访问 `/admin/feedback`。页面按顶层留言分组，并在主题下缩进展示其全部二层回复；默认筛选“含待审核内容的主题”，同时保留已通过的上下文。待审核内容可通过或拒绝，已通过内容可事后隐藏；管理员可对已通过的顶层留言以固定作者“站长”直接发布回复。所有写操作都要求管理员会话和CSRF令牌，且只更新SQLite；审核完成后需在管理面板执行全量发布，前台才会变化。

发布服务对反馈执行独立SQL查询，只选择 `status='approved'` 且只读取 `id/parent_id/author_name/body/created_at/is_admin_reply`。pending、rejected、邮箱和IP不会进入模板输入；生成页只显示已批准顶层留言及其已批准回复，管理员回复带“站长回复”标识。`feedback.html` 页面加载不发起读取请求，只有访客主动提交留言或回复时调用同源API。因此本地或生产部署必须让静态站点的 `/api/feedback/comments` 反向代理到本服务；正式环境必须使用HTTPS。

## 会话存储

登录会话保存在现有 `data/admin.sqlite3` 的 `sessions` 表，不再使用 `express-session` 默认的 MemoryStore。同一份 `SESSION_SECRET` 和数据库持久卷可使未过期会话在服务重启后继续有效；过期记录会在读取时及周期清理时失效。Cookie继续使用 `httpOnly`、`SameSite=Strict`，生产环境启用 `secure`。

- `SESSION_MAX_AGE_MS`：会话与Cookie有效期，默认8小时。
- `SESSION_CLEANUP_INTERVAL_MS`：后台清理过期记录的间隔，默认15分钟。
- 更换 `SESSION_SECRET` 会使已有签名Cookie失效；更换前应把它视为主动注销所有会话的运维操作。

## 设备配对与挑战应答登录

设备登录是密码+TOTP之外的第二种登录入口，不替代原流程。首次配对或更换设备仍必须先通过密码+TOTP登录网页后台，在 `/admin/device` 手动生成配对码。本仓库只提供服务端接口；配套安卓App已在独立仓库 `zhiliaohub_app` 中实现并持续维护。

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
- 当前已完成真实设备联调，确认可配合 [`zhiliaohub_app v0.3`](https://github.com/z987645344-arch/zhiliaohub_app/tree/v0.3) 使用；v0.3包含prod/qa双构建变体与只读网络请求容错，未改变设备认证协议。
- 后续服务端或App任一端发生破坏性接口变更时，必须在本节更新对应的最低兼容版本。
- 本仓库与 `zhiliaohub_app` 各自独立打版本标签，不强行对齐版本号；两端的配对关系只通过本兼容性说明记录。

## 备份与恢复

> 这一章是写给"很久以后、已经完全不记得这个项目怎么做的自己"看的。默认你不记得任何技术细节，所以从最直白的说明开始。

### 先看这里：我只想把数据恢复到最近一次正常状态

三步，照抄就行：

1. **先把网站后台停掉**（很重要，见下面"为什么必须先停"）。如果它是在某个终端窗口里跑着的，切到那个窗口按 `Ctrl + C`；如果是用 Docker 跑的，运行 `docker stop <容器名>`。
2. 打开终端，进入本项目的 `admin-server` 目录。
3. 先看有哪些备份文件，再挑最新的那个恢复：

```powershell
# 列出所有备份文件，名字里的数字就是备份时间（越大越新）
ls backups

# 把下面这行的文件名换成你刚才看到的、最新的那个 backup-开头的文件
npm run restore -- --archive backups/backup-20260811T215253573Z.tar.gz --force --confirm-service-stopped
```

看到类似这样的输出就是成功了：

```
恢复前快照已创建：...\backups\pre-restore-20260812T010203456Z.tar.gz
如果本次恢复选错了归档，可用上面这份快照退回恢复前的状态。
恢复完成；备份创建时间：2026-08-11T21:52:53.573Z
已校验文件数：5
注意：该备份按策略未包含 1 个 ZIP 文件；恢复后相关下载记录会暂时缺少文件。
待补齐：uploads/<时间戳>-<uuid>.zip（<字节数> 字节，SHA-256 <校验值>）
```

如果出现“待补齐”，先按输出或归档内 `manifest.json` 的 `excluded` 数组，从本地找到对应ZIP，以清单里的路径名放回 `uploads/`，并核对大小和SHA-256；然后再重新启动后台（`npm start`，或 `docker start <容器名>`）。没有待补齐条目时可直接启动。

如果输出里出现"恢复失败"，**先不要重复运行**，跳到下面的"恢复失败了怎么办"。

### 几个名词的意思

| 名词 | 是什么 |
|------|--------|
| 后台 / 管理服务 | `admin-server/` 里那个需要一直运行的程序，用来写文章、传图片、发布网页。访客看的静态网页不需要它运行 |
| SQLite / 数据库 | 一个叫 `admin.sqlite3` 的**单个文件**，存着作品和日记的标题、日期、分类，以及登录状态等 |
| Markdown 正文 | 文章的正文，以 `.md` 纯文本文件存在 `content/` 目录里，不在数据库里 |
| 上传文件 | 你传过的图片、视频、ZIP 等，存在 `uploads/` 目录；默认全部进入备份内容 |
| 归档 / 备份文件 | 一个 `.tar.gz` 压缩包，默认包含数据库、正文和全部上传；启用ZIP排除时，被排除ZIP只在 `manifest.excluded` 留存路径、大小与SHA-256 |
| 恢复 | 用某个归档里的内容，**覆盖**掉现在的数据库、正文和上传文件；若归档列出排除项，再按清单从本地补回ZIP |
| 恢复前快照 | 恢复动作开始前，系统自动把“当前”数据也按同一配置打包；仅在启用ZIP排除时不含ZIP内容 |

**备份默认包含ZIP；如需排除，设置 `BACKUP_EXCLUDE_ZIP=true`，此时恢复后需由用户从本地补齐，清单见 `manifest.excluded`。一份“静默地少了东西”的备份比没有备份更危险。**因此创建和恢复命令都会明确打印排除数量；启用排除后不要忽略“待补齐”提示，也不要把该归档单独当成完整下载资源库。

### 备份文件可能在哪几个地方

| 位置 | 说明 |
|------|------|
| `admin-server/backups/` | 主要位置。手动备份、自动定时备份、恢复前快照都写在这里 |
| `BACKUP_MIRROR_DIR` 指向的目录 | **可选**。如果 `.env` 里设置了这一项，每份备份会再复制一份到那里。⚠ 目前它只能是**同一台机器上的另一个目录**，详见下面"关于异地备份的重要提醒" |
| 真正的远程存储 | **目前还没有**。将来接入后需要回来更新这一段 |

文件名的两种前缀：

- `backup-<时间戳>.tar.gz` —— 正常备份（手动或定时产生的）。**一般你要找的就是这种。**
- `pre-restore-<时间戳>.tar.gz` —— 恢复前快照。只有在"上一次恢复选错了、想退回去"时才用它。

时间戳格式是 `年月日T时分秒毫秒Z`，用的是 UTC 时间（比北京时间早 8 小时）。例如 `20260811T215253573Z` 是 UTC 2026-08-11 21:52:53，对应北京时间 8 月 12 日 05:52。**排序时直接按文件名比大小就行，越大越新。**

### 为什么必须先停掉后台

后台运行时会持续往数据库和文件里写东西。如果一边写一边恢复，可能出现"恢复了一半、又被新写入覆盖"的混乱状态，恢复结果不可信。所以恢复前必须停止服务。

恢复命令要求显式写出 `--confirm-service-stopped`，表示操作者已经停服；**这个参数只是声明，不是证据**。恢复器仍会在创建恢复前快照和覆盖任何数据之前按 AND 关系完成三项实际探测：

1. `RESTORE_PROBE_URL` 指向的**本机 Nginx** `/health` 返回明确的 502/503/504 上游不可用状态；
2. 当前 SQLite 不存在 `-shm` WAL共享内存文件；
3. 当前 SQLite 可以取得独占写锁。

三项缺一不可，不是任一通过即可。连接失败、DNS/TLS错误或超时只说明探测本身失效，**绝不等于后台已停止**。`RESTORE_PROBE_URL` 必须在 `admin-server/.env` 里显式配置为本机 hub Nginx 的回环 HTTP 地址，例如 `http://127.0.0.1:<后端端口>/health`；它**不得指向 gateway**，因为 gateway 是哑代理，其自身故障返回非 200 不能证明 admin-server 已停止。只允许 `localhost` 或本机网卡上的IP字面量，**禁止填写公开域名**。迁移期间公开域名可能仍指向旧机器，旧机返回200会让恢复被拒绝并把排查方向带错。

如果 `-shm` 是异常退出后残留的，守卫会选择安全侧误报并拒绝恢复。不要为了绕过守卫直接删除 `-shm` 或 `-wal`；先确认所有容器和数据库进程都已停止，并检查WAL恢复状态。

（备份则不强制停服务：备份用的是 SQLite 官方的在线备份接口，能拿到一个自洽的数据库快照。但数据库、正文和上传文件三者无法保证是同一瞬间的，所以**要一个绝对严格一致的恢复点，最好也停服务再备份**。）

### 恢复失败了怎么办

失败时不会修改任何数据，可以放心排查。常见几种：

- **`Restore aborted: the pre-restore snapshot could not be created ...`**
  它没能先给当前数据做后悔药，所以拒绝继续。通常是磁盘满了或 `backups/` 目录不可写。先清理磁盘空间或修权限，再重试。
- **`Restore aborted: RESTORE_PROBE_URL ...`**
  未配置本机Nginx探测地址、误填公开域名/远端地址、健康路由仍返回200，或请求本身连接失败。若正在迁移，先确认该地址解析到的是本机而不是旧机器；只有本机Nginx明确返回502/503/504才满足第一道判据。
- **`Restore aborted: SQLite WAL shared-memory file ... still exists`**
  仍有空闲WAL连接，或异常退出留下了需要人工检查的`-shm`。停止所有数据库使用者并检查WAL状态，不要直接删文件绕过。
- **`Restore aborted: SQLite exclusive-lock probe ...`**
  当前数据库仍无法取得独占写锁，通常表示后台或其他程序还持有写事务。停止后台并关闭所有连接到该 SQLite 文件的进程，再重试。
- **`Restore aborted: the current database at ... exists but could not be inspected ...`**
  当前那个数据库文件在，但读不出来——这本身就说明**现在的数据可能已经损坏了**，需要你亲自看一眼再决定，所以系统不会自作主张覆盖它。
- **`Restore aborted: ... is not a regular file`**
  数据库该在的位置上放着的不是一个普通文件（比如是个目录），多半是路径配置错了。
- **解密相关的报错**（`bad decrypt` / `unable to authenticate data`）
  这份归档是加密的，而 `.env` 里的 `BACKUP_ENCRYPTION_PASSWORD` 不对或没填。密码只能从 `.env` 读，不能写在命令行里。

**万不得已的强制恢复**：如果当前数据库真的已经彻底损坏、连快照都做不出来，而你确认不再需要现在这份数据，可以跳过安全网：

```powershell
npm run restore -- --archive backups/backup-20260811T215253573Z.tar.gz --force --confirm-service-stopped --skip-pre-restore-snapshot --confirm-no-pre-restore-snapshot
```

`--skip-pre-restore-snapshot` 与 `--confirm-no-pre-restore-snapshot` **必须成对出现**，只给其中一个都会在探测或覆盖数据前被拒绝。它们与 `--confirm-service-stopped` 相互独立：确认停服不代表可以跳过快照，确认跳过快照也不代表服务已经停止；本机 Nginx 健康地址、SQLite `-shm` 与独占锁三道探测仍会照常执行。双参数生效时命令会显著警告：**本次恢复没有回退点，恢复失败或选错归档后无法通过恢复前快照回滚。**

全新机器上数据库尚不存在时，恢复器会自动判定没有可保护的旧状态并跳过快照，不需要、也不应额外提供这两个跳过参数。这是正常迁移路径，不属于上面的人工放弃保护。

### 新机器首次恢复的必需顺序

生产Compose的Nginx使用静态上游名 `admin-server:3001`，并且首次启动依赖后台先通过健康检查。因此新机器不能在整套服务从未启动过时直接执行恢复，必须按以下顺序操作：

1. 配好两层`.env`和持久目录，确认`RESTORE_PROBE_URL`指向**本机自己的Nginx**，不是公开域名。
2. 构建并启动完整Compose栈，等`admin-server`与Nginx均健康；这一步让Nginx完成静态上游解析。
3. 单独执行 `docker compose stop admin-server`，保持Nginx继续运行。
4. 确认本机Nginx的`/health`返回502/503/504，再从宿主机执行上面的恢复命令。
5. 恢复成功后执行 `docker compose start admin-server`，再完成健康、数据和静态页面检查。

不得因为是新机器而跳过停服探测。若Nginx自身未运行、探测地址无法连接，恢复器会按失败关闭拒绝继续。

### 进阶：恢复到某个更早的版本 / 选错了想退回

想恢复到更早的版本，就把命令里的文件名换成更早的那个 `backup-` 文件，其余步骤完全一样。

如果恢复完发现**选错了版本**（比如误选了一个太旧的归档，把新数据覆盖了），不用慌：每次恢复前系统都自动存了一份"恢复前快照"。回到刚才那次恢复的输出里，找到 `恢复前快照已创建：` 后面的路径，用它再恢复一次，就能退回到你执行那次错误恢复之前的状态：

```powershell
npm run restore -- --archive backups/pre-restore-20260812T010203456Z.tar.gz --force --confirm-service-stopped
```

如果输出已经翻不到了，直接在 `backups/` 里找时间戳最新的 `pre-restore-` 文件，通常就是它。

这些快照有独立的保留数量（`PRE_RESTORE_RETENTION_COUNT`，默认保留 3 份），常规备份的"只保留最近 N 份"清理策略**不会**把刚生成的快照删掉，两者互不挤占。

### 自动备份

后台服务运行时，会在自己进程内定时做备份，不依赖操作系统的计划任务（这样在容器里跑也是同样的行为）。

- 默认在每日 **UTC+8 00:00** 触发，写到 `backups/`，和手动 `npm run backup` 产生的文件完全一样。UTC+8是代码中的固定偏移，不读取宿主机或容器的 `TZ`，因此UTC容器不会误在北京时间08:00触发。
- **空目录立即保护**：服务启动时如果没有任何常规备份，会立刻创建一份，不等待下一个零点。
- **同一调度日重启不重复**：服务以“最近一个UTC+8目标时刻之后是否已有常规归档”为判据，反复重启只读取目录，不创建额外状态文件，也不会被手动备份时间重新推迟24小时。
- 相关配置：`BACKUP_SCHEDULE_ENABLED`（默认 `true`）、`BACKUP_SCHEDULE_LOCAL_TIME`（默认 `00:00`，24小时制 `HH:MM`，始终按UTC+8解释）。旧的 `BACKUP_INTERVAL_MS` 和 `BACKUP_SCHEDULE_CHECK_INTERVAL_MS` 已移除，不再表示任何有效配置。
- 备份失败时会在服务日志里打印以 `[backup]` 开头的错误，并明确写出"现在没有产生新的备份"。**如果你在日志里看到这类信息，说明备份已经停摆了，需要处理。**

### ⚠ 关于"异地备份"的重要提醒

`BACKUP_MIRROR_DIR` 这个功能，**目前只是本地模拟，不是真正的异地容灾**。

它做的事情只是：备份生成后，再复制一份到同一台机器上的另一个目录。这验证了"生成备份 → 自动同步到第二个位置"这条链路本身是通的，但**服务器整机损坏、磁盘报废、机房出事的时候，主备份和这份副本会一起消失**。

真正要防单点故障，必须接入真实的远程存储（比如腾讯云 COS 或另一台机器），那部分**尚未实现、也尚未验证**。代码上已经预留了接口（`src/services/backup-destination.js`），将来加真实远程存储时只需实现同一个接口，不用改动调用方；但在那之前，请不要认为异地备份已经做好了。

### 加密（可选）

如果 `.env` 里设置了至少 16 个字符的 `BACKUP_ENCRYPTION_PASSWORD`，新归档会以 `.tar.gz.enc` 结尾，使用 scrypt 派生密钥 + AES-256-GCM 加密。恢复时同样从 `.env` 读密码，**不接受命令行明文密码**。

⚠ 密码丢了，加密备份就永远打不开了。请把它和 `.env` 里的其他密钥一起妥善保管在密码管理器里。

### 技术细节与已知边界

- 一份备份默认包含：SQLite 一致性快照、`content/works/`、`content/notes/`、`uploads/` 全部文件和 `lab-storage/` 中已完成的小作坊项目。`.pending-*`、`.deleted-*` 瞬时目录不会入包，也不会混入只供上传ZIP排除使用的 `manifest.excluded`。设置 `BACKUP_EXCLUDE_ZIP=true` 后，格式2的 `manifest.json` 在 `files` 中记录入包文件，在 `excluded` 中记录未入包ZIP；两类都包含相对路径、字节数与SHA-256。恢复器兼容格式1旧归档；对格式2会校验排除项只能位于 `uploads/` 且扩展名为ZIP，归档里实际夹带排除项或出现其他未声明文件都会拒绝恢复。
- `BACKUP_RETENTION_COUNT` 默认 3；`BACKUP_DIR` 可指向服务器上的独立持久目录。`PRE_RESTORE_RETENTION_COUNT` 默认仍为3，与常规备份独立计数。
- 小作坊单项目默认最多500个ZIP条目、解压后100MiB；常规备份保留3份，因此一个达到上限且难以压缩的项目最多可使常规备份总占用增长约300MiB。应随小作坊使用量监控 `BACKUP_DIR` 和副本目的地容量。
- 本能力上线前生成的旧归档没有 `lab-storage/`，无法凭空恢复当时的小作坊文件；恢复器仍可读取这些归档，并保留目标机现有的 `lab-storage/`。如果刚恢复的数据库里仍有小作坊记录，命令会按实际行数警告这些记录对应的文件没有被恢复。只有本能力启用后新生成并验证过的归档才构成小作坊恢复来源。
- SQLite 快照里也包含备份时尚未过期的登录会话记录。灾难恢复后如果想强制注销所有旧登录，换一个新的高强度 `SESSION_SECRET` 再启动服务即可，旧 Cookie 会全部失效。
- 目前没有备份成功/失败的外部告警，也没有做过服务器级别的灾难恢复演练。

正式生产部署以根目录 `docker-compose.yml` 与 `deploy/nginx.conf` 为仓库基线；两层环境变量、独立公开站点目录、权限要求、日常更新和重新部署流程见 `deploy/README.md`。真实服务器上的IP、域名、证书路径、持久目录和密钥只保存在现场配置中，不进入仓库。

## 测试

在 `admin-server/` 目录运行 `npm test`。当前 `tests/` 以独立用例或具名子用例覆盖：

- 未登录管理页面重定向与管理 API `401` 拦截。
- 错误/正确密码，以及首次 TOTP 绑定二维码、错误码和正确码。
- 已绑定 TOTP 的错误码、有效码和已使用验证码重放拒绝。
- session cookie 篡改后管理员身份失效。
- 未过期session在服务重启后保持登录，过期session失效且管理员身份被清理。
- 写接口缺失或使用错误 CSRF 令牌时拒绝写入。
- 认证失败按 IP 限流，且不会锁定唯一管理员账号。
- 作品与日记的新增、编辑、删除，以及 SQLite、Markdown与生成静态页面的一致性和旧详情页清理；作品分类只接受程序/影视/生活，详情页简介必填。
- 旧 works 表补齐8个可空字段、真实旧分类映射到新枚举，以及一次性迁移标记防止重复执行。
- 一次性迁移在隔离目录导入8个作品与3篇日记、保留知天特殊状态并拒绝重复执行。
- slug重名处理、元数据HTML转义、危险Markdown链接/原始HTML处理，以及发布不触碰首页、反馈页、CSS和JS。
- 同一作品和同一日记在单进程并发更新时串行执行，最终元数据与正文来自同一次写入。
- Markdown 原子替换前模拟中断时保留旧文件并清理临时文件。
- TOTP 密钥 AES-256-GCM 加解密往返，以及密文/认证标签篡改拒绝。
- 真实 PNG 与带PK文件头的ZIP上传成功；非白名单扩展名、伪造文件签名和超限文件分别被拒绝。
- 独立作品表单包含全部媒体/下载字段，浏览器脚本可独立解析并只使用原生Canvas、Fetch和现有CSRF上传接口。
- 作品全部新字段新增/编辑后可从上传目录发布到四个前台媒体目录，替换或删除引用后会清理失效的前台副本；前台模板按作品数据条件引用封面、主媒体、辅图与下载文件。
- 加密备份在原始SQLite、Markdown和上传数据被破坏后完整恢复，错误密码拒绝解密。
- 同一上传池含ZIP和非ZIP时，默认配置确认ZIP实际入包且 `manifest.excluded` 为空；启用 `BACKUP_EXCLUDE_ZIP` 后确认ZIP内容不入包但路径、大小、SHA-256进入 `manifest.excluded`，恢复返回明确补齐提示，并验证格式2恢复器继续兼容格式1旧清单。
- 小作坊项目的 `index.html` 在备份后被真实删除，再经恢复重新出现在磁盘并可从 `/lab/<slug>/` 取得相同内容；`.pending-*`、`.deleted-*` 瞬时目录不进入归档，SQLite、作品/日记Markdown和普通上传文件在同一往返中继续正常恢复。
- 默认备份保留策略连续生成4份后只留下最近3份归档。
- 恢复前自动创建快照；误选旧归档后可用该快照退回，作品标题/摘要、Markdown正文与上传文件内容逐项核对一致。
- 恢复前快照创建失败时中止恢复，SQLite、Markdown与上传文件全部保持原样。
- 恢复前快照使用独立保留数量，不会被常规备份的“最近N份”清理，其自身超出数量时才淘汰最旧的一份。
- 目标环境尚无数据库时跳过恢复前快照并正常完成恢复，且不产生多余快照。
- 人工跳过恢复前快照时，`--skip-pre-restore-snapshot` 与 `--confirm-no-pre-restore-snapshot` 缺一即拒绝；两者齐全才执行并显著声明没有回退点，且不替代停服确认。
- 停服探测要求本机Nginx明确返回上游失败、`-shm`不存在及SQLite独占锁成功三项同时成立；公开域名、远端健康服务、连接失败、空闲WAL连接和残留`-shm`均拒绝恢复。
- "数据库文件不存在"与"文件存在但读不出来"被区分处理：前者跳过快照，后者中止恢复并明确报错。
- 定时备份目录为空时立即创建；同一UTC+8调度日模拟重启3次仍只有一份；UTC+8次日00:00（UTC前一日16:00）创建第二份，并直接断言运行时计时器瞄准该UTC时刻而非容器本地零点。
- 定时备份失败时记录明确日志并说明"现在没有产生新的备份"，且不抛出、不静默。
- 备份生成后被复制到模拟异地目录，该副本可在本地备份目录整个丢失后独立完成恢复。
- 副本同步失败时如实报告，本地归档保持完整且仍可完成真实恢复。
- 模拟异地目录按同一保留策略清理，`LocalMirrorDestination` 不修改也不删除传入的本地归档。
- 配对码必须由密码+TOTP会话生成，且过期或重用均被拒绝。
- P-256设备正确签名登录、错误签名拒绝、挑战重放与过期拒绝。
- 设备吊销立即失效、重新配对恢复以及新设备自动替换旧设备。
- 公开反馈的顶层留言与已批准留言回复进入pending审核队列；蜜罐静默丢弃、按IP限流、非法回复层级和字段边界均被拒绝。
- 反馈后台按主题显示上下文，支持通过、拒绝、事后隐藏和管理员直接回复；验证旧库字段升级、未登录/CSRF拦截及禁止三层回复，并确认审核过程不修改前台文件或发布状态。
- 反馈静态发布只读取approved公开列；待审/拒绝正文、邮箱和IP不进入源码，空状态、顶层/二层结构与站长标签正确；前端对正常/蜜罐202统一显示等待审核，并清晰展示字段、网络和429错误。
- 小作坊真实multipart上传、管理员/CSRF拦截、含显式目录的HTML/CSS/JS/图片ZIP解压、作品页显隐和删除清理；路径穿越、超限解压和PHP文件在写出前拒绝，`/lab` 响应不创建session或设置Cookie并带受限CSP。

当前自动化测试不覆盖外部验证器设备的时钟差异、浏览器视觉与原生裁剪拖拽的真实交互、真实小作坊子域名Cookie隔离、生产HTTPS/反向代理回归、异地备份或多进程/多实例并发。主站、登录页和健康接口已在生产域名实际可达，但这不等于上述边界都有自动化覆盖。现有 GitHub Actions 也不会安装后台依赖或执行 `npm test`；是否为后台建立独立 CI 需后续讨论。

## 当前边界

- 后台已通过根目录Compose/Nginx基线部署到真实HTTPS域名；代码或依赖更新后仍必须在服务器显式重建镜像，不能把 `docker compose up -d` 当作自动更新代码。
- 会话已持久化到SQLite，仍只按单进程/单实例设计；必须把数据库挂载到持久卷并妥善保管 `SESSION_SECRET`。
- 内容版本历史与业务级回滚不在本服务内实现，未来依赖对Markdown和生成HTML的人工 Git 提交；单次发布写入失败只负责恢复发布前文件。
- 已有本地手动备份/恢复、校验和、可选加密、保留策略、恢复前自动快照与进程内定时备份；仍没有**真实**异地副本、备份成功/失败告警或服务器级灾难恢复演练。
- 上传ZIP默认进入常规备份和恢复前快照；只有设置 `BACKUP_EXCLUDE_ZIP=true` 时才由用户在本地另行保存，届时新manifest会留存补齐所需的原路径、大小和SHA-256，恢复后必须按提示人工补齐。
- 恢复前快照只防"选错归档版本"和"恢复中途失败"，它与常规备份写在同一个 `BACKUP_DIR`；整个目录或整块磁盘损坏时两者会一起丢失。
- `BACKUP_MIRROR_DIR` 目前只能指向同一台机器上的另一个目录，是**模拟**而非真正的异地容灾；接入真实远程存储前，服务器整机损毁仍会同时失去主备份与副本。
- `lab-storage/` 已随常规备份和恢复前快照归档并可直接还原，但仍缺少真正异地副本、容量告警和服务器级恢复演练。
- 不包含知天代码，不共享知天账号、会话、数据库或部署配置。
- 不包含安卓App代码；`zhiliaohub_app v0.3` 在独立仓库维护，本仓库只维护服务端协议与最低兼容说明。
