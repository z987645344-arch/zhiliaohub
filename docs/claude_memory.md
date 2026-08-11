# 知了hub 项目状态 · 协作记忆
> 用于在后续协作中快速恢复项目上下文。
> 本文只维护当前状态；历史改动见 `CHANGELOG.md`。
> **最后更新：2026-08-11**（小作坊本地功能完成；真实子域名隔离待部署验证）

---

## 项目基本信息

| 项目 | 说明 |
|------|------|
| 项目名 | 知了hub（zhiliaohub） |
| 项目路径 | `D:\zhiliao\zhiliaohub\zhiliaohub\` |
| 当前版本 | `v1.6` |
| GitHub仓库 | `https://github.com/z987645344-arch/zhiliaohub`（Private，是否公开由用户在 GitHub 设置中决定） |
| 定位 | 个人多作品展示网站 |
| 当前主线 | 小作坊已支持后台上传受控ZIP、生成本地静态链接并按需展示在作品页；作品分组、反馈评论和五项导航能力继续保留 |
| 技术栈 | 静态前台为原生 HTML / CSS / JavaScript；独立后台为 Node.js / Express / SQLite / Markdown/marked，并提供保存即静态发布、密码+TOTP及P-256设备挑战登录 |
| CI状态 | 已配置 GitHub Actions；面向 `main` 的 push / pull request 执行 JavaScript 语法与 HTML 本地引用检查，最近运行结果以仓库 Actions 页面为准 |
| 与知天的关系 | 两者是独立仓库、独立部署；知天是本站“作品展示”中的一个条目。计划在 Phase B 通过反向代理拼接子域名，本仓库不包含知天的任何业务逻辑代码 |
| 协作模式 | 知了hub 由独立指挥师负责，与知天的指挥师属于不同协作线程；两边通过各自仓库的 `claude_memory.md` 保存项目状态，不共享对话上下文 |
| 运行边界 | 前台内容读取仍是静态HTML且页面加载不请求后台；只有访客主动提交留言/回复时调用同源公开API。后台已有SQLite持久化session、设备认证、本地备份/恢复及Docker部署片段；安卓App代码位于独立仓库，本仓库仍没有真实服务器/域名/HTTPS、共享配置合并、异地备份或实际部署 |

---

## 当前进行中

| 项 | 说明 |
|------|------|
| 状态 | 🟢 `v1.6` 已完成四轮功能存档；工作区与远程 `main` 保持同步 |
| 本轮完成 | `v1.6` 汇总存档反馈评论系统、作品三分类一级/二级展示、五项导航与智能工具占位，以及小作坊受控ZIP上传、静态访问和按需展示 |
| 交互边界 | 小作坊当前通过localhost `/lab/<slug>/` 提供静态访问，`LAB_BASE_URL`为未来子域名预留。真实 `lab.zhiliaohub.com` DNS、证书及Cookie隔离效果尚未验证，必须在部署阶段测试，不能把本地结果表述为真实隔离完成 |
| 验证结果 | 存档前后台59项测试、42个仓库JavaScript文件语法、19个HTML本地引用和生产依赖审计全部通过；小作坊真实浏览器验证后台、作品页与解压站点在桌面/390px可用且无控制台错误 |

---

## 当前页面与共享资源

| 路径 | 用途 |
|------|------|
| `index.html` | 首页、都市雨巷 OC 插画与雨雾 Canvas 开屏 |
| `works.html` | 后台全量生成的三分类一级索引；程序4条、影视4条、生活0条，每组最多展示4个最新作品 |
| `works-category-program.html` | “程序”分类全部作品的二级网格页 |
| `works-category-film.html` | “影视”分类全部作品的二级网格页 |
| `works-category-life.html` | “生活”分类全部作品的二级网格页；当前显示真实空状态 |
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
| `tools.html` | 手写的智能工具建设状态页；当前无真实工具或账号能力，唯一内容链接进入知天作品说明 |
| `feedback.html` | 后台全量生成的真实反馈页：公开提交、approved顶层留言/二层回复、站长标签及空状态；页面加载不请求后台 |
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
| `admin-server/src/services/publish-service.js` / `src/templates/` | 从SQLite与Markdown全量生成作品、日记和反馈静态页；反馈SQL仅选approved公开列，作品媒体复制到前台四个受控目录并清理失效副本 |
| `admin-server/src/services/feedback-service.js` | 校验反馈字段与两层回复关系，将公开提交写入pending；提供后台主题分组、待审计数、通过、隐藏和固定“站长”直接回复，不负责静态发布 |
| `admin-server/src/services/lab-service.js` | 小作坊slug、ZIP全目录预检与流式解压、zip-slip/炸弹/扩展名防护、显示状态和磁盘清理；项目目录位于不入库的 `lab-storage/` |
| `admin-server/src/services/device-auth-service.js` | 单设备配对码、公钥规范化、挑战签发、P-256验签、重放消费、吊销和替换策略 |
| `admin-server/data/schema.sql` | 内容、TOTP、session、设备、配对码、挑战、反馈审核队列及 `lab_projects` 表结构；works媒体字段已贯通表单与发布，真实SQLite文件不入库 |
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
| 反馈提交必须诚实说明审核状态 | 202只表示进入pending队列；前端固定显示“正在等待审核”，不把接收成功伪装成已公开 |
| 知天只作为展示条目 | 两个项目保持代码与部署边界，本仓库不复制知天代码，也不提前处理反向代理 |
| 后台与静态前台物理隔离 | 后端依赖、运行进程和数据目录只存在于 `admin-server/`，根目录前台继续保持零构建、零运行时依赖 |
| 元数据与正文分离 | SQLite负责标题、日期、分类和摘要查询，Markdown保留长正文的可读性与未来Git版本能力；更新正文使用同目录临时文件原子替换 |
| 保存/审核后全量静态发布 | 作品/日记保存即发布；反馈审核状态先只写SQLite，管理员明确全量发布后用approved-only查询重建反馈页。前台内容读取不依赖后台运行 |
| 反馈先审后发且最多两层 | 公开提交统一pending；只有approved顶层与approved回复进入静态页，邮箱/IP永不公开，蜜罐与按IP限流共同降低滥用风险 |
| 作品下载按条目公开控制 | 只有 `is_downloadable` 开启且存在下载文件时才生成下载按钮；文件作为静态资源公开提供，本阶段不增加登录或其他访问限制 |
| 作品一级/二级分组固定三分类 | 一级页每类按更新时间显示最多4条并支持受控横向滑动，二级页显示该类全部作品；文件名使用稳定英文slug，数据库分类值仍为中文程序/影视/生活 |
| 智能工具入口与知天作品分离 | `tools.html` 当前只是手写静态规划说明；知天继续作为程序类作品。未来工具/API/账号集成必须单独讨论安全、接口和部署方案，不能把占位页误写成已实现能力 |
| 小作坊先做受控静态发布 | 管理员上传的ZIP必须完整通过路径、条目数、解压大小和网页资源扩展名校验后才落入独立slug目录；作品页只展示显式开启的项目。localhost只验证功能与应用层防线，真实子域名隔离留给部署阶段 |
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
- 如需改变作品/日记/反馈页面骨架，修改后台模板后执行全量发布；`index.html`、CSS与JS继续手工维护，`feedback.html`已纳入发布写入和回滚范围。
- 配套App仓库 `zhiliaohub_app` 已完成首次存档 `v0.1` 与真机验证；两仓库版本号各自独立，通过 `admin-server/README.md` 的兼容性说明记录配对关系，本仓库不加入App代码。
- 反馈评论三阶段已经完成；后续日常流程为访客提交→pending→后台审核→手动全量发布，禁止绕过审核直接展示数据库记录。
- 智能工具占位页和五项导航已经建立；智能工具与知天的真实工具、API及账号系统集成方案仍待单独讨论，当前页面仅为静态占位，不代表功能已经实现。
- 小作坊本地上传、解压、静态访问和按需展示已经实现；部署时仍需按 `admin-server/deploy/lab-subdomain.md` 配置 `lab.zhiliaohub.com` 独立静态server块、DNS与HTTPS，并实测Cookie不跨子域共享。

### 待讨论的后续架构决定

- 发布运维：部署时确保后台对静态站点目录拥有受限写权限，并把SQLite、Markdown与生成HTML纳入一致的备份/发布操作流程。
- 后台部署：真实服务器、域名和证书就位后，由用户/运维人员把 `admin-server/deploy/README.md` 中的服务与nginx片段人工合并进共享配置，填写真实占位项并执行上线验证。
- 备份运维：决定定时调度、异地复制、失败告警、密钥托管和服务器恢复演练；当前只有已验证的本地手动备份/恢复。
- 安卓App对接：现有 `zhiliaohub_app v0.1` 已验证Android Keystore P-256密钥、手动配对、DER签名、Cookie持久化、吊销处理与覆盖安装；后续破坏性接口变更需同步维护最低兼容版本。
- Phase B：在部署层处理根域名、知天管理后台/API 子域名及反向代理；相关配置不提前放入本仓库。
