# 自动提取流水线（不依赖 Codex）

日常提取由普通 Python 程序执行，不使用大模型、Codex API、聊天会话或人工浏览器操作。
`extract_sections.py` 是底层抓取器；`sync_sections.py` 负责把多个步骤串成固定流程。
支持 macOS / Linux，提取部分使用 Python 3.12+ 标准库；数据库导入使用 Node.js 22.12+ 和现有后端依赖。无需 AWS 或管理员密码。

## 日常使用

编辑一次 [配置文件](../config/sections-pipeline.json)，然后执行：

```sh
# 终端一：启动持久化本地数据库、API 和网站（首次使用先按本地网站文档安装）
npm run dev:web

# 终端二：已有正式快照可直接导入，无需重新抓取
npm run sections:import

# 检查配置及执行范围，不联网、不写数据
npm run sections:sync -- --plan

# 一次完整更新：提取、验证、发布并自动导入本地数据库
npm run sections:sync

# 查看是否成功、是否超过 48 小时未成功更新
npm run sections:status
```

也可直接启动 Python 入口；启用数据库导入时仍需 PATH 中的 Node：

```sh
python3 /Users/zel777/campus-essentials/scripts/sync_sections.py \
  --config /Users/zel777/campus-essentials/config/sections-pipeline.json
```

绝对路径入口不依赖工作目录。换电脑时替换项目路径即可。输出目录及配置中的相对路径
以项目根目录为基准。该命令可以由系统任务调度器调用；**本次没有安装或启用定时任务**。
关闭 Codex 不影响独立启动的 Python 进程。电脑关机或睡眠时，本机任务不能持续执行；
需要持续无人值守时，应在常开的主机运行同一入口。

## 固定流程

### 逐步扩大到其他学科

保持 `npm run dev:web` 运行，在另一终端执行：

```sh
npm run sections:expand                 # 每批最多尝试 3 个尚未处理的学科
npm run sections:expand -- --status     # 查看队列及失败原因，不发起抓取
npm run sections:expand -- --subjects AERO ASTR DATA --batch-size 3
npm run sections:expand -- --retry-failed --subjects CSC
npm run sections:expand -- --refresh --subjects AERO # 明确刷新已完成学科
```

首次运行从官方公开搜索表单读取学科选项，与当前目录的校区和学科代码做精确匹配，
把队列存入 `data/sections/expansion.report.json`。未匹配的官方代码及目录中未出现于
搜索表单的学科单独列出；不会推测旧代码与新代码的对应关系。下拉选项表示可搜索的
学科，不代表它们在选定学期一定有开课。

每个学科先读取完整结果清单，自动选择实际开设的第一门课程做预检，然后调用下面的
提取、离线回放、质量检查和数据库导入流程。来源证据保存在 `.runs/expansion/`；
队列保存每个学科的原始观察、历史流水线报告地址、导入统计和失败原因。
中断后重跑会重新处理正在进行的学科；已完成、明确无开课和失败的学科默认跳过，
失败必须用 `--retry-failed` 明确重试。`--refresh` 配合 `--subjects` 刷新指定学科。

官方目前限制一次查询最多 300 个班级。超过上限的学科记为 `result_limit`，需要后续
分段查询适配，不会把部分结果伪装成全学科成功。来源访问限制会停止本批处理。
明确无开课时记为 `no_sections`，不删除旧记录，也不表示没有教材。
普通 `sections:sync` 仍按配置中的显式 jobs 刷新；扩大覆盖使用 `sections:expand`，
不会自动改写原来的 BIO 配置。两种命令都不安装定时任务。

1. **读取配置、加锁**：确认学期、校区、学科和检查阈值；同一输出目录只允许一个流水线进程。
2. **小范围预检**：查询配置中的 `pilotCourse`；没有班级或页面解析失败就停止该学科。
3. **全学科提取**：包括开放、已满等所有状态；新数据先保存到本次运行的暂存目录。
4. **自动离线回放**：用刚保存的来源页面重新解析，不联网；无需手动运行第二条命令。
5. **质量检查**：检查完整性、唯一 ID、学期/校区/学科、内容校验值、最低数量及记录消失比例。
6. **更新正式快照**：检查通过后原子替换该学科的 JSON，保留来源、变更统计、旧快照备份和日志。
7. **导入数据库**：在线模式下，将正式快照映射到现有 catalog course，通过后端验证、版本检查和引用保护事务写入本地 section 表记录。
8. **输出状态**：无论成功或失败，都写入机器可读报告并返回退出码。

网络连接失败默认等待 15 秒，换全新会话重试一次。访问限制、登录页、429、结构变化、
质量检查失败不会自动重试。不会绕过验证码，也不会调用大模型临时“修复”解析规则。
如果网站改版，需要开发者更新适配器；日常运行不需要 Codex。

## 配置与安全更新

默认是 Fall 2026、MAIN/SLO、BIO，使用 BIO 1111 做预检。更换学期只改 `term` 和该学期
实际开设的 `pilotCourse`；官方学期代码不能根据年份猜测。增加学科是在 `jobs` 数组增加一项：

```json
{"subject": "BIO", "pilotCourse": "1111", "minimumSections": 1}
```

其他参数：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `delaySeconds` | 1 | 每个网络请求至少间隔一秒 |
| `connectionRetries` | 1 | 连接故障最多重跑一次该步骤 |
| `retryDelaySeconds` | 15 | 重试前等待时间 |
| `maxRemovalFraction` | 0.25 | 超过 25% 旧 ID 消失时拒绝更新，即使总条数没减少 |
| `minimumSections` | 1 | 该学科低于此数量时拒绝更新 |
| `staleAfterHours` | 48 | 状态检查认为数据过期的时间；不是定时刷新间隔 |

数量阈值失败时先查看来源和报告；只有确认是真实课表变化，才调整配置重跑。
“未列出教材链接”是数据状态，**不会**作为抓取失败，也不意味着不需要教材。

JSON 快照按学科原子发布，多个学科不构成一个事务。发布前失败时，其旧快照保留；
其他学科可以完成，整个运行仍返回失败。不要同时运行底层 `sections:extract` 修改同一正式文件，
底层命令用于调试，不参与流水线锁。

## 自动导入规则

配置中的 `databaseImport.enabled` 默认开启，目标为 `127.0.0.1:8765` 的
`campus-essentials-local` 表，课程映射使用 `data/catalog/2026-2028.json`。
导入器固定使用回环地址和假 AWS 凭据，不会连接 AWS；数据库不可用时明确失败。
设为 `false` 可只更新文件。离线回放模式始终跳过数据库写入。

导入前检查整个快照的完整性、内容校验值、来源、链接身份，以及每一条班级的课程映射。
按学科、课程号、目录版本和校区匹配已有课程；未匹配或存在歧义时停止，不猜测关联。
目前支持 MAIN→San Luis Obispo、SOLA→Solano，其他校区需要显式增加映射。

- 新班级创建，受导入器管理的班级按当前版本更新；同一快照重复导入不增加记录或版本。
- 人工创建的班级及管理员修改过的导入班级保留，报告记为 `protected`。
- 来源时间早于已导入观察的数据拒绝更新。`sourceRetrievedAt` 是来源获取时间，数据库的 `updatedAt` 是写入时间。
- 每条记录及其引用计数在同一事务中写入；全批次不是单个事务，中途冲突可能已有部分成功。
- 来源中消失的班级不会自动删除。手动删除也不是永久屏蔽，后续同步可能重新创建仍在来源中的班级。
- 只写班级和官方教材入口，不创建 book、materialRequirement 或 offer，不把缺失链接解释成无需教材。

数据库阶段失败时，已验证发布的 JSON 保留，流水线返回失败并记录阶段和原因。
恢复数据库后直接重试导入即可，无需重新访问学校网站：

```sh
npm run sections:import -- --dry-run # 验证映射及数据库中的课程，不写记录
npm run sections:import            # 导入配置中各学科的正式快照
npm run sections:import -- --snapshot data/sections/2268-MAIN-BIO.json
```

独立导入报告默认是快照旁的 `*.import.report.json`，包含开始/结束时间、目标、
新增/更新/未变化/受保护数量、逐条结果和失败原因。流水线另在本次运行目录保留
`database-import.report.json`、日志及汇总。重复运行会覆盖独立入口的最新报告。

## 查看结果和排查失败

- `data/sections/2268-MAIN-BIO.json`：最近通过完整检查的正式数据。
- `data/sections/pipeline.report.json`：最近运行的阶段、模式、成功/失败、数量、变更、日志位置。
- `data/sections/.runs/pipeline/<run-id>/report.json`：每次运行的历史报告。
- 同目录下的 `BIO/*.log`：预检、提取、回放各阶段日志；`previous.json` 保存更新前的快照。
- 来源 HTML 与 `capture.json` 随各阶段保留在 `.runs/` 内，便于复现。

退出码：`0` 全部成功；`1` 失败、配置错误或状态检查不健康；`2` 有另一流水线正在运行。
`--status` 检查最新运行成功、配置一致、未过期且确实是在线运行；离线验收结果不会冒充在线健康。
没有报告时状态检查返回失败，表示尚未运行，不会伪造成功状态。报告只写本地文件，不发送邮件或消息。
程序被强制杀死时内核锁自动释放；状态可能保留 `running`，重跑会建立新记录。

## 不联网的端到端验收

2026-10-28 的验收已用保存的真实来源完成整条流程：56 门课程、177 个班级，
其中 59 个教材入口、118 个未列出入口；自动回放与已验证的在线数据内容一致。
本次验收只更新独立测试目录，没有刷新正式在线快照。见
[流程验收记录](../data/sections/pipeline-validation.json)。另有流程测试覆盖
重复运行、并发锁、连接重试、异常保留旧数据、过期状态、多学科失败和中断。

用已有真实来源页面测试整条流水线，无需重复请求学校网站。创建捕获清单：

```json
{
  "BIO": {
    "pilot": "data/sections/.runs/2268-MAIN-BIO-1111/RUN_ID/capture.json",
    "subject": "data/sections/.runs/2268-MAIN-BIO/RUN_ID/capture.json"
  }
}
```

从已有提取报告的 `capturePath` 填入实际路径。复制配置并把 `outputDir` 改到单独的测试目录，执行：

```sh
npm run sections:sync -- --config PATH_TO_TEST_CONFIG.json --replay-captures PATH_TO_CAPTURES.json
```

程序自动完成预检、全量解析、再次回放、检查和测试快照更新；禁止离线验收覆盖在线快照。
日常在线运行无需捕获清单，直接 `npm run sections:sync` 即可。

```sh
python3 -m unittest discover -s test -p 'test_section_pipeline.py'
npm run check
npm run test:section-import # 隔离的真实 DynamoDB：重复导入、管理员修改、引用保护、拒绝无效快照
npm run test:browser        # Chromium / WebKit 验证导入后的学生页面
```

## 本阶段边界

流水线自动获取的是**课程班级和官方教材入口**，并未自动获取书名、ISBN、版本或价格，
已自动导入本地网站数据库。实际教材清单仍需要可持续使用的授权数据源。
相关来源规则见 [底层提取说明](section-extraction.md)。
