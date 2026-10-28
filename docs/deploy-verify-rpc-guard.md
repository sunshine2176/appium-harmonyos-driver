# hypium RPC guard 部署与验证 runbook

> 对应实现：`lib/hypium-rpc-guard.ts`（commit `42de9e3`）
> 背景与设计：见根目录 `hypium-rpc-guard-handoff.md`

## 1. 目标环境

| 项 | 值 |
| --- | --- |
| 测试机 | 10.0.0.10（ssh 别名 `10`，用户 apple，SSH 时断时续） |
| 源码目录 | `/Users/apple/tools/appium-harmonyos-driver` |
| node | v20.19.0 |
| Appium | 每设备独立实例，端口 200xx |
| 驱动仓库 remote | `git@github.com:sunshine2176/appium-harmonyos-driver.git`（fork） |

## 2. 部署步骤

```bash
# 1) 连通性（连不上先等，机器时断时续）
ping -c 3 10.0.0.10
ssh 10 true

# 2) 探明 Appium 实际加载的驱动路径（二选一，按结果执行第 5 步）
ssh 10 'ls -la ~/.appium/node_modules/appium-harmonyos-driver 2>/dev/null | head -3; appium driver list --installed 2>/dev/null'

# 3) 同步代码（远端 remote 指向 fork 时直接 pull；否则用 bundle）
ssh 10 'cd ~/tools/appium-harmonyos-driver && git fetch origin && git status --short && git log --oneline -1'
ssh 10 'cd ~/tools/appium-harmonyos-driver && git pull --ff-only origin main'
#   bundle 备选：
#   git bundle create /tmp/guard.bundle main && scp /tmp/guard.bundle 10:/tmp/
#   ssh 10 'cd ~/tools/appium-harmonyos-driver && git fetch /tmp/guard.bundle main && git merge --ff-only FETCH_HEAD'

# 4) 远程安装依赖 + 构建 + 单测
ssh 10 'cd ~/tools/appium-harmonyos-driver && npm install --no-audit --no-fund && npm run build && npm test'

# 5) 更新 Appium 加载的驱动
#    a. 若 Appium 加载的是 ~/.appium/node_modules 下的安装版：
ssh 10 'appium driver update harmonyos || appium driver install --source=local --driverName=harmonyos ~/tools/appium-harmonyos-driver'
#    b. 若 Appium 直接加载源码目录（npm link / 本地安装）：无需此步。

# 6) 重启 appium 实例（端口 200xx；重启前确认没有正在跑的会话！）
ssh 10 'ps aux | grep -i "appium" | grep -v grep'
#   逐实例重启（按实际管理方式：launchd/pm2/脚本），或整批：
#   ssh 10 'for p in $(pgrep -f "appium.*200"); do kill $p; done'  ← 确认后再执行
```

## 3. 端到端验证（确定性复现通道假死）

### 3.1 冻结法选择（2026-10-28 实测）

| 方法 | 结果 | 备注 |
| --- | --- | --- |
| `kill -STOP` 设备端 uitest | **不可行** | hdc shell（uid 2000, SELinux u:r:sh:s0）对 uitest 无 signal 权限，`Permission denied`；`resetRpc` 内 `killall -9 uitest` 同样无权，自愈只能靠宿主侧 socket/fport 重置 |
| pfctl 掐 fport 端口 | 不可行 | 需要 sudo（测试机 ssh 用户无免密 sudo） |
| **冻结宿主 hdcd 进程**（`kill -STOP <hdcd_pid>`，验证后 `kill -CONT`） | **可行，已验证** | rpc 的 write 进本地缓冲后无 data 无 error，精确复现"无响应"；hdcd 由 apple 用户启动（`hdc -m -s ::ffff:127.0.0.1:8710`），可 STOP/CONT。窗口内全设备 hdc 命令延迟，控制在 ~60s |

### 3.2 验证步骤（已验证通过）

```bash
# 0) 临时实例（symlink 安装，构建产物即刻生效；PATH 需含 /usr/local/bin 才能找到 hdc）
export PATH=$HOME/.nvm/versions/node/v20.19.0/bin:/usr/local/bin:$PATH
nohup appium -p 20099 --session-override --relaxed-security > /tmp/appium-20099.log 2>&1 &

# 1) 创建会话：必须带 newCommandTimeout，否则基线命令后 60s 空闲会话即被 Appium 自杀
#    caps: platformName=HarmonyOS, appium:deviceName=<SN>, appium:rpcTimeout=30000, appium:newCommandTimeout=300

# 2) 基线命令（orientation / screenshot）确认通道正常

# 3) kill -STOP <hdcd_pid> 后立即发命令：
#    预期 ~30s 后 guard 日志 "uitest RPC received no response within 30000ms"
#    → "reset uitest rpc"（guard 防抖 + callUiTestRpc catch 各一次）
#    → 命令在 rpcTimeout + hdcExecTimeout 内返回 Appium 500（不再是永久挂死）
#    → kill -CONT <hdcd_pid>

# 4) 恢复验证：第一条命令可能 ECONNRESET（过渡态），第二条起恢复正常（自愈完成）

# 5) 实测时间线（2026-10-28 13:47，rpcTimeout=30s）：
#    13:47:06 基线新连接 → 13:47:36 guard 超时 reject + reset ×2
#    → 13:47:48 重连 ECONNRESET → 下一条 screenshot 成功
```

## 4. 生产实例重启（关键实战结论）

- **agent（Java，agent-5.5.7.jar）不会自动重拉被 kill 的 appium 实例**——kill 后
  必须自己以原命令行重拉，否则服务下线；
- 实例重启闭环（已验证）：`ps -o command= -p <pid>` 取原命令行 → `kill` →
  `nohup <原命令> > /tmp/appium-<port>-restart.log 2>&1 &` → curl status 等待
  ready（约 3-10s）；
- 批量重启守则：逐个实例先查 `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED`，
  **有连接（活跃任务）的一律跳过**，等空闲再补；重启只影响该实例空闲窗口；
- 200xx 实例是通用的（iOS/Android/Harmony 共用），实例不重启就不加载新
  驱动代码；任何未来可能服务鸿蒙会话的实例都应完成重启；
- 设备端 `hdc -t <SN> shell pidof uitest` 为空 = 该设备无活跃鸿蒙会话，
  可安全重启相关实例。

## 5. 注意事项

- `appium:rpcTimeout` 建议调到 120000–180000：agent 客户端读超时 600s，若
  rpcTimeout=300000 正好打架（超时边缘上客户端先断，故障复现不干净）；
- guard 对 `Device.prototype.rpc` 的包装是进程级一次性的（幂等），多设备实例
  共享同一 patch，互不影响；
- 升级 hypium-driver 版本前必须复核 `build/lib/device.js` 的
  `rpc`/`resetRpc`/`rpcTimeout`（当前锁定 6.0.7210）；
- **数字 caps 不可声明 `presence` 键**（Appium 3.x presence 校验器对数字值
  会误报 "must not be empty or blank"，`presence: false` 也一样）——只写
  `isNumber` 即可选；`test/unit/constraints.spec.ts` 有回归锚点；
- 仓库无 lockfile（policy），依赖漂移已通过锁 hypium-driver=6.0.7210 与
  appium-chromedriver=8.4.22 消除；8.2.21 的 d.ts 会把 `capabilities` 标
  private 打爆 tsc（checkJs）；
- 测试机 npm 若报 `~/.npm` root 属主错误，加 `--cache /tmp/npm-cache-appium`
  绕开（本机同理，勿用 sudo chown）；
- 现存 lint 报错为上游遗留（ESLint v9 要求 eslint.config.js，仓库还是
  .eslintrc.json），与 guard 无关，另行处理；
- 远端仓库同步优先 `git pull fork main`；GitHub 连不上时用
  `git bundle create /tmp/x.bundle main && scp ... && git fetch /tmp/x.bundle main
  && git merge --ff-only FETCH_HEAD`。
