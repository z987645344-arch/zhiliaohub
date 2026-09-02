# 小作坊独立子域名部署说明

当前开发环境通过 `http://localhost:3001/lab/{slug}/` 访问解压后的静态项目。真实部署时应把小作坊放在独立主机名下：公网 HTTPS 与主机名路由由 `zhiliao-gateway` 提供，hub Nginx 只在回环上以明文 HTTP 读取持久化的 `lab-storage`，不把该主机名反向代理到Node管理后台。

根目录 `docker-compose.yml` 与 `deploy/nginx.conf` 已把这一结构整理为正式配置：同一个 `ADMIN_LAB_STORAGE_PATH` 对后台容器读写挂载、对hub Nginx只读挂载。gateway 处理对外 HTTPS 与公开主机名，并保留 `Host` 转发到回环端口；hub Nginx 再以对应的 `LAB_SERVER_NAME` 选中下面的纯 HTTP 静态 `server` 块。片段只解释最终结构，不需要手工复制到仓库配置：

```nginx
server {
    listen 80;
    server_name ${LAB_SERVER_NAME};

    # Compose 将同一 ADMIN_LAB_STORAGE_PATH 以只读方式挂载到该路径。
    root /srv/zhiliaohub-lab;
    index index.html;

    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

部署时还需要完成：

1. 在服务器根目录 `.env` 中设置真实 `LAB_SERVER_NAME` 与 `ADMIN_LAB_STORAGE_PATH`；在 `zhiliao-gateway` 的现场配置中设置同一公开主机名，并在gateway侧配置DNS与证书。hub 不再配置证书路径；不要修改仓库文件写入现场真实值。
2. 在 `admin-server/.env` 中设置与之完全对应的 `LAB_BASE_URL=https://<LAB_SERVER_NAME>`，然后重启后台；尖括号只是说明符，不能原样保留。
3. 确认管理后台 Session Cookie 没有设置任何父域 `Domain`。当前应用未设置 `Domain`，Cookie 为 host-only；真实部署也应保持这一点。
4. 用真实浏览器验证管理后台域名的 Cookie 不会随 `<LAB_SERVER_NAME>`（占位符）请求发送，并复核 CSP、下载、字体和媒体资源行为。

## 当前验证边界

旧版Compose/Nginx基线曾用于主站真实部署，但仓库当前的gateway版本尚未生产生效；现有证据对小作坊仍只覆盖localhost下的功能、安全响应头和无 `Set-Cookie` 验证。浏览器请求层面的真实子域名Cookie隔离尚未验收；必须在真实小作坊域名、gateway证书与hub Nginx独立静态 `server` 块启用后，用真实浏览器确认Cookie、CSP、MIME、缓存和下载行为。
