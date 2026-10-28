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

前置：正常创建一个会话（记 sessionId 与设备 sn）。

```bash
SN=23RVBXXXXXXXX   # 目标设备
# 1) 冻结设备端 uitest（模拟线上假死）
hdc -t $SN shell "kill -STOP $(hdc -t $SN shell pidof uitest | tr -d '\r')"

# 2) 发一条命令（如 mobile: clickGesture）→ 预期：
#    - 在 rpcTimeout（建议 caps 配 120000~180000）内返回 Appium 500，而不是永久挂死
#    - agent 客户端读超时（600s）之前就失败

# 3) 检查驱动日志：
#    - "uitest RPC received no response within ...ms"   ← guard 的 warn
#    - "[Device] [INFO] reset uitest rpc"               ← hypium-driver 恢复链
#    - "send request failed"                            ← rpc 内层 catch

# 4) 解冻（可选）或直接依赖 resetRpc 的 killall -9 uitest 强杀重拉
#    kill -STOP 的进程被 killall -9 强杀后，下一条命令应经 initAgent 自动恢复

# 5) 下一条命令（截图/点击）应恢复正常 → 通道自愈验证通过

# 6) 回归：正常跑一轮用例（截图 / OCR / 点击 / 查找 / webview），
#    确认 timer 不影响进程退出（实例可正常 stop）
```

## 4. 注意事项

- `appium:rpcTimeout` 建议调到 120000–180000：agent 客户端读超时 600s，若
  rpcTimeout=300000 正好打架（超时边缘上客户端先断，故障复现不干净）；
- guard 对 `Device.prototype.rpc` 的包装是进程级一次性的（幂等），多设备实例
  共享同一 patch，互不影响；
- 升级 hypium-driver 版本前必须复核 `build/lib/device.js` 的
  `rpc`/`resetRpc`/`rpcTimeout`（当前锁定 6.0.7210）；
- 现存 lint 报错为上游遗留（ESLint v9 要求 eslint.config.js，仓库还是
  .eslintrc.json），与 guard 无关，另行处理。
