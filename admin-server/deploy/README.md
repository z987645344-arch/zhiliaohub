# 知了hub 部署配置说明

仓库已经提供正式的部署配置文件：

- 根目录 `docker-compose.yml`：构建并运行管理后台与官方Nginx镜像。
- 根目录 `.env.example`：Docker Compose自身读取的非密钥变量模板。
- `deploy/nginx.conf`：Nginx配置模板，负责HTTPS、静态前台、后台反代与小作坊独立主机名。
- `admin-server/.env.example`：Node管理后台读取的业务配置与密钥模板。
- `admin-server/deploy/lab-subdomain.md`：小作坊子域名的安全边界与上线验收补充说明。

这些文件只是部署准备。本轮没有连接服务器、构建镜像、启动Compose、申请证书或修改DNS。

## 两层 `.env` 不可混用

### 1. 仓库根目录 `.env`

由Docker Compose在解析 `docker-compose.yml` 时读取。服务器上从根目录 `.env.example` 复制创建，但真实 `.env` 已被 `.gitignore` 排除。

它只保存部署拓扑参数：

- `SERVER_PUBLIC_IP`、HTTP/HTTPS宿主端口；
- 主站/后台共用的 `SERVER_NAME` 与小作坊的 `LAB_SERVER_NAME`；
- TLS证书和私钥在宿主机上的路径；
- 五个后台持久目录和独立静态站点目录的宿主机路径；
- Nginx上传上限与本地镜像标签。

这里**不要**填写管理员密码哈希、session密钥、TOTP密钥或备份加密密码。

### 2. `admin-server/.env`

由Node容器通过Compose的 `env_file` 读取。服务器上从 `admin-server/.env.example` 复制创建，真实文件同样不入Git。

`docker-compose.yml` 对这个文件显式声明了 `format: raw`，用来关闭Compose的变量插值。**不要去掉它**：bcrypt 哈希形如 `$2b$12$<盐与哈希>`，其中的 `$` 会被Compose当成变量引用，插值后只剩 `$2b$12`，后台启动时会以 `ADMIN_PASSWORD_HASH must be a bcrypt hash.` 直接退出。同理，这里的值**不需要**把 `$` 写成 `$$` 转义，按 `hash-password.js` 输出的原样粘贴即可。

它保存后台业务与敏感配置，例如：

- `ADMIN_PASSWORD_HASH`；
- `SESSION_SECRET`；
- `TOTP_ENCRYPTION_KEY`；
- `BACKUP_ENCRYPTION_PASSWORD`；
- 认证、反馈、上传、小作坊和备份策略参数；
- `LAB_BASE_URL=https://<小作坊真实域名>`。

Compose会强制覆盖容器内的 `NODE_ENV=production`、`HOST=0.0.0.0`、`PORT=3001`、`TRUST_PROXY_HOPS=1` 以及所有挂载目录路径，避免服务器 `.env` 意外把容器拓扑改回本地开发值。

`BACKUP_MIRROR_DIR` 当前只是同机副本模拟，默认应留空。若未来启用，必须先给该目录增加独立持久卷挂载；不能把它指向容器未挂载且不可写的 `/app` 路径，更不能把同机副本描述为真实异地容灾。

## 目录与权限

根目录 `.env.example` 使用 `./runtime/...` 作为安全的本地占位路径。正式服务器建议把下面变量改成专用绝对路径，而不是修改Compose文件：

- `ADMIN_DATA_PATH` → `/app/data`
- `ADMIN_CONTENT_PATH` → `/app/content`
- `ADMIN_UPLOADS_PATH` → `/app/uploads`
- `ADMIN_BACKUPS_PATH` → `/app/backups`
- `ADMIN_LAB_STORAGE_PATH` → `/app/lab-storage`
- `SITE_ROOT_PATH` → `/app/site`（后台读写）与 `/usr/share/nginx/html`（Nginx只读）

前五项和静态站点目录都必须持久化。镜像内应用以非root `node` 用户运行；当前官方Node镜像中的UID/GID为1000，部署时仍应以实际构建镜像核对，并让五个后台目录和静态站点目录对该用户可读写。不要用全员可写权限规避属主问题。

`SITE_ROOT_PATH` 必须是一个**只包含公开前台文件的独立目录**，不能直接指向整个Git仓库。否则仓库中的 `admin-server/`、文档或服务器现场配置可能被Nginx当作静态文件暴露。首次启动前，应把以下已提交前台文件复制到该目录：

- 根目录的 `index.html`、`works*.html`、`notes*.html`、`feedback.html`、`tools.html`；
- `assets/`、`css/`、`js/` 三个目录。

`ADMIN_CONTENT_PATH` 是运行时Markdown目录。全新部署若不是从备份恢复，应先把仓库内 `admin-server/content/` 的初始内容复制进去；空的bind mount会遮住镜像内随附的占位Markdown。

## Nginx路由与代理信任

`deploy/nginx.conf` 由官方Nginx镜像作为模板读取。Compose设置 `NGINX_ENVSUBST_FILTER`，只替换 `SERVER_NAME`、`LAB_SERVER_NAME` 和上传上限，配置中的原生 `$host`、`$remote_addr`、`$scheme` 等Nginx变量不会被错误替换。

主站主机名下：

- `/admin`、`/api`、`/uploads` 与 `/health` 反代到 `admin-server:3001`；
- 其他请求直接读取只读挂载的静态前台目录；
- 代理发送 `Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto`。

后台设置 `TRUST_PROXY_HOPS=1`，只信任紧邻它的这一个Nginx代理。生产session Cookie带 `Secure`，因此Nginx必须终止TLS并正确传递 `X-Forwarded-Proto=https`；纯HTTP部署无法正常登录。配置中的80端口只负责重定向到HTTPS。

小作坊主机名使用单独的Nginx `server` 块，直接只读访问同一份 `ADMIN_LAB_STORAGE_PATH`，不经过Node管理进程，并附加受限CSP等安全响应头。证书必须同时覆盖 `SERVER_NAME` 与 `LAB_SERVER_NAME`，也可以使用包含两者的SAN证书。

## 服务器现场需要填写什么

不要替换或提交仓库文件中的占位值。服务器上执行：

1. 复制根目录 `.env.example` 为根目录 `.env`。
2. 在根目录 `.env` 填写真实监听IP、两个真实主机名、证书/私钥路径和六个持久目录路径。
3. 复制 `admin-server/.env.example` 为 `admin-server/.env`。
4. 在 `admin-server/.env` 写入现场生成的密码哈希与随机密钥，并令 `LAB_BASE_URL` 与根目录 `.env` 的 `LAB_SERVER_NAME` 对应，例如 `https://<LAB_SERVER_NAME>`（尖括号只是说明符，不能原样保留）。
5. 不修改 `docker-compose.yml` 或 `deploy/nginx.conf` 来写入真实IP、域名、密钥或证书路径。

根目录 `.env` 的 `SERVER_PUBLIC_IP=0.0.0.0` 表示监听所有宿主接口；也可填写服务器实际绑定IP。仓库示例默认 `127.0.0.1`，目的是避免有人未审阅配置就意外对公网开放。`SERVER_NAME=localhost` 和 `LAB_SERVER_NAME=lab.localhost` 也只是本地占位示例，不是生产域名。

## 实际部署顺序（后续执行，本轮不运行）

1. 在服务器检出已确认版本，并安装Docker Engine与Compose插件。
2. 创建根目录 `.env` 和 `admin-server/.env`，逐项替换现场值；确保两者都没有被Git跟踪。
3. 创建六个持久目录与TLS文件，设置最小必要权限；初始化独立静态站点目录和Markdown目录。
4. 先运行 `docker compose config --quiet` 检查变量与Compose语法，确认输出不报缺失变量或文件。
5. 运行 `docker compose build --no-cache admin-server`；代码或依赖变化后必须显式重建镜像。
6. 运行 `docker compose up -d`，检查两个服务的health状态和Nginx日志。
7. 验证HTTP到HTTPS重定向、主站静态文件、`/health`、密码+TOTP登录、真实来源IP、反馈提交、作品发布、上传、备份和小作坊独立主机名。
8. 重建容器后再次确认SQLite、Markdown、上传、备份、小作坊文件和已发布前台均未丢失。
9. 最后再配置DNS、外部防火墙、监控、真实远程备份与正式开放时间。

## 当前未验证边界

- 本轮电脑没有可用的Docker或Nginx命令，所以没有执行 `docker compose config`、`nginx -t`、镜像构建或容器启动；只完成配置文件的静态解析与逐项人工审阅。
- 没有连接真实服务器，没有写入真实IP、域名、证书、路径或凭据。
- 小作坊真实子域名Cookie隔离、HTTPS证书行为、反向代理来源IP和反馈真实访客流量仍需部署后验证。
- 当前归档备份不包含 `lab-storage`；真实远程对象存储也尚未实现。
