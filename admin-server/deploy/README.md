# 知了hub 管理后台部署片段

> 以下内容需要手动合并进服务器上的共享 `docker-compose` / nginx 配置。本轮不直接修改任何仓库外文件，也没有执行真实部署。

## 上线前必须由用户填写

- `<ADMIN_DOMAIN>`：管理后台最终子域名，例如由用户实际拥有域名下的 `admin` 子域名；本文不提供虚构域名。
- `<ADMIN_HOST_PORT>`：服务器回环地址上分配给后台的实际端口。
- `<ADMIN_DATA_PATH>`、`<ADMIN_CONTENT_PATH>`、`<ADMIN_UPLOADS_PATH>`、`<ADMIN_BACKUPS_PATH>`：服务器上四个独立持久化目录的绝对路径。
- `<ADMIN_ENV_FILE>`：服务器上真实环境变量文件的绝对路径，权限应限制为服务维护者可读。
- `<TLS_CERT_PATH>` 与 `<TLS_KEY_PATH>`：该真实域名对应的证书和私钥路径。
- 如果 nginx 也运行在共享 Compose 网络内，还需确定实际网络名；此时可以不映射宿主机端口，改为通过服务名访问容器端口。

真实服务器IP、域名、密码哈希、session密钥、TOTP加密密钥、备份密码和TLS路径都不能从仓库推断，必须在实际部署时填写。

## docker-compose 服务片段

以下片段假设共享 Compose 文件可以从知了hub仓库路径构建镜像，且宿主机 nginx 通过回环端口访问容器。路径占位符必须先替换：

```yaml
services:
  zhiliaohub-admin:
    build:
      context: <ZHILIAOHUB_REPOSITORY_PATH>/admin-server
      dockerfile: Dockerfile
    image: zhiliaohub-admin:<RELEASE_TAG>
    env_file:
      - <ADMIN_ENV_FILE>
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 3001
      SCHEMA_PATH: /app/schema/schema.sql
      TRUST_PROXY_HOPS: 1
    ports:
      - "127.0.0.1:<ADMIN_HOST_PORT>:3001"
    volumes:
      - <ADMIN_DATA_PATH>:/app/data
      - <ADMIN_CONTENT_PATH>:/app/content
      - <ADMIN_UPLOADS_PATH>:/app/uploads
      - <ADMIN_BACKUPS_PATH>:/app/backups
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

真实环境变量文件至少需要：

```dotenv
ADMIN_PASSWORD_HASH=<BCRYPT_HASH>
SESSION_SECRET=<AT_LEAST_32_RANDOM_CHARACTERS>
TOTP_ENCRYPTION_KEY=<BASE64_ENCODED_32_BYTE_KEY>
BACKUP_ENCRYPTION_PASSWORD=<STRONG_BACKUP_ONLY_PASSWORD>
BACKUP_RETENTION_COUNT=7
SESSION_MAX_AGE_MS=28800000
SESSION_CLEANUP_INTERVAL_MS=900000
PAIRING_CODE_TTL_MS=300000
DEVICE_CHALLENGE_TTL_MS=120000
DEVICE_AUTH_RATE_LIMIT_WINDOW_MS=900000
DEVICE_AUTH_RATE_LIMIT_MAX=30
```

不得把真实环境文件复制进镜像或提交到仓库。SQLite数据库、Markdown、上传文件与备份目录都必须挂载为持久卷，否则容器重建会丢失数据。当前备份只落在服务器本地独立目录；异地副本仍需另行设计。

## nginx 子域名片段

默认方案是独立子域名，因为当前应用路由和重定向都以 `/admin`、`/api/admin` 为根路径：

```nginx
server {
    listen 443 ssl http2;
    server_name <ADMIN_DOMAIN>;

    ssl_certificate     <TLS_CERT_PATH>;
    ssl_certificate_key <TLS_KEY_PATH>;

    location / {
        proxy_pass http://127.0.0.1:<ADMIN_HOST_PORT>;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

如果 nginx 与后台都在同一个 Compose 网络，`proxy_pass` 可在人工确认网络和服务名后改为 `http://zhiliaohub-admin:3001`，同时删除宿主机 `ports` 映射并使用 `expose`。

如果最终选择路径前缀（例如主站 `/admin/`）而不是子域名，不能只改一条 nginx rewrite：当前应用的路由、绝对重定向、Cookie路径和页面表单地址都要加入统一的 `BASE_PATH` 支持，并重新验证CSRF、登录跳转和静态引用。本仓库尚未实现路径前缀部署。

## 人工部署顺序

1. 在服务器创建四个持久目录和真实环境变量文件，确认目录属主/权限允许镜像内非root `node` 用户读写（应以实际构建镜像的UID/GID核对，不能默认放宽为全员可写）。
2. 将上述服务片段人工合并到共享 Compose 配置，替换所有占位符。
3. 将 nginx 片段人工合并到服务器配置，填写真实域名与证书路径并由管理员校验语法。
4. 构建并启动服务，确认容器健康检查和 `/health`。
5. 实测密码、TOTP、服务重启后session、内容写入、上传及备份/恢复。
6. 再决定定时备份调度、异地复制、监控告警和正式对外开放时间。

本轮没有执行以上步骤；这些片段只是仓库内的部署准备材料。
