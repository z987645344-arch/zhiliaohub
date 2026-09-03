# 知了hub

知了hub 是用于整理和展示个人作品、学习心得、反馈交流与持续探索的多页面网站，公开地址为 [https://zhiliaohub.com](https://zhiliaohub.com)。当前最新Git标签为 `v2.9`；仓库已完成面向唯一前置gateway的新部署配置，生产实际运行版本不在本文档中断言。

访客前台仍使用原生 HTML、CSS 和 JavaScript，不需要前端构建工具；作品、日记和已审核反馈由独立的 Node.js/Express 管理后台在发布时生成静态 HTML。页面读取保持静态，只有访客主动提交留言或回复时会调用后台公开 API。

“知天”（zhitian）是“作品展示”中的一个独立作品，与知了hub 使用独立仓库、账号、数据和部署。本仓库不包含知天业务代码。

## 当前能力

- 五项静态前台：首页、作品展示、学习心得、智能工具、反馈中心。
- 作品按程序/影视/生活分组，支持分类二级页、媒体展示、版本日志和按作品开关控制的公开下载。
- `admin-server/` 提供密码+TOTP、P-256设备挑战登录、SQLite持久会话、作品/日记管理、静态发布和受控上传。
- 反馈系统采用公开提交、pending审核队列、后台通过/隐藏/站长回复和approved-only静态发布。
- 小作坊支持管理员上传经过安全校验的网页ZIP，并生成独立静态访问内容。
- 备份体系默认覆盖SQLite、Markdown和 `uploads/` 全部文件，支持校验、可选加密、恢复前快照、定时备份和同机副本模拟；如设置 `BACKUP_EXCLUDE_ZIP=true`，ZIP内容不入归档，只在 `manifest.excluded` 留存路径、大小与SHA-256，恢复后需由用户从本地补齐。**一份“静默地少了东西”的备份比没有备份更危险。**常规备份默认保留3份，真实异地容灾仍未完成。
- 配套 Android App 位于独立仓库 `zhiliaohub_app`，当前版本为 v0.3.1。

## 仓库结构

- 根目录 HTML、`css/`、`js/`、`assets/`：访客静态前台。
- `admin-server/`：Express后台、SQLite/Markdown数据层、静态生成、上传、反馈、小作坊和备份恢复。
- `docker-compose.yml`、`deploy/nginx.conf`：仓库已完成的Compose与回环HTTP后端基线；公网HTTPS由独立 `zhiliao-gateway` 终止，拓扑与部署边界见 `docs/zhiliaohub_structure.md` 和 `admin-server/deploy/README.md`。
- `docs/claude_memory.md`：当前状态。
- `docs/zhiliaohub_structure.md`：技术架构。
- `docs/claude_skill.md`：协作与验证规范。

本地后台运行、接口和备份说明见 [`admin-server/README.md`](admin-server/README.md)，生产更新与迁移说明见 [`admin-server/deploy/README.md`](admin-server/deploy/README.md)。真实 `.env`、SQLite、上传、备份、小作坊运行文件和服务器路径均不进入 Git。
