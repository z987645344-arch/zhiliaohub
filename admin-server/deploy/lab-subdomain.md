# 小作坊独立子域名部署说明

当前开发环境通过 `http://localhost:3001/lab/{slug}/` 访问解压后的静态项目。真实部署时应把小作坊放在独立的 `lab.zhiliaohub.com` 主机名下，直接由 Nginx 读取 `admin-server/lab-storage/`，不要把该子域名反向代理到 Node 管理后台。

以下配置只是结构示例，证书路径、站点绝对路径和域名解析必须在真实服务器上填写并核实：

```nginx
server {
    listen 443 ssl http2;
    server_name lab.zhiliaohub.com;

    # 占位：替换为服务器上的真实绝对路径。
    root /ABSOLUTE/PATH/TO/zhiliaohub/admin-server/lab-storage;
    index index.html;

    # 占位：替换为真实证书文件。
    ssl_certificate     /ABSOLUTE/PATH/TO/fullchain.pem;
    ssl_certificate_key /ABSOLUTE/PATH/TO/privkey.pem;

    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

部署时还需要完成：

1. 为 `lab.zhiliaohub.com` 配置真实 DNS 解析和 HTTPS 证书。
2. 在 `admin-server/.env` 中设置 `LAB_BASE_URL=https://lab.zhiliaohub.com`，然后重启后台；无需修改小作坊服务或发布模板代码。
3. 确认管理后台 Session Cookie 没有设置跨子域的 `Domain=.zhiliaohub.com`。当前应用未设置 `Domain`，Cookie 为 host-only；真实部署也应保持这一点。
4. 用真实浏览器验证管理后台域名的 Cookie 不会随 `lab.zhiliaohub.com` 请求发送，并复核 CSP、下载、字体和媒体资源行为。

## 当前验证边界

本轮只在 localhost 完成功能、安全响应头和无 `Set-Cookie` 验证。本地 `/lab/` 与管理后台仍是同一个源，浏览器请求层面的真实子域名 Cookie 隔离无法在本轮证明；该项必须等真实域名、证书和独立 Nginx `server` 块配置完成后再验收。
