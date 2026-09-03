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
- `deploy/nginx.conf`：在唯一前置 gateway 之后以纯 HTTP 提供静态前台、后台反代与小作坊独立主机名。
- `admin-server/.env.example`：Node后台业务配置与密钥模板；服务器上的 `admin-server/.env` 保存真实值。
- `admin-server/Dockerfile`：Node 22 非root多阶段后台镜像。
- `admin-server/deploy/lab-subdomain.md`：小作坊独立子域名的额外安全与验收要求。

生产 Compose 强制设置 `NODE_ENV=production`、`HOST=0.0.0.0`、`PORT=3001`、`TRUST_PROXY_HOPS=1` 和各容器路径。`NODE_ENV=production` 同时控制 Secure session Cookie，以及 `/health` 的 `deployment: production` 标识。

## 两层 `.env` 不可混用

### 1. 仓库根目录 `.env`

根目录 `.env` 由 Docker Compose 解析，来自根目录 `.env.example`，真实文件被 `.gitignore` 排除。它只保存部署拓扑参数：

- `SERVER_PUBLIC_IP`（gateway 拓扑下必须为 `127.0.0.1`）与 HTTP 宿主端口；
- 主站/后台共用的 `SERVER_NAME` 与小作坊的 `LAB_SERVER_NAME`；
- `TRUSTED_PROXY_CIDR`（现场实测的后端 Compose 桥网关网段）；
- 单一运行时父目录的宿主机路径（其下固定包含五个后台持久目录和公开站点目录）；
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

定时备份使用 `BACKUP_SCHEDULE_LOCAL_TIME="00:00"`（24小时制 `HH:MM`），代码始终按固定 **UTC+8** 解释，不依赖容器 `TZ`。从旧配置升级时应删除已经失效的 `BACKUP_INTERVAL_MS`、`BACKUP_SCHEDULE_CHECK_INTERVAL_MS`，在服务器现场的 `admin-server/.env` 写入新的时钟配置；本仓库不会修改生产 `.env`。

## 持久目录与权限

根目录 `.env` 只配置一个 `RUNTIME_ROOT_PATH`。该宿主目录以可写方式挂到后台的
`/app/runtime`，并以只读方式挂到Nginx的同一路径；六个恢复目标必须全部是它下面的
普通子目录：

| 宿主子目录 | 后台容器路径 | Nginx用途 |
|---|---|---|
| `data/` | `/app/runtime/data` | — |
| `content/` | `/app/runtime/content` | — |
| `uploads/` | `/app/runtime/uploads` | — |
| `backups/` | `/app/runtime/backups` | — |
| `lab-storage/` | `/app/runtime/lab-storage` | 从同一路径只读伺服 |
| `site/` | `/app/runtime/site` | 从同一路径只读伺服 |

**共用一个父目录是恢复正确性的前提，不是布局偏好。** 恢复器通过同文件系统内的
原子 `rename` 交换上述子目录；如果每个子目录本身都是独立bind mount，Linux会以
`EBUSY`拒绝重命名。Nginx也必须挂父目录，否则恢复交换 `lab-storage/` 后仍会握着
旧mount/inode，容器healthy但继续伺服旧内容。

Docker会把不存在的bind源自动创建为`root:root`。后台镜像固定以Node官方镜像的
UID/GID `1000:1000`运行，因此首次启动前要创建父目录及六个子目录，并一次性设置属主：

```bash
mkdir -p <runtime-root>/{data,content,uploads,backups,lab-storage,site}
chown -R 1000:1000 <runtime-root>
```

不要用全员可写规避权限问题。已有部署升级到本布局时，应先停栈，把原六个目录移动到
同一个持久父目录下，再把 `RUNTIME_ROOT_PATH` 指向该父目录；不能保留六个叶子挂载。

`RUNTIME_ROOT_PATH/site` 必须是**只包含公开前台文件的独立目录**，绝不能指向整个Git仓库，否则源码、文档或现场配置可能被Nginx当作静态文件暴露。它应包含：

- `index.html`、`works*.html`、`notes*.html`、`feedback.html`、`tools.html`；
- `assets/`、`css/`、`js/`。

**这个目录不会随 `git pull` 更新。** 每次改动前台文件（含新增图片、字体等任何
资源）后，都必须把它们单独复制到该目录，具体见「现有服务器的日常代码更新」下
的「前台静态资源必须单独同步到站点根」。

`RUNTIME_ROOT_PATH/content` 是运行时Markdown目录。新服务器如果不是从备份恢复，应先复制仓库中的初始 `admin-server/content/`；父级bind mount会遮住镜像内随附内容。

## Nginx路由与代理信任

`deploy/nginx.conf` 由官方Nginx镜像作为模板读取。`NGINX_ENVSUBST_FILTER` 只允许替换 `SERVER_NAME`、`LAB_SERVER_NAME`、`TRUSTED_PROXY_CIDR` 和上传上限，避免 `$host`、`$remote_addr` 等原生Nginx变量被误替换。

主站主机名下：

- 只监听回环映射的 HTTP 端口；TLS 终止和 HTTP→HTTPS 跳转由唯一前置 gateway 负责；
- `/admin`、`/api`、`/uploads`、`/health` 反代到 `admin-server:3001`；
- 其他路径从只读公开站点目录直接伺服；
- 代理发送 `Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto`。

后台只信任紧邻它的一层 hub Nginx（`TRUST_PROXY_HOPS=1`）。生产 session Cookie 带 `Secure`；hub Nginx 依据“只有 gateway 的 TLS :443 块会反代到本机”这一拓扑事实，固定向 Express 发送 `X-Forwarded-Proto=https`。若改成 `http` 或空值，`express-session` 会在生产模式下静默地不下发 Secure Cookie，密码和 TOTP 都正确也会弹回登录页。

### Gateway 后的真实客户端 IP 还原

目标链路是 **访客 → zhiliao-gateway → hub Nginx → admin-server**。gateway 传入的 XFF 可能带有客户端原先伪造的前缀，但其最右一项是 gateway 亲自追加的真实客户端地址。`deploy/nginx.conf` 在 http 级用一条 `set_real_ip_from ${TRUSTED_PROXY_CIDR}` 限定唯一可信来源，并以 `real_ip_header X-Forwarded-For`、`real_ip_recursive` 默认 off 取最右项。hub Nginx 还原后的 `$remote_addr` 是真实客户端，向 Express 追加的 XFF 末位仍是该地址，因此 `TRUST_PROXY_HOPS` 保持 `1`。

`TRUSTED_PROXY_CIDR` 必须在部署现场查看 Compose `app-network` 后确定。该网络没有固定子网，不得在仓库中写死某个桥网关，也**绝不能写 `0.0.0.0/0`**。无条件信任 XFF 会允许任意直连者伪造来源 IP、绕过全部按 IP 限流。

这条链路配错不会报错或崩溃：登录、TOTP、设备认证和反馈提交四个限流器会静默合并到桥网关地址这一个桶，`feedback_comments` 记录的 IP 也会失真。上线后的证据必须是**观察实际分桶键或日志记录的客户端地址**，确认不是 Compose 桥网关；只读配置或 `nginx -t` 通过不能证明真实 IP 还原正确。

### 四条不可拆分的安全承重假设

gateway 拓扑下，下列四项是同一组安全边界，任何一项都不得脱离其他项单独修改：

1. hub Nginx 不再终止 TLS；
2. hub Nginx 不再做 HTTP→HTTPS 跳转；
3. `SERVER_PUBLIC_IP` 默认且必须为 `127.0.0.1`，hub Nginx 只绑回环；
4. hub Nginx 向 Express 发送的 `X-Forwarded-Proto` 固定为 `https`，因为只有 gateway 的 TLS :443 块会反代到本机。

若将第 3 项改回公网接口，前两项会使站点以明文 HTTP 直接暴露，第 4 项还会让 Express 把明文直连误当成 HTTPS。这些故障都可能在站点“看起来正常”时静默存在。

小作坊主机名使用独立Nginx `server` 块，直接只读访问 `RUNTIME_ROOT_PATH/lab-storage`，不代理到Node，并附加受限CSP等响应头。证书必须覆盖主站和小作坊两个主机名。真实小作坊子域名的Cookie隔离仍需按 `lab-subdomain.md` 单独验收。

## 本机 Compose 验证

在开发机上跑一遍完整的 hub Compose，把 Nginx 模板渲染、纯 HTTP 路由、响应头和编排关系提前验一遍。TLS、HTTP→HTTPS 和四主机转发属于独立 gateway，本节不模拟它。

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
mkdir -p runtime/{data,content,uploads,backups,lab-storage,site}
cp -r admin-server/content/. runtime/content/
cp index.html tools.html runtime/site/ && cp -r assets css js runtime/site/
docker compose --env-file .env.local config --quiet
docker compose --env-file .env.local up -d --build
```

几点说明：

- `.env.local` 与整个 `runtime/` 都被 `.gitignore` 忽略，证书和运行数据不会入库。改动
  忽略规则后请按 7.7 的方法复验，不要靠读 `.gitignore` 推断。
- 本机将 hub Nginx 的纯 HTTP 端口绑到 `127.0.0.1:8080`；生产同样必须只绑回环，由 gateway 占用公网 80/443。
- `runtime/` 下的数据目录与 `admin-server/data/` 是**分开的**，跑 Compose 不会动本地开发库。
- `RUNTIME_ROOT_PATH` 指向 `runtime`；其中的 `site/` 只放公开前台文件，**绝不能指向整个 Git 检出**，
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
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: localhost' http://127.0.0.1:8080/
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: localhost' http://127.0.0.1:8080/health
curl -s -D- -o /dev/null -H 'Host: lab.localhost' http://127.0.0.1:8080/
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
| **真实 gateway 链路** | 本节直接访问 hub Nginx，没有经过 gateway；四主机转发、公网 TLS 和 HTTP→HTTPS 跳转均未验证 |
| **真实来源 IP 与限流分桶** | 本机占位的 `TRUSTED_PROXY_CIDR` 不代表生产桥网关；必须上线后从实际分桶键/日志证明客户端地址已还原 |
| **真实 DNS 与证书信任链** | 证书已转由 gateway 管理，hub 仓库的本机 Compose 不再挂载或验证它 |
| **生产 `.env` 的真实值及其副作用** | 本机用的是一次性假值 |
| **Compose 版本差** | 服务器 **5.4.0**，本机 **5.3.1**。`env_file.format: raw` 要求 ≥ 2.30.0，两边都满足，但**本机通过不等于服务器一定通过** |
| **真实数据与真实负载** | 本机是空库空目录，发布链路、备份体积、并发行为都不具代表性 |

**本机能验到的是**：Compose 能否解析与编排、镜像能否构建、两个容器能否 healthy、nginx
配置语法与**渲染结果**、静态根与反代路由的分工、小作坊主机名的隔离（不反代到 Node、带受限 CSP、不下发 Cookie），以及 hub Nginx 只暴露回环 HTTP 端口。真实 gateway 与客户端 IP 链路仍须上线验证。

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

上面的命令只更新**后台容器**。前台是 Nginx 直接伺服 `RUNTIME_ROOT_PATH/site`
中的静态文件，**`git pull` 不会把它们送过去**——站点根是一份
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
3. 创建单一 `RUNTIME_ROOT_PATH` 父目录及其六个固定子目录，执行 `chown -R 1000:1000 <runtime-root>`。既有部署必须先把六个数据目录归并到同一父目录；TLS证书只由独立gateway管理，hub Compose不挂载证书。
4. 在**应用层的 `admin-server/.env`**配置 `RESTORE_PROBE_URL`，不要放进根目录Compose `.env`。它必须是**本机 hub Nginx 的回环 HTTP 地址加精确 `/health` 路径**，例如 `http://127.0.0.1:<后端端口>/health`。不得指向 gateway 或公开域名；gateway 失效不能证明后台已停，迁移期间公开 DNS 也可能仍指向旧机器。
5. 初始化独立公开站点目录，确保其中不含Git仓库、后台源码或现场配置。
6. 运行 `docker compose config --quiet`，构建后台镜像，并对Nginx模板执行真实 `nginx -t`。
7. 先运行 `docker compose up -d` 并等待两个服务healthy。Nginx配置使用静态上游名且Compose依赖后台健康，整栈从未启动过时不能直接恢复。
8. 单独运行 `docker compose stop admin-server`，保持Nginx运行；确认本机Nginx `/health` 返回502/503/504后，再从已验证备份恢复SQLite、Markdown、上传文件和 `lab-storage/`。恢复器还会要求`-shm`不存在且SQLite独占锁成功，三项按AND关系缺一不可。若现场设置了 `BACKUP_EXCLUDE_ZIP=true` 且恢复命令列出 `manifest.excluded` 条目，必须从用户本地按清单路径补回ZIP并核对大小与SHA-256。旧归档不含 `lab-storage/` 时不能据此恢复当时的小作坊文件。
9. 恢复成功后运行 `docker compose start admin-server`，检查两个服务healthy和日志，验证 gateway 的 HTTP→HTTPS、静态站、`/health`、App设备登录、来源IP、反馈提交/审核/发布、作品上传/发布、备份和小作坊主机名。**必须用真实管理员密码 + TOTP 完整登录一次，并确认登录后会话持续有效**；`nginx -t`、静态页 200 或容器 healthy 都无法替代这项验证。
10. 重建容器后再次确认SQLite、Markdown、上传、备份、小作坊文件和已发布前台均未丢失。

`RESTORE_PROBE_URL`请求连接失败、DNS/TLS失败或超时都不能证明服务已停，恢复会拒绝继续。若地址返回200，错误信息会提醒迁移操作者核对它是否误指向旧机器。异常退出后残留`-shm`也会按安全侧误报拒绝；不要直接删除`-shm/-wal`绕过检查，应先确认所有数据库使用者都已停止并检查WAL状态。新机同样不得增加跳过探测的旁路，只走“起整栈→单停后台→恢复→重启后台”的固定序列。

恢复健康探测默认等待15秒，以覆盖Nginx连接已消失上游时约3秒以上的TCP重试。
如现场确需更长时间，只在当次可见的命令行追加 `--probe-timeout-ms <正整数毫秒>`；
非法值会拒绝执行，不会静默退回默认值。本项刻意不提供环境变量，避免旧配置长期残留。

**备份默认包含ZIP；如需排除，设置 `BACKUP_EXCLUDE_ZIP=true`，此时恢复后需由用户从本地补齐，清单见 `manifest.excluded`。一份“静默地少了东西”的备份比没有备份更危险。**启用排除后的灾难重建验收不能只看恢复命令退出码，还要把清单列出的ZIP补齐并校验后，再检查作品下载链接。

`lab-storage/` 保存的是小作坊唯一可恢复的解压产物，现与SQLite、Markdown和上传池一并入包；`.pending-*`、`.deleted-*` 中间态会被排除。默认每个项目最多500个文件、解压后100MiB，常规归档保留3份，因此单个达到上限且难以压缩的项目最多可让备份总占用增长约300MiB。部署后必须把 `BACKUP_DIR`、镜像目的地的容量监控纳入运维。

真实IP、域名、gateway 证书路径、宿主目录和凭据始终通过各自部署现场的 `.env` 提供，不修改仓库内 Compose 或 Nginx 文件来硬编码。

## 当前生产验证与待办边界

已确认：

- `https://zhiliaohub.com` 主站可访问；
- `/admin/login` 可访问；
- `/health` 返回 HTTP 200；
- 生产域名和HTTPS已实际投入使用；
- 配套 App 已通过生产域名完成设备识别和登录。

本轮 `deployment` 修正尚未发布到服务器；在提交、推送、重建和重启前，线上仍返回旧的 `local-only`。完成上面的日常更新后，必须再次读取 `/health` 验证为 `production`。

本文件中的唯一前置 gateway、回环 HTTP 与 `TRUSTED_PROXY_CIDR` 是仓库已准备的**目标拓扑**；在生产服务器完成现场配置、重建和上述回归前，不得声称它已线上生效。

仍未完成或不能从当前证据宣称已完成：

- 小作坊真实子域名的Cookie隔离完整验收；
- 真正的异地对象存储备份；
- 备份失败外部告警和服务器级恢复演练；
- 多后台实例或水平扩容；
- 由CI自动执行后台测试、容器和生产回归。
