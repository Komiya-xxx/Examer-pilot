# ExamerFrame

医学题目发放与质量评价平台。打开网址即可匿名领题；答题时可选「低」「中」「高」评价，未选按「中」保存。评价用于调整之后新题单中同覆盖率候选题的抽样权重。需求、范围与验收以 [PROJECT_SPEC.md](PROJECT_SPEC.md) 为准。

## 本地运行

需要 Node.js 22.23.4 或更高的受支持偶数主版本。本机验证环境为 Node.js 24 和 npm 11。依赖版本以 `package-lock.json` 为准。阶段 0 的静态入口无需配置 Supabase。

```powershell
npm ci
npm run dev -- --host 127.0.0.1
```

浏览器访问 `http://127.0.0.1:4321/`。首访会显示可关闭的试点公告。已配置本地 Supabase 时，页面会自动领题或恢复进度。停止开发服务器后，可执行类型检查、构建及自动化冒烟测试。

```powershell
npm run check
npm run build
npm test
npm run preview -- --host 127.0.0.1
```

`npm test` 检查 `dist/index.html` 与函数的来源策略，应在成功构建后运行。

## 实施计划

`src/pages/` 和 `src/scripts/` 放 Astro 页面和浏览器代码，`test/` 放应用测试。`supabase/migrations/` 管理数据库结构和业务操作，`supabase/functions/` 提供 Edge API，`supabase/tests/` 放数据库测试。`schemas/` 和 `scripts/` 放题目契约与校验工具。前端使用 Astro、TypeScript 和 Supabase SDK，部署阶段再添加 `.github/workflows/`。

| 阶段 | 交付与核验 |
| --- | --- |
| 0 | 初始化独立项目，核验依赖、静态入口、类型检查和生产构建 |
| 1 | 建立八张业务表、migrations 和题目 JSON 校验。验证空库重放、权限及重复版本保护 |
| 2 | 实现匿名身份与会话恢复。用测试夹具验证会话归属与唯一性 |
| 3 | 事务内创建会话与固定题单。验证覆盖率优先、无重复、题库不足回滚和并发 |
| 4 | 保存单选、多选、判断作答。验证输入、顺序、重试与待评恢复 |
| 5 | 保存低、中、高评价并显示概率提示。验证权重、末题完成和会话恢复 |
| 6 | 建立最小题库装载流程，以人工审核的题目演练装载和拒绝覆盖 |
| 7 | 端到端安全验收、CI 和 HTTPS 试点部署，验证备份恢复 |

### 架构与数据核对

- 固定题单与实时重排存在冲突。评价按题目版本改变新题单的组内抽样权重。题量不足时整笔分发回滚。阶段 2 只验证已有会话的契约，阶段 3 接入原子创建。
- 单独使用会话和题目的外键无法保证两者属于同一批次。分配记录引用 `round_questions`，在受控写入中验证同批次、题目发布状态与逻辑题目唯一性。使用唯一约束和事务保证并发重试及最后一次评价与会话完成的一致性。
- 匿名登录用户具有 `authenticated` 角色。Edge 必须验证真实用户 JWT，并从 JWT 派生参与者 ID。迁移显式授予服务端角色必要权限，撤销普通客户端的表访问及受保护 RPC 的执行权限。 [匿名登录](https://supabase.com/docs/guides/auth/auth-anonymous) [Edge 授权](https://supabase.com/docs/guides/functions/auth-headers) [Data API 权限](https://supabase.com/docs/guides/api/securing-your-api)
- ExamPass-Assistant 的题型编码、选项数组和答案索引与本项目数据契约不同。首期人工整理审核后的题目，用有序选项 ID 和版本号装载。上游生成项目与部署仓库分开。

### 阶段 1 本地验收

使用 Python 3.11 或更高版本。在 PowerShell 中创建项目自己的虚拟环境，安装固定版本依赖并验证三种题型的合成样例。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m unittest discover -s test -p 'test_*.py'
.\.venv\Scripts\python.exe -m scripts.validate_questions test/fixtures/questions.json
```

题目文件是 UTF-8 的非空 JSON 数组。结构由 [JSON Schema](schemas/questions.schema.json) 定义。校验器额外检查每题选项 ID 和文件内的题目版本是否重复，只做校验。

在 Docker Linux 引擎可用的终端中，从项目根目录运行 Supabase CLI 3.1.0。当前机器的 Docker 引擎在 WSL Ubuntu，因此以下命令在 Ubuntu 中执行。若 CLI 未加入 PATH，可用同环境的 CLI 可执行文件路径代替 `supabase`。

```bash
docker network inspect examerframe-local >/dev/null 2>&1 ||
  docker network create --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 examerframe-local
supabase db start --network-id examerframe-local
supabase test db --network-id examerframe-local
```

本地配置停用首期未使用的 Storage 和 Realtime。新建本地 PostgreSQL 时会应用 [初始迁移](supabase/migrations/20261110000000_initial_schema.sql)。[数据库测试](supabase/tests/stage1_schema.test.sql) 使用 `service_role` 装载合成记录，并通过事务回滚清除样例。普通客户端角色无权直读或写入业务表。 [Supabase 本地开发](https://supabase.com/docs/guides/local-development) [数据库测试](https://supabase.com/docs/guides/database/testing)

### 阶段 2 本地验收

在能连接 Docker 的 WSL Ubuntu 终端中，从项目根目录启动 PostgreSQL、Auth、REST 和 Edge Runtime。若阶段 1 的数据库服务仍在运行，先用 `supabase stop` 停止本地项目，CLI 会保留本地数据。

```bash
docker network inspect examerframe-local >/dev/null 2>&1 ||
  docker network create --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 examerframe-local
supabase start --network-id examerframe-local -x imgproxy,mailpit,postgres-meta,studio,logflare,vector,supavisor
supabase migration up --local --network-id examerframe-local
supabase test db --network-id examerframe-local
```

将本地 API URL `http://127.0.0.1:54321` 与 `supabase status` 显示的 publishable key 填入项目根目录的 `.env.local`，变量名见 [环境变量示例](.env.example)。在 PowerShell 启动首页并运行集成测试。

```powershell
npm run dev -- --host 127.0.0.1
```

```powershell
$env:EXAMERFRAME_TEST_WSL_DISTRO = 'Ubuntu'
node --env-file=.env.local --test test/stage2.integration.mjs
```

集成测试需要一个没有开放批次的本地测试库。它创建匿名身份与合成会话，在结束后清理本次数据。直接在 Linux 中运行测试时，可省略 `EXAMERFRAME_TEST_WSL_DISTRO`。

本地允许 `http://127.0.0.1:4321` 与 `http://localhost:4321` 调用 Edge 接口。函数通过 Supabase Auth 验证匿名用户 JWT，从已验证的身份取得参与者 ID。托管时通过服务端环境变量 `EXAMERFRAME_ALLOWED_ORIGINS` 设置前端来源。 [Supabase 匿名登录](https://supabase.com/docs/guides/auth/auth-anonymous) [Edge 环境变量](https://supabase.com/docs/guides/functions/secrets)

### 阶段 3 本地验收

阶段 3 将 `start-or-resume-session` 接入事务分发，并用 `get-current-question` 读取当前题。每个批次的分发请求依次执行。已有会话直接读回原题单。新会话从当前批次已启用的发布版本中，按历史发放次数从少到多抽题，同次数随机排序。阶段 3 的质量权重统一为 1。

按阶段 2 的方法启动本地 Supabase，并在 WSL Ubuntu 中应用新迁移、运行数据库测试。若 Edge Runtime 仍在使用阶段 2 的函数配置，先用 `supabase stop` 停止本地项目，保留数据库卷，再重新执行阶段 2 的启动命令。

```bash
supabase migration up --local --network-id examerframe-local
supabase test db --network-id examerframe-local
```

在 PowerShell 中依次运行集成测试。两个测试各自占用开放批次，应在没有开放批次的本地测试库顺序运行，运行后会清理本次合成数据。

```powershell
$env:EXAMERFRAME_TEST_WSL_DISTRO = 'Ubuntu'
node --env-file=.env.local --test test/stage2.integration.mjs
node --env-file=.env.local --test test/stage3.integration.mjs
```

有开放批次和足够的已发布题目时，当前版本会自动领题并展示第一道题，刷新会恢复原题目。没有开放批次时，页面会显示对应提示。作答与评价接口分别在阶段 4 和阶段 5 接入。

## 需要管理员准备的配置

| 时间 | 手动操作 |
| --- | --- |
| 阶段 0 | 无云端配置 |
| 阶段 1 前 | 本机准备 Supabase CLI 和 Docker 兼容容器运行时，或创建独立 Supabase 测试项目供空库与 RLS 验收。创建托管项目时选择区域、限制项目访问权限并妥善保存数据库密码 |
| 阶段 2 | 本地配置已启用匿名登录。使用独立托管测试项目时，在验证 RLS 后启用 Anonymous Sign-ins。将公开 URL 和 publishable key 填入本地 `.env.local` |
| 试点准备 | 确定批次开放时间，提供经过人工审核的题库、数据保留规则和可公开的联系信息 |
| 阶段 7 | 创建独立 GitHub 仓库并选择可见性。若采用 GitHub Pages，在 Settings → Pages 选择 GitHub Actions，配置公开 API 参数和经批准的隐私说明，确定站点 URL，再将真实前端 Origin 配入 Edge Functions 的服务端配置 |

- GitHub Free 的 Pages 用于公开仓库。选择项目站时，Astro 的路径前缀使用仓库名，Edge CORS 的 Origin 使用协议、主机和端口。部署作业使用 Pages 与 OIDC 权限。 [GitHub Pages 发布源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) [Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) [Astro 部署](https://docs.astro.build/en/guides/deploy/github/)
- Supabase 生产 migrations 和 Edge Functions 通过授权运维流程发布。前端构建仅接收公开 URL 和 publishable key，服务端使用 Supabase 注入的 secret。 [本地开发](https://supabase.com/docs/guides/local-development) [数据库迁移](https://supabase.com/docs/guides/deployment/database-migrations) [Edge 环境变量](https://supabase.com/docs/guides/functions/secrets)

## 阶段 0 验收记录

2026-11-09，Windows 本地验收通过。环境为 Node.js 24.19.0、npm 11.17.0、Python 3.14.2 和 Git 2.55.0.windows.5。

| 检查 | 结果 |
| --- | --- |
| `npm install`、`npm ci --offline` | 初装和按锁文件重装均通过 |
| `npm run check` | 0 错误、0 警告 |
| `npm run build` | 生成静态首页 `dist/index.html` |
| `npm test` | 1 项测试通过 |
| 开发和生产预览入口 | 两个本地 HTTP 请求均返回 200 |
| `npm audit --audit-level=high` | 0 个已知依赖漏洞 |
| Git 与凭据 | 独立本地 `main` 已初始化。忽略规则通过，源码与产物的常见凭据格式扫描无匹配 |

阶段 1 的空库和权限验收使用本地 Supabase CLI 和 WSL Ubuntu 的 Docker Linux 引擎。


## 阶段 1 验收记录

2026-11-10，使用 WSL Ubuntu 的 Docker 29.7.2、Supabase CLI 3.1.0 和 PostgreSQL 17.11 完成本地验收。数据库监听 `127.0.0.1:54322`。

| 检查 | 结果 |
| --- | --- |
| Supabase 空库初始化 | 初始迁移 `20261110000000` 已应用 |
| `supabase test db` | 33 项数据库断言通过，验证八表 RLS、普通客户端权限、重复版本、发布后修改与跨批次分配限制。合成数据已回滚 |
| Python | 11 项测试通过，三种题型的合成题目均通过校验 |
| 前端 | 类型检查 0 错误、0 警告，生产构建成功，首页冒烟测试通过 |
| 凭据 | 源码与构建产物的常见凭据格式扫描无匹配 |

阶段 2 将验证本地匿名登录、会话归属与恢复。


## 阶段 2 验收记录

2026-11-10，本地 Supabase API 与 Edge Runtime 在 WSL Ubuntu 中通过验收，API 地址为 `http://127.0.0.1:54321`。已应用会话读取迁移 `20261110000001`。

| 检查 | 结果 |
| --- | --- |
| 数据库 | 48 项 pgTAP 断言通过，其中 15 项验证阶段 2 的时间窗口、归属、进度和恢复 |
| API 集成 | 6 个场景通过，覆盖首次匿名登录、相同身份恢复、关闭批次恢复、跨用户隔离、无效令牌和直连 REST 权限 |
| Chrome | 首次登录、刷新恢复合成会话、显示保存的进度、继续读取同一会话均通过 |
| 跨域 | 直连函数时，允许来源收到精确的来源头，拒绝来源返回 403。标准本地 Kong 网关可完成浏览器预检，未获准来源的实际请求由函数拒绝 |
| 构建与回归 | 类型检查 0 错误、0 警告，生产构建、2 项前端及函数测试、11 项 Python 测试通过 |
| 凭据 | 源码与构建产物的常见私密凭据格式扫描无匹配。npm 依赖审计报告 0 个已知漏洞 |

合成数据已清理。阶段 3 将接入事务内创建会话和固定题单。

## 阶段 3 验收记录

2026-11-10，已在本地 Supabase 应用分发迁移。开放批次可以按历史发放次数分发固定题单，首页只读取和展示当前题目。批次关闭、题目停用或版本退役后，原会话仍可读回已分配的版本。

| 检查 | 结果 |
| --- | --- |
| 迁移与数据库 | 三个迁移在独立空库重放成功。79 项 pgTAP 断言通过，其中 31 项验证新分发逻辑、权限、跨批次隔离、时间窗口、公开字段和失败回滚 |
| API 集成 | 阶段 2、3 各 6 个场景通过。同一身份的四个并发请求复用一份题单，两名新用户并发领题时按历史次数领取不同候选。跨用户读取被拒绝 |
| Chrome | 题库不足时显示提示且不建会话。补齐合成题后重试领题，题干与选项按纯文本显示。关闭批次并退役版本后，刷新仍恢复原题 |
| 构建与回归 | 类型检查 0 错误、0 警告，生产构建、2 项前端及函数测试、11 项 Python 测试通过 |
| 凭据 | 源码和构建产物扫描未发现常见私密凭据格式，产物未发现服务端密钥标记或合成题标记 |

合成数据已清理，本阶段无需配置云端服务。阶段 4 将接入单选、多选和判断题的作答提交及待评恢复。

## 阶段 4 验收记录

2026-11-10，本地已应用作答迁移 `20261110000003`。`submit-answer` 接收会话 ID、题单记录 ID 和答案。数据库按会话顺序保存首份有效答案，多选按原选项顺序去重。同一答案重试复用作答 ID，修改已提交答案返回冲突。页面从服务端恢复待评状态。

- 四个迁移在独立空库重放成功，99 项数据库断言通过，其中 20 项是阶段 4 新增断言。
- 真实 API 验证三种答案、权限、顺序、并发重试和规范化存储。阶段 2 和 3 的接口回归通过。
- Chrome 移动视口验证网络失败时保留选择、重试成功、刷新恢复待评。类型检查、生产构建、前端测试和凭据扫描通过。

合成数据已清理。本阶段无需云端配置。评价和后续发放权重在阶段 5 接入。

## 阶段 5 验收记录

2026-11-10，本地已应用评价和权重迁移 `20261110000004`、`20261110000005`。页面展示三档必填评价和概率提示。服务端为同一作答保留第一份评价，在最后一题的同一个事务中完成会话。批次关闭后仍可完成原题单并恢复结束状态。

- 六个迁移从空库重放成功，129 项数据库断言通过，其中 30 项覆盖评价、完成状态、跨批次版本反馈和固定随机输入。
- 真实 API 验证三种答案、三档评价、重复及冲突提交、权限、顺序、末题完成；分发回归通过。
- Chrome 移动视口跑完匿名领题、答题、待评刷新、评价失败重试和完成后刷新。类型检查、生产构建、前端测试及凭据扫描通过。

合成数据已清理。本阶段无需云端配置。阶段 6 将用同一组合成题验收受控装载。

## 阶段 6：受控装载

确认题目已审核且有权使用后，先校验 UTF-8 JSON。批次须已存在且状态为 `draft`。本地 Docker 默认连接本机引擎；此机器使用 WSL Ubuntu，示例以合成题为输入：

```powershell
.\.venv\Scripts\python.exe -m scripts.validate_questions test/fixtures/questions.json
.\.venv\Scripts\python.exe -m scripts.load_questions test/fixtures/questions.json --round-slug YOUR_DRAFT_SLUG --reviewed --wsl-distro Ubuntu
```

同一逻辑题目在一次装载中只能有一个版本。新版本作为已发布版本写入并关联到草稿批次，脚本不开放批次。相同版本已存在、已有启用版本、批次不存在或不是草稿时，整批回滚。需要在另一个批次复用已发布版本时，由管理员将同一个版本关联到目标草稿批次，无须复制题目。

将最后一个参数换为 `--output-sql question-data/your-batch.sql` 可以只生成 SQL，不连接数据库；目标必须是新文件。此文件包含可解码的题目正文，只在受控位置保存和执行，勿提交 Git 或放入网站目录。托管环境仅由获授权的管理员执行已审查的 SQL。`--reviewed` 只记录操作员的确认，题目内容审核由人完成。

2026-11-10：六个迁移在空库重放后成功装载三种题型。用真实本地 Docker CLI 验证重复版本和启用版本冲突均有明确提示，前置写入回滚；不存在及已关闭批次也被拒绝。15 项 Python 测试、类型检查、生产构建、2 项前端及函数测试和凭据扫描通过。临时批次已清理，未使用课程原件。


## 阶段 7：托管试点发布清单

本地检查使用合成数据。正式试点开放前，需要管理员完成以下事项：

1. **Supabase**：选择独立试点项目、区域和管理人员。在管理端启用匿名登录，将匿名注册按来源 IP 限为每小时 30 次，结合预计参与者可能共用校园或机构出口网络的情况试跑。确认数据库备份方式、恢复目标和操作权限。参见 [匿名登录](https://supabase.com/docs/guides/auth/auth-anonymous)及 [Auth 限流](https://supabase.com/docs/guides/auth/rate-limits)。
2. **部署后端**：授权运维人员通过 Supabase CLI 对独立试点项目应用 `supabase/migrations/`，核对 RLS 和 RPC 权限，再部署 `get-active-round`、`start-or-resume-session`、`get-current-question`、`submit-answer` 和 `submit-rating` 五个 Edge Functions。函数沿用 `supabase/config.toml` 对应配置，并在内部向 Auth 核验参与者令牌。把 `EXAMERFRAME_ALLOWED_ORIGINS` 设置为真实站点 Origin（例如 `https://OWNER.github.io`，不含仓库路径），只在服务端保留 secret key。参见 [Supabase CLI 开发与发布流程](https://supabase.com/docs/guides/local-development/cli-workflows)及 [Edge Functions 认证](https://supabase.com/docs/guides/functions/auth-headers)。
3. **GitHub**：创建独立仓库并选定可见性。确认 Git 不包含 `source/`、`results/`、题库导出或本地环境变量，再推送代码。按 [GitHub Pages 发布源说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages)在 Settings → Pages 选择 GitHub Actions。配置以下 Actions 仓库变量，CI 通过后手动运行 `Deploy GitHub Pages`：
   - `PUBLIC_SUPABASE_URL`：试点 Supabase 的 HTTPS 项目 URL。
   - `PUBLIC_SUPABASE_PUBLISHABLE_KEY`：同一项目的 publishable key。
   - `EXAMERFRAME_PRIVACY_RETENTION`：批准公开的数据保留说明。
   - `EXAMERFRAME_PRIVACY_CONTACT`：批准公开的联系与删除途径。
4. **试点内容**：管理员确定批次名称、开放时间和每会话题量，复核题目内容和使用许可，再装载到草稿批次。公开试跑先用合成题，验证真实 HTTPS 地址、路径刷新、手机操作、匿名身份、CORS、权限隔离和备份恢复。确认后再开放审核后的试点批次。

业务提交按匿名身份共享每分钟 60 次额度；领题、作答和评价占用额度，刷新查看不占用。到达上限时返回 `429` 和 `Retry-After: 60`。试点数据保留与删除方案需涵盖认证身份、业务表、限流记录和备份；其中限流表只保存身份 UUID、窗口时间和计数。

本地恢复演练在隔离 PostgreSQL 库进行：两个空库分别重放 migrations，在源库装载合成题并产生一份真实作答和评价，用 `pg_dump --data-only --schema=public -Fc` 导出八张业务表，再用 `pg_restore --data-only --exit-on-error --single-transaction` 恢复到目标库。对比版本、分配、作答和评价并复核客户端权限。托管试点应另在隔离环境验证 Auth 身份和业务记录能够一并恢复，记录恢复时间和可接受的数据损失范围。


## 阶段 7：本地复验

本地 Supabase 启动且 migrations 已全部应用后，在没有开放批次的本地测试库运行。测试会建立并清理专用的合成题单和匿名身份；不要指向托管项目。仅在 Docker 位于 WSL Ubuntu 时设置 `EXAMERFRAME_TEST_WSL_DISTRO`：

```powershell
$env:EXAMERFRAME_TEST_WSL_DISTRO = 'Ubuntu'
node --env-file=.env.local --test --test-concurrency=1 test/stage2.integration.mjs test/stage3.integration.mjs test/pilot.integration.mjs
# 保持 npm run dev 或 npm run preview 在 127.0.0.1:4321 运行。
# Chrome 不在默认路径时设置 EXAMERFRAME_CHROME_PATH。
node --env-file=.env.local test/browser.integration.mjs
node scripts/check-static-output.mjs dist
```

2026-11-10：

| 项目 | 验收结果 |
| --- | --- |
| 数据库与权限 | 七个迁移在独立空库重放，160 项 pgTAP 断言通过 |
| 真实本地 API | 会话、分发和试点流程回归通过。共享写额度第 60 次允许，后续提交返回 429；只读请求可继续、其他身份不受影响 |
| 浏览器 | Chrome 390px 视口通过匿名领题、三种题型、答题与评价失败重试、待评刷新和完成刷新 |
| 构建与发布配置 | 15 项 Python 测试、TypeScript 检查、生产构建和前端测试通过；静态扫描通过。模拟 Pages 仓库路径，首页与 JS 资源均返回 200。缺少公开隐私说明时拒绝发布构建 |
| 恢复 | 两个独立库之间恢复并对比八张业务表；匿名客户端权限仍受限 |
| 匿名注册限流 | 本地 Auth 容器已加载每小时 30 次配置；本地网关和直连突发测试均未触发 429。本地 Auth 没有配置可信限流请求头；[该版本的 Auth 实现](https://github.com/supabase/auth/blob/v2.197.0/internal/api/middleware.go)在没有可信转发地址和限流请求头时跳过限流。开放前需在实际托管环境验证 |
| 托管验收 | 首尔试点后端已部署，权限与接口拒绝测试通过；网站、匿名注册与托管恢复仍待验收。见下方记录 |

## 阶段 7：托管试点后端验收（2026-11-11）

在独立的 Supabase 首尔试点项目部署了七个迁移和五个 Edge Functions。

- 云端只读核对：七个迁移齐全；八张业务表与一张私有限流表均开启 RLS，浏览器角色无法直接访问；九个 RPC 只向服务端角色开放，试点库未装载题目或创建批次。
- 托管接口：五个函数均处于 ACTIVE 状态。缺失或无效令牌返回 HTTP 401，未授权来源返回 HTTP 403。用 publishable key 直接读取题目表和调用内部 RPC 均被拒绝。
- 前端回归：类型检查、生产构建、两项前端测试及静态凭据扫描通过。

托管匿名注册仍关闭。配置实际网站 Origin、发布静态站点后，再验收匿名会话、完整答题评价、匿名注册限流和托管备份恢复。
