# 知了hub 生产部署与运维说明

知了hub 已使用真实域名和 HTTPS 上线，当前公开主站为 `https://zhiliaohub.com`。本文件不再是“未来部署片段”，而是以下场景的共同基线：

- 理解当前生产 Compose/Nginx 拓扑；
- 把已提交代码更新到现有服务器；
- 重新构建或迁移服务器；
- 灾难恢复后重建运行环境；
- 核对仍未完成的生产安全与容灾事项。

仓库中的配置只描述可公开的拓扑，不保存服务器真实IP、宿主路径、证书路径或密钥。生产现场值只存在于服务器未纳入Git的两层 `.env` 和宿主机目录中。

## 当前生产基线

- 根目录 `docker-compose.yml`：构建 `admin-server`，运行官方 Nginx，并定义持久挂载、内部网络和健康检查。
- 根目录 `.env.example`：Compose拓扑变量模板；服务器上的根目录 `.env` 保存真实现场值。
- `deploy/nginx.conf`：HTTPS、静态前台、后台反代与小作坊独立主机名模板。
- `admin-server/.env.example`：Node后台业务配置与密钥模板；服务器上的 `admin-server/.env` 保存真实值。
- `admin-server/Dockerfile`：Node 22 非root多阶段后台镜像。
- `admin-server/deploy/lab-subdomain.md`：小作坊独立子域名的额外安全与验收要求。

生产 Compose 强制设置 `NODE_ENV=production`、`HOST=0.0.0.0`、`PORT=3001`、`TRUST_PROXY_HOPS=1` 和各容器路径。`NODE_ENV=production` 同时控制 Secure session Cookie，以及 `/health` 的 `deployment: production` 标识。

## 两层 `.env` 不可混用

### 1. 仓库根目录 `.env`

根目录 `.env` 由 Docker Compose 解析，来自根目录 `.env.example`，真实文件被 `.gitignore` 排除。它只保存部署拓扑参数：

- `SERVER_PUBLIC_IP`、HTTP/HTTPS宿主端口；
- 主站/后台共用的 `SERVER_NAME` 与小作坊的 `LAB_SERVER_NAME`；
- TLS证书和私钥在宿主机上的路径；
- 五个后台持久目录和独立静态站点目录的宿主机路径；
- Nginx上传上限与镜像标签。

这里**不要**填写管理员密码哈希、session密钥、TOTP密钥或备份加密密码。

### 2. `admin-server/.env`

该文件由Node容器通过Compose的 `env_file` 读取，来自 `admin-server/.env.example`，同样不入Git。它保存：

- `ADMIN_PASSWORD_HASH`；
- `SESSION_SECRET`；
- `TOTP_ENCRYPTION_KEY`；
- 可选的 `BACKUP_ENCRYPTION_PASSWORD`；
- 认证、反馈、上传、小作坊和备份策略参数；
- `LAB_BASE_URL`。

`docker-compose.yml` 对这个文件声明 `format: raw`，用于关闭Compose变量插值。**不要去掉它**：bcrypt 哈希中的 `$` 会被Compose当成变量引用，插值后哈希会损坏，后台会以 `ADMIN_PASSWORD_HASH must be a bcrypt hash.` 启动失败。这里的 `$` 按原值保存，不需要写成 `$$`。

Compose中的 `environment` 会覆盖该文件里的运行拓扑值，避免现场 `.env` 把生产容器改回开发监听或错误路径。`BACKUP_MIRROR_DIR` 当前仍只是同机副本模拟；若启用，必须增加独立持久挂载，且不能描述为真实异地容灾。

## 持久目录与权限

根目录 `.env` 中的以下路径必须指向宿主机持久目录：

- `ADMIN_DATA_PATH` → 容器 `/app/data`
- `ADMIN_CONTENT_PATH` → 容器 `/app/content`
- `ADMIN_UPLOADS_PATH` → 容器 `/app/uploads`
- `ADMIN_BACKUPS_PATH` → 容器 `/app/backups`
- `ADMIN_LAB_STORAGE_PATH` → 容器 `/app/lab-storage`
- `SITE_ROOT_PATH` → 后台读写 `/app/site`，Nginx只读 `/usr/share/nginx/html`

后台镜像以非root `node` 用户运行。服务器部署或迁移时应从实际镜像核对UID/GID，并赋予上述目录最小必要权限；不能使用全员可写来回避属主问题。

`SITE_ROOT_PATH` 必须是**只包含公开前台文件的独立目录**，绝不能指向整个Git仓库，否则源码、文档或现场配置可能被Nginx当作静态文件暴露。它应包含：

- `index.html`、`works*.html`、`notes*.html`、`feedback.html`、`tools.html`；
- `assets/`、`css/`、`js/`。

**这个目录不会随 `git pull` 更新。** 每次改动前台文件（含新增图片、字体等任何
资源）后，都必须把它们单独复制到该目录，具体见「现有服务器的日常代码更新」下
的「前台静态资源必须单独同步到站点根」。

`ADMIN_CONTENT_PATH` 是运行时Markdown目录。新服务器如果不是从备份恢复，应先复制仓库中的初始 `admin-server/content/`；空bind mount会遮住镜像内随附内容。

## Nginx路由与代理信任

`deploy/nginx.conf` 由官方Nginx镜像作为模板读取。`NGINX_ENVSUBST_FILTER` 只允许替换 `SERVER_NAME`、`LAB_SERVER_NAME` 和上传上限，避免 `$host`、`$remote_addr`、`$scheme` 等原生Nginx变量被误替换。

主站主机名下：

- 80端口跳转HTTPS；
- `/admin`、`/api`、`/uploads`、`/health` 反代到 `admin-server:3001`；
- 其他路径从只读公开站点目录直接伺服；
- 代理发送 `Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto`。

后台只信任紧邻它的一层Nginx代理（`TRUST_PROXY_HOPS=1`）。生产session Cookie带 `Secure`，因此代理必须终止TLS并正确传递 `X-Forwarded-Proto=https`；直接用纯HTTP访问后台不能作为生产登录方式。

### 真实客户端IP还原（Cloudflare网段列表**需人工维护**）

实际请求链是 **访客 → Cloudflare → Nginx → admin-server**，不止Nginx一层。Cloudflare会向源站发 `CF-Connecting-IP: <访客IP>`，但Nginx自身看到的 `$remote_addr` 是Cloudflare边缘IP。因此 `deploy/nginx.conf` 在文件顶部、第一个 `server` 块之前（即http级，三个 `server` 块一次生效）配置了Cloudflare官方网段的 `set_real_ip_from` 与 `real_ip_header CF-Connecting-IP`，把 `$remote_addr` 还原为真实访客IP；转发出去的 `X-Forwarded-For` 末位随之也是访客IP，所以 `TRUST_PROXY_HOPS` 仍然**保持1、不要改成2**（改层数是盲信XFF，直连源站伪造该头即可绕过限流）。

缺少这段配置时不会报错也不会崩溃，只是静默算错：登录、TOTP、设备认证和留言提交四个限流器都按 `req.ip` 分桶，会退化成按Cloudflare边缘节点分桶，一个访客触发限流可能连累同边缘节点的其他访客，`feedback_comments` 记录的IP也失去取证价值。

`set_real_ip_from` 的网段必须逐条限定，**绝不能写 `0.0.0.0/0`**：本站源站可以被直连，Cloudflare不是唯一入口。无条件信任 `CF-Connecting-IP` 等于允许任何人直连源站伪造该头、绕过全部按IP的限流。限定网段后，非Cloudflare来源发来的该头会被忽略。

⚠️ **这份网段列表需要人工维护**，仓库内的版本取自 2026-08-17（IPv4 15条 + IPv6 7条），更新来源只有这两个官方URL：

- IPv4：<https://www.cloudflare.com/ips-v4>
- IPv6：<https://www.cloudflare.com/ips-v6>

Cloudflare偶尔增删网段。列表过期的失败模式是「新网段来的请求退回记成CF边缘IP」——只影响限流精度，属优雅降级、不会中断服务，因此刻意没有做成容器启动时联网拉取（那会给启动引入网络依赖）。修改该列表后需在服务器执行 `nginx -t`，通过后再重建或重载Nginx容器才会生效。生效证据以Nginx日志中的来源IP由Cloudflare段变为真实访客IP为准。

> 该配置为 2026-08-17 新增，仓库内仅完成静态审阅与网段逐条核对；在服务器拉取并重载Nginx之前，线上仍按Cloudflare边缘IP限流。

小作坊主机名使用独立Nginx `server` 块，直接只读访问 `ADMIN_LAB_STORAGE_PATH`，不代理到Node，并附加受限CSP等响应头。证书必须覆盖主站和小作坊两个主机名。真实小作坊子域名的Cookie隔离仍需按 `lab-subdomain.md` 单独验收。

## 本机 Compose 验证

在开发机上跑一遍完整的 Compose，把 nginx 配置、TLS、路由、响应头和编排关系提前验一遍。
在这套流程之前，这些东西**要到服务器才第一次真实运行**——此前两个证书问题（挂载方式
写错、`standalone` 占不到 80 端口）都是这样漏到线上的。

**核心约束：本机与服务器共用同一份 `docker-compose.yml` 和同一份 `deploy/nginx.conf`，
只换 `.env`。** 不要新建 `docker-compose.local.yml`、`docker-compose.override.yml` 或本机
专用的 nginx 配置——那会制造第二个真相源，本机验的就不再是生产要跑的东西。Compose 已
把全部可变项外置成环境变量，因此不需要第二份文件。

### 前置：Docker Desktop 必须已启动

这一步是 GUI 操作，需要人工完成。确认守护进程就绪：

```bash
docker version --format 'Server: {{.Server.Version}}'
```

拿不到 Server 版本就是守护进程没起，先去启动 Docker Desktop，不要尝试用命令行拉起它。

### 启动步骤

```bash
cp .env.local.example .env.local
sh deploy/generate-local-tls.sh
mkdir -p runtime/admin-data runtime/admin-content runtime/admin-uploads \
         runtime/admin-backups runtime/lab-storage runtime/site
cp -r admin-server/content/. runtime/admin-content/
cp index.html tools.html runtime/site/ && cp -r assets css js runtime/site/
docker compose --env-file .env.local config --quiet
docker compose --env-file .env.local up -d --build
```

几点说明：

- `.env.local` 与整个 `runtime/` 都被 `.gitignore` 忽略，证书和运行数据不会入库。改动
  忽略规则后请按 7.7 的方法复验，不要靠读 `.gitignore` 推断。
- 本机用 **8080/8443**，服务器仍是 80/443。Windows 上 80/443 常被占用或需要特权。
- `runtime/` 下的数据目录与 `admin-server/data/` 是**分开的**，跑 Compose 不会动本地开发库。
- `SITE_ROOT_PATH` 指向 `runtime/site`，只放公开前台文件；**绝不能指向整个 Git 检出**，
  否则源码与现场配置会被 nginx 当静态文件暴露。这条约束本机与生产一致。
- `admin-server/.env` 本机也需要存在，且 `SESSION_SECRET`、`ADMIN_PASSWORD_HASH`、
  `TOTP_ENCRYPTION_KEY` 必须是合法值，否则后台启动即退出。**本机值必须是当场生成的
  一次性假值，绝不从服务器复制真实值下来，也绝不写进任何入库文件。** 生成方式：
  session 密钥用 `openssl rand -hex 32`；TOTP 密钥用 `openssl rand -base64 32`；
  密码哈希在 `admin-server/` 下用 `node -e "console.log(require('bcrypt').hashSync('<本机弱口令>',12))"`。

### 该验什么

```bash
docker compose --env-file .env.local ps                      # 两个容器都应 healthy
docker compose --env-file .env.local exec nginx nginx -t     # 配置语法
docker compose --env-file .env.local exec nginx \
  grep -c set_real_ip_from /etc/nginx/conf.d/default.conf     # 渲染后的实际配置
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost:8080/
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/health
curl -sk --resolve lab.localhost:8443:127.0.0.1 -D- -o /dev/null https://lab.localhost:8443/
```

**「容器 healthy」不能单独作为配置已生效的证据**，必须查容器内渲染后的实际配置——
`docker compose up -d` 不因挂载内容变化而重建容器，2026-08-17 部署 real_ip 时就踩过：
`nginx -t` 通过、入口全 200、容器 healthy，但渲染结果里 `set_real_ip_from` 是 0 条。

用完清理：

```bash
docker compose --env-file .env.local down
```

### ⚠️ 本机验证能力的边界：本机通过 ≠ 线上通过

这一节的作用是防止将来有人拿本机结果当线上证据。**以下这些本机根本验不到：**

| 验不到的东西 | 为什么 |
|---|---|
| **Cloudflare 在前的一切** | CF 网段匹配、`CF-Connecting-IP` 还原出的真实访客 IP、WAF、DDoS 吸收。本机是直连 nginx，`set_real_ip_from` 那 22 条**一条都不会命中** |
| **真实来源 IP 与限流分桶** | 承上。本机看到的永远是 `127.0.0.1`，限流按谁分桶验不出来 |
| **真实 DNS 与信任链** | 本机是自签证书，浏览器会警告；Origin CA、证书续期、SAN 是否覆盖真实主机名，都只能在服务器上验 |
| **HTTP→HTTPS 跳转的落点** | 本机跳转 `Location` 指向 `https://localhost/`（**不带端口**，因为 nginx 用 `$host`），落到没在监听的 443。服务器上 80/443 是默认端口所以正确。**这是本机端口映射的产物，不是配置缺陷，也不要为迁就本机去改 nginx** |
| **生产 `.env` 的真实值及其副作用** | 本机用的是一次性假值 |
| **Compose 版本差** | 服务器 **5.4.0**，本机 **5.3.1**。`env_file.format: raw` 要求 ≥ 2.30.0，两边都满足，但**本机通过不等于服务器一定通过** |
| **真实数据与真实负载** | 本机是空库空目录，发布链路、备份体积、并发行为都不具代表性 |

**本机能验到的是**：Compose 能否解析与编排、镜像能否构建、两个容器能否 healthy、nginx
配置语法与**渲染结果**、静态根与反代路由的分工、小作坊主机名的隔离（不反代到 Node、
带受限 CSP、不下发 Cookie）、以及 `X-Forwarded-Proto` 是否被后台采信（Secure Cookie
能否下发）。这些此前全部要到服务器才第一次运行。

## 现有服务器的日常代码更新

以下命令必须由用户、服务器运维人员或获得明确授权的执行 agent 在生产服务器执行。任何 agent 在没有单独授权和服务器连接方式时，都不得自行连接生产环境。

先决条件：目标改动已经提交并推送到远程 `main`，服务器工作区没有未确认修改。将 `<仓库目录>` 替换为服务器真实检出路径，但不要把该路径写回仓库：

```bash
cd <仓库目录>
git status --short --branch
git pull --ff-only origin main
docker compose config --quiet
docker compose build admin-server
docker compose up -d --no-deps admin-server
docker compose ps
docker compose logs --tail=100 admin-server
```

代码或依赖变化后必须显式执行 `docker compose build admin-server`。单独运行 `docker compose up -d` 可能继续使用旧镜像。若 Dockerfile、锁文件或基础镜像存在可疑缓存问题，可改用：

```bash
docker compose build --no-cache admin-server
```

对于只改变后台应用代码和文档、未改变Compose/Nginx拓扑且不涉及数据迁移的更新（包括本次 `deployment` 判断修正），只需重建和替换 `admin-server`，Nginx无需重建。重启后验证：

```bash
curl --fail --silent https://zhiliaohub.com/health
```

预期响应包含：

```json
{"status":"ok","storage":"sqlite+markdown","deployment":"production"}
```

随后人工打开主站和 `/admin/login`。本轮不要求重新绑定TOTP、重新配对App或清空session；如果出现这类现象，应停止继续操作并检查持久挂载和 `SESSION_SECRET` 是否被改变。

### ⚠️ 前台静态资源必须单独同步到站点根

上面的命令只更新**后台容器**。前台是 Nginx 直接伺服 `SITE_ROOT_PATH`
指向的独立站点目录的静态文件，**`git pull` 不会把它们送过去**——站点根是一份
独立于 Git 检出的目录（见「持久目录与权限」，它绝不能指向仓库本体）。

**只要本轮改动了任何前台文件——HTML、`css/`、`js/`，以及新增的图片、字体等
任何资源——都必须把它们一并复制到站点根**，否则线上仍是旧版：

```bash
cp index.html tools.html works*.html notes*.html feedback.html <站点根>/
cp -r assets css js <站点根>/
```

**新增资源尤其容易漏。** 2026-08-22 部署 `v2.3` 时实测：站点根的 `assets/`
里只有 4 张旧图，该版本新增的 `tools-oc-planning-workbench.webp` **不在其中**
——不同步就会让新版页面引用到一个不存在的文件。同一次还发现站点根的
`css/style.css` 停在 08-13，也就是说**改了共享 CSS 不同步，新样式完全不生效**。

这类遗漏**本地看不出来**：本机验证用的是自己的 `runtime/site`，仓库 diff 与 CI
也都不会报——CI 只做语法和本地引用检查，它检查的是仓库里的文件，不是服务器上
的文件。**唯一可靠的确认方式是部署后在真实域名上打开页面、并核对站点根的实际
文件**（例如比对新增资源是否存在、`css/style.css` 的修改时间是否是本次）。

如果改动同时涉及 `docker-compose.yml` 或 `deploy/nginx.conf`，不要使用上面的“仅后台”快捷流程：先备份现场配置和数据，运行完整配置检查，再执行 `docker compose up -d` 并回归全部代理路径。

## 首次部署、迁移或灾难重建

以下流程用于新服务器、服务器迁移或灾难恢复，不是每次小代码更新都要重做：

1. 在服务器检出已确认版本，安装受支持的Docker Engine与Compose插件。
2. 从两个 `.env.example` 分别创建根目录 `.env` 和 `admin-server/.env`，填写现场值，并确认两者均未被Git跟踪。
3. 创建六个持久目录和TLS文件，设置最小必要权限。
4. 从已验证备份恢复SQLite、Markdown和普通上传，或初始化全新数据；单独处理当前备份未覆盖的 `lab-storage/`。
5. 初始化独立公开站点目录，确保其中不含Git仓库、后台源码或现场配置。
6. 运行 `docker compose config --quiet`。
7. 运行 `docker compose build --no-cache admin-server`。
8. 对Nginx模板执行真实 `nginx -t`（可通过官方容器完成），然后运行 `docker compose up -d`。
9. 检查两个服务healthy和日志，验证HTTP→HTTPS、静态站、`/health`、密码+TOTP、App设备登录、来源IP、反馈提交/审核/发布、作品上传/发布、备份和小作坊主机名。
10. 重建容器后再次确认SQLite、Markdown、上传、备份、小作坊文件和已发布前台均未丢失。

真实IP、域名、证书路径、宿主目录和凭据始终通过服务器现场 `.env` 提供，不修改仓库内Compose或Nginx文件来硬编码。

## 当前生产验证与待办边界

已确认：

- `https://zhiliaohub.com` 主站可访问；
- `/admin/login` 可访问；
- `/health` 返回 HTTP 200；
- 生产域名和HTTPS已实际投入使用；
- 配套 App 已通过生产域名完成设备识别和登录。

本轮 `deployment` 修正尚未发布到服务器；在提交、推送、重建和重启前，线上仍返回旧的 `local-only`。完成上面的日常更新后，必须再次读取 `/health` 验证为 `production`。

仍未完成或不能从当前证据宣称已完成：

- 小作坊真实子域名的Cookie隔离完整验收；
- 真正的异地对象存储备份；
- 备份失败外部告警和服务器级恢复演练；
- `lab-storage/` 纳入备份；
- 多后台实例或水平扩容；
- 由CI自动执行后台测试、容器和生产回归。
