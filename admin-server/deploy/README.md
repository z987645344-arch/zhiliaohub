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

`ADMIN_CONTENT_PATH` 是运行时Markdown目录。新服务器如果不是从备份恢复，应先复制仓库中的初始 `admin-server/content/`；空bind mount会遮住镜像内随附内容。

## Nginx路由与代理信任

`deploy/nginx.conf` 由官方Nginx镜像作为模板读取。`NGINX_ENVSUBST_FILTER` 只允许替换 `SERVER_NAME`、`LAB_SERVER_NAME` 和上传上限，避免 `$host`、`$remote_addr`、`$scheme` 等原生Nginx变量被误替换。

主站主机名下：

- 80端口跳转HTTPS；
- `/admin`、`/api`、`/uploads`、`/health` 反代到 `admin-server:3001`；
- 其他路径从只读公开站点目录直接伺服；
- 代理发送 `Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto`。

后台只信任紧邻它的一层Nginx代理（`TRUST_PROXY_HOPS=1`）。生产session Cookie带 `Secure`，因此代理必须终止TLS并正确传递 `X-Forwarded-Proto=https`；直接用纯HTTP访问后台不能作为生产登录方式。

小作坊主机名使用独立Nginx `server` 块，直接只读访问 `ADMIN_LAB_STORAGE_PATH`，不代理到Node，并附加受限CSP等响应头。证书必须覆盖主站和小作坊两个主机名。真实小作坊子域名的Cookie隔离仍需按 `lab-subdomain.md` 单独验收。

## 现有服务器的日常代码更新

以下命令必须由用户或服务器运维人员在生产服务器执行。Codex在没有单独授权和服务器连接方式时，不自行连接生产环境。

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
