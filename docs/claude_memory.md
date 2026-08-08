# 知了hub 项目状态 · 协作记忆
> 用于在后续协作中快速恢复项目上下文。
> 本文只维护当前状态；历史改动见 `CHANGELOG.md`。
> **最后更新：2026-08-08**（编辑作品重构三阶段全部完成并通过真实浏览器验证）

---

## 项目基本信息

| 项目 | 说明 |
|------|------|
| 项目名 | 知了hub（zhiliaohub） |
| 项目路径 | `D:\zhiliao\zhiliaohub\zhiliaohub\` |
| 当前版本 | `v1.5` |
| GitHub仓库 | `https://github.com/z987645344-arch/zhiliaohub`（Private，是否公开由用户在 GitHub 设置中决定） |
| 定位 | 个人多作品展示网站 |
| 当前主线 | “编辑作品重构”三阶段已完成：新字段与分类迁移、后台媒体表单/裁剪上传、发布媒体复制清理及Steam风格前台展示已全部贯通 |
| 技术栈 | 静态前台为原生 HTML / CSS / JavaScript；独立后台为 Node.js / Express / SQLite / Markdown/marked，并提供保存即静态发布、密码+TOTP及P-256设备挑战登录 |
| CI状态 | 已配置 GitHub Actions；面向 `main` 的 push / pull request 执行 JavaScript 语法与 HTML 本地引用检查，最近运行结果以仓库 Actions 页面为准 |
| 与知天的关系 | 两者是独立仓库、独立部署；知天是本站“作品展示”中的一个条目。计划在 Phase B 通过反向代理拼接子域名，本仓库不包含知天的任何业务逻辑代码 |
| 协作模式 | 知了hub 由独立指挥师负责，与知天的指挥师属于不同协作线程；两边通过各自仓库的 `claude_memory.md` 保存项目状态，不共享对话上下文 |
| 运行边界 | 前台仍可直接打开HTML且不发送数据；后台已有SQLite持久化session、设备认证、本地备份/恢复及Docker部署片段；安卓App代码位于独立仓库，本仓库仍没有真实服务器/域名/HTTPS、共享配置合并、异地备份或实际部署 |

---

## 当前进行中

| 项 | 说明 |
|------|------|
| 状态 | ✅ `v1.5` 已将编辑作品重构三阶段作为单一提交存档并推送，`main` 与同名带注释标签均指向该版本 |
| 本轮完成 | 前台列表接入图片封面与CSS回退，详情改为主媒体+辅图条+信息面板+版本日志的Steam风格showcase；辅图可切换图片/视频，下载和体验按钮按作品数据条件渲染，所有作品详情移除“登录入口” |
| 交互边界 | 前台仍是零运行时后端请求的静态HTML；作品下载是无额外访问限制的公开静态文件，由每个作品独立开关控制；前台登录/编辑、反馈、评论、跟评和知天正式入口仍未开放，内容编辑只通过本地管理后台进行 |
| 验证结果 | 后台44项自动化测试、37个JavaScript文件语法检查和16个HTML本地引用检查通过。真实浏览器逐页验证8个旧作品与一个临时全媒体作品：桌面/390px无横向溢出或控制台错误，旧作品回退CSS封面和空版本日志，主图、2辅图切换、ZIP真实下载及体验新窗口均正常；临时作品已删除并重新发布，最终恢复8作品/3日记、前台媒体0个。用户此前确认裁剪移动与四角缩放正常 |

---

## 当前页面与共享资源

| 路径 | 用途 |
|------|------|
| `index.html` | 首页、都市雨巷 OC 插画与雨雾 Canvas 开屏 |
| `works.html` | 后台全量生成的作品索引；当前8条：混剪、AI音乐、AI视频、建模、网页设计、知历、知了、知天 |
| `works-mix-video.html` | 创作混剪视频详情与工作日志占位 |
| `works-ai-music.html` | AI音乐作品详情与工作日志占位 |
| `works-ai-video.html` | AI视频作品详情与工作日志占位 |
| `works-3d-model.html` | 建模作品详情与工作日志占位 |
| `works-web-design.html` | 网页设计作品详情与工作日志占位 |
| `works-zhili.html` | 软件“知历”详情与工作日志占位 |
| `works-zhiliao.html` | 软件“知了”详情与工作日志占位 |
| `works-zhitian.html` | 系统“知天”详情、工作日志和正式展示入口占位 |
| `notes.html` | 后台全量生成的日记索引；当前3条均明确标注为占位内容 |
| `notes-rain-window.html` | 占位日记《雨落在窗外的时候》详情模板 |
| `notes-learning-path.html` | 占位日记《把学习路径画成一条线》详情模板 |
| `notes-small-progress.html` | 占位日记《小进展也值得留下》详情模板 |
| `feedback.html` | 反馈表单、评论输入、占位评论和缩进跟评UI |
| `css/style.css` | 全站水泥灰/雾蓝灰视觉系统、列表、详情、评论及响应式规则 |
| `js/site.js` | 导航、年份、辅图切换和仍未开放操作的本地提示 |
| `js/particles.js` | 首页原生 Canvas 雨滴与雾气动画 |
| `assets/reference/oc-three-view.jpg` | 用户提供的 OC 角色三视图，仅保存在本地并由 `.gitignore` 排除，不进入 GitHub |
| `assets/hero-oc-rain-alley.webp` | 首页都市烟雨主视觉静态插画，62,250字节 |
| `assets/works-oc-creative-passage.webp` | 作品页创作廊道插画，78,952字节 |
| `assets/notes-oc-rain-writing.webp` | 学习心得页雨窗书写插画，67,852字节 |
| `assets/feedback-oc-message-slot.webp` | 反馈页城市留言槽插画，65,164字节 |
| `.github/workflows/ci.yml` | 面向 `main` 的轻量CI：JavaScript语法检查与HTML本地引用检查 |
| `admin-server/package.json` / `package-lock.json` | 后台独立Node.js依赖、运行命令与锁文件；不为前台引入构建工具 |
| `admin-server/src/` | Express服务、认证、SQLite会话/CSRF、内容原子写入、静态发布模板与服务、上传策略、备份恢复和服务端管理界面 |
| `admin-server/src/services/publish-service.js` / `src/templates/` | 从SQLite与Markdown全量生成作品/日记列表和详情页；复制作品引用媒体到前台四个受控目录并清理失效副本；作品模板已展示封面、主/辅媒体、下载、体验和版本日志 |
| `admin-server/src/services/device-auth-service.js` | 单设备配对码、公钥规范化、挑战签发、P-256验签、重放消费、吊销和替换策略 |
| `admin-server/data/schema.sql` | 内容、TOTP、session、设备、配对码和挑战表结构；works封面、下载、体验、主媒体、辅图与版本日志字段已接入后台表单和服务，真实SQLite文件不入库 |
| `admin-server/content/works/` / `content/notes/` | 后台生成的Markdown正文目录；未来内容版本历史依赖人工Git提交，本轮没有单独回滚系统 |
| `admin-server/uploads/` | 白名单上传目录，支持带PK签名校验的ZIP，默认统一上限100MiB；只提交 `.gitkeep`，真实文件由 `.gitignore` 排除 |
| `admin-server/backups/` | 本地备份目标目录，只提交 `.gitkeep`；真实归档由 `.gitignore` 排除，默认保留最近7份 |
| `admin-server/scripts/backup.js` / `restore.js` | 创建与恢复SQLite、Markdown和上传文件归档；恢复要求显式 `--force` 且服务必须停止 |
| `admin-server/scripts/hash-password.js` | 在交互式终端中无回显输入并确认管理员密码，只输出用于 `ADMIN_PASSWORD_HASH` 的 bcrypt 哈希 |
| `admin-server/scripts/migrate-existing-content.js` | 一次性导入原8个作品与3篇日记；默认只预览，应用时要求显式确认服务已停止，并拒绝重复执行或非空内容表 |
| `admin-server/Dockerfile` / `.dockerignore` | 非root多阶段后台镜像定义与构建上下文排除规则；本轮未实际构建镜像 |
| `admin-server/deploy/README.md` | 需人工合并进服务器共享Compose/nginx的片段、占位项与上线顺序，不含真实域名、IP、密钥或证书路径 |
| `admin-server/tests/device-auth.test.js` | 安卓设备配对、挑战登录、错误/重放/过期、吊销和自动替换的端到端验证 |
| `admin-server/tests/` | 后台认证、安全边界、session持久化、设备认证、内容一致性、原子写入、上传及备份恢复验证；覆盖清单维护在 `admin-server/README.md`“测试”章节 |

---

## 架构决定与产品原则

| 决定 | 理由 |
|------|------|
| 继续使用独立静态 HTML 页面 | 访客仍直接读取HTML，不引入客户端路由、前端框架或运行时API请求；内容页改由后台发布时生成 |
| 内容页统一模板、共享 CSS/JS | 作品/日记列表和详情由 `admin-server/src/templates/` 统一生成，继续复用现有视觉类、导航、页脚与本地脚本 |
| 分类封面使用 CSS 几何图形 | 8个分类只需清楚区分，不为每个条目增加不必要的AI图片和加载成本 |
| 栏目插画沿用同一角色锚点 | 首页、作品、日记和反馈形成一致的都市烟雨叙事，同时所有图片均为本地静态资源 |
| v1.0 使用单一创世提交 | 此前没有提交历史，不把已完成过程伪装成分阶段提交；当前完整状态作为首次正式基线 |
| CI只覆盖确定性的静态检查 | 当前CI会语法检查已提交的后台JavaScript，但不会安装后端依赖或执行端到端测试；是否扩展CI需在后续结合运行成本单独决定 |
| 未接后端的功能必须明确不可用 | 不制造虚假的成功反馈；所有按钮都说明真实边界，评论和表单内容不会离开页面 |
| 知天只作为展示条目 | 两个项目保持代码与部署边界，本仓库不复制知天代码，也不提前处理反向代理 |
| 后台与静态前台物理隔离 | 后端依赖、运行进程和数据目录只存在于 `admin-server/`，根目录前台继续保持零构建、零运行时依赖 |
| 元数据与正文分离 | SQLite负责标题、日期、分类和摘要查询，Markdown保留长正文的可读性与未来Git版本能力；更新正文使用同目录临时文件原子替换 |
| 保存即全量静态发布 | 不设草稿状态；新增、编辑、删除成功后重建全部作品/日记页面，清除带生成标记的死页，前台访问时不依赖后台运行 |
| 作品下载按条目公开控制 | 只有 `is_downloadable` 开启且存在下载文件时才生成下载按钮；文件作为静态资源公开提供，本阶段不增加登录或其他访问限制 |
| 同记录更新在单进程内串行化 | SQLite与文件系统不能组成同一事务；作品/日记按记录排队可避免并发请求造成元数据与正文交叉覆盖，但不宣称支持多实例并发 |
| session与元数据共用SQLite持久化 | 避免默认MemoryStore在服务重启后丢失全部登录态，也不引入Redis等额外运维组件；数据库和 `SESSION_SECRET` 都必须持久化 |
| 设备认证是并行第二入口 | 密码+TOTP不被替换；只有该方式建立的session可以生成配对码，设备session不能自我扩张授权 |
| 单设备采用P-256挑战应答 | Node内置crypto验证Android兼容的 `SHA256withECDSA` DER签名；私钥始终留在App，新配对自动替换旧公钥并使旧设备session失效 |
| 主站与App版本各自独立 | `zhiliaohub` 与 `zhiliaohub_app` 不强行对齐标签；通过 `admin-server/README.md` 兼容性说明维护服务端与App最低版本配对关系 |
| 本地备份覆盖三个数据面 | SQLite快照、Markdown和上传文件共同进入带校验清单的归档；可选加密和保留策略已验证，但本地副本不能替代异地备份 |
| 单管理员采用密码 + TOTP | 密码只从环境变量读取bcrypt哈希，TOTP密钥加密后本地保存；失败按IP限流但不锁账号，避免账号锁定型拒绝服务 |
| 后台当前不是生产系统 | 持久化会话、本地备份和部署片段不等于上线；仍没有真实域名/HTTPS、服务器合并、定时与异地备份、监控或生产恢复演练 |

---

## 接下来规划

### 当前后续内容完善

- “编辑作品重构”三阶段已经完成；后续新增真实作品时直接通过后台填写封面、主/辅媒体、下载设置、体验链接和版本日志，由保存即发布链路生成前台页面。
- 未来作品/日记新增与编辑统一通过管理后台完成；不要手工修改带“自动生成”标记的列表或详情页。
- 逐步用真实作品封面、展示内容与工作日志替换筹备状态；知天获得正式地址后再开放展示入口。
- 日记条目获得真实正文后替换占位标题、日期与摘要，并重新校对页面元信息。
- 如需改变作品/日记页面骨架，修改后台模板后执行全量发布；`index.html`、`feedback.html`、CSS与JS继续手工维护且不在发布写入范围。
- 配套App仓库 `zhiliaohub_app` 已完成首次存档 `v0.1` 与真机验证；两仓库版本号各自独立，通过 `admin-server/README.md` 的兼容性说明记录配对关系，本仓库不加入App代码。

### 待讨论的后续架构决定

- 发布运维：部署时确保后台对静态站点目录拥有受限写权限，并把SQLite、Markdown与生成HTML纳入一致的备份/发布操作流程。
- 后台部署：真实服务器、域名和证书就位后，由用户/运维人员把 `admin-server/deploy/README.md` 中的服务与nginx片段人工合并进共享配置，填写真实占位项并执行上线验证。
- 备份运维：决定定时调度、异地复制、失败告警、密钥托管和服务器恢复演练；当前只有已验证的本地手动备份/恢复。
- 安卓App对接：现有 `zhiliaohub_app v0.1` 已验证Android Keystore P-256密钥、手动配对、DER签名、Cookie持久化、吊销处理与覆盖安装；后续破坏性接口变更需同步维护最低兼容版本。
- 数据库与评论持久化：先确定数据模型、隐私说明、审核与反滥用方案；当前评论不会发送、保存或公开展示。
- 反馈后端：确定接收API、字段校验、数据保留与失败处理后再实现真实提交；接通前持续保持“暂未开放”。
- Phase B：在部署层处理根域名、知天管理后台/API 子域名及反向代理；相关配置不提前放入本仓库。
