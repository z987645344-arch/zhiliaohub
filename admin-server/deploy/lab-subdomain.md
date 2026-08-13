# 小作坊独立子域名部署说明

当前开发环境通过 `http://localhost:3001/lab/{slug}/` 访问解压后的静态项目。真实部署时应把小作坊放在独立主机名下，直接由Nginx读取持久化的 `lab-storage`，不要把该主机名反向代理到Node管理后台。

根目录 `docker-compose.yml` 与 `deploy/nginx.conf` 已把这一结构整理为正式配置：同一个 `ADMIN_LAB_STORAGE_PATH` 对后台容器读写挂载、对Nginx只读挂载，Nginx用独立 `LAB_SERVER_NAME` 的HTTPS `server` 块提供文件。下面的片段只解释最终结构，不需要再手工复制到仓库配置：

```nginx
server {
    listen 443 ssl http2;
    server_name <LAB_SERVER_NAME>;

    # 占位：替换为服务器上的真实绝对路径。
    root /srv/zhiliaohub-lab;
    index index.html;

    # 占位：替换为真实证书文件。
    ssl_certificate     /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/privkey.pem;

    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

部署时还需要完成：

1. 在服务器根目录 `.env` 中设置真实 `LAB_SERVER_NAME`、证书路径与 `ADMIN_LAB_STORAGE_PATH`，并配置对应DNS；不要修改仓库内配置文件写入真实值。
2. 在 `admin-server/.env` 中设置与之完全对应的 `LAB_BASE_URL=https://<LAB_SERVER_NAME>`，然后重启后台；尖括号只是说明符，不能原样保留。
3. 确认管理后台 Session Cookie 没有设置任何父域 `Domain`。当前应用未设置 `Domain`，Cookie 为 host-only；真实部署也应保持这一点。
4. 用真实浏览器验证管理后台域名的 Cookie 不会随 `<LAB_SERVER_NAME>`（占位符）请求发送，并复核 CSP、下载、字体和媒体资源行为。

## 当前验证边界

本轮只准备了正式Compose/Nginx配置，没有连接服务器或启动容器。此前也只在localhost完成功能、安全响应头和无 `Set-Cookie` 验证；浏览器请求层面的真实子域名Cookie隔离无法在本轮证明，必须等真实域名、证书和独立Nginx `server` 块启用后再验收。
