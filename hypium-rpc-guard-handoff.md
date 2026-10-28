# 交接：在 appium-harmonyos-driver（自维护仓库）中实现 hypium RPC 超时保护

> 交接日期：2026-10-28 ｜ 来源：migutest 平台侧针对设备 23RVB24918009192（BLK-AL00）整夜超时故障的排查结论
> 所有代码级断言均在 hypium-driver@6.0.7210（npm 包解包）与 10.0.0.10 线上日志中逐一核实，可直接采信。

## 1. 任务

在我们自己维护的 appium-harmonyos-driver 仓库（fork 自 zhihu/appium-harmonyos-driver，上游已停更）里，给 hypium RPC 通道加**超时与自愈兜底**：设备端 uitest 假死时，命令必须限时失败并自动恢复通道，而不是永久挂死整个会话。

## 2. 问题描述（uitest 通道假死，线上实锤过一整夜）

### 2.1 调用链

```
Selenium/Appium 客户端（agent，600s HTTP 读超时）
  → HTTP → Appium server（每设备独立实例，端口 200xx）
    → appium-harmonyos-driver：HarmonyDriver（lib/driver.ts）
      → this.driver = hypium-driver 的 UiDriver 实例（createSession 里 UiDriver.connect(caps)）
        → UiComponent/UiDriver 各方法 → RpcClient.callUiTestRpc()
          → Device.rpc()  ←【唯一漏斗】TCP socket → hdc fport → localabstract:uitest_socket
            → 设备端 /system/bin/uitest 守护进程 + /data/local/tmp/agent.so
              → com.ohos.devicetest.hypiumApiHelper 模块（本次假死点）
```

### 2.2 故障时间线（2026-10-27 夜间，持续 11 小时+）

环境：设备 BLK-AL00 / HarmonyOS 6.1.0 / 设备端 uitest 6.0.2.3 / hypium-driver 6.0.7210 / hdc 3.2.0c / 驱动 v1.0.1（HEAD=025ddf9）/ macOS 15.2。

- `20:12:28.735` 执行 `mobile: clickGesture`（坐标 [348,1336]）：hypium-driver 打出 `[RpcClient] api: [Driver.click], params: [348,1336]` → `[Device] send request: {"module":"com.ohos.devicetest.hypiumApiHelper"...}`，**此后设备端再无任何回包**；
- `Device.rpcTimeout=300000`（5 分钟）**整夜未触发**：该实例 11 小时零条 `connection timeout` / `connection end` / `send request failed` 日志（同机另一台鸿蒙设备的实例这些日志正常输出）；
- 单条 click 的 Promise 永久 pending → Appium 按会话串行执行，后续所有命令（会话保活 getScreenOrientation、screenshot、OCR 链路）全部排队等死 → 客户端每条命令等满 600s 读超时 → 整夜 59 次 `[sessionGuard] 会话保活失败`、13 个用例失败，**会话从未自愈**；
- 期间 agent 每 5 秒一次的 `hdc shell hidumper` 整夜成功——设备是活的，只有 uitest RPC 通道死了；
- 设备端为何假死：另行报华为开发者工单（附完整日志时间线），宿主侧只负责兜底。

### 2.3 hypium-driver@6.0.7210 缺陷定位（build/lib/device.js，反混淆）

```js
async rpc(t) {
  if (this.rpcSock && !this.rpcSock.destroyed) {       // 连接复用
    s = this.rpcSock; s.removeAllListeners();
  } else {
    s = net.createConnection({ host, port, timeout: this.rpcTimeout }, ...);
  }
  s.write(t);
  s.on("data",  r => resolve(r));   // 只有 data 才 resolve
  s.on("error", e => reject(e));     // 只有 error 才 reject
  s.on("end",  () => LOG.info("connection end"));
  s.on("timeout", () => { LOG.info("connection timeout"); s.end(); });  // ← 只 end，不 reject！且实测该事件压根不触发
}
```

1. Promise 无"无响应"出路：'timeout' 处理器只 `s.end()`，不 reject；socket 超时事件实测不可靠（见 2.2）；
2. **恢复链其实存在但够不着**：`RpcClient.callUiTestRpc()` 的
   `catch (e) { if (e instanceof RPCError) yield this.resetUiTestRpc() }` → `Device.resetRpc()`
   （实现：`killall -9 uitest` + `rpcSock.end()` + `removeHistoryForward()` + `initFlag=false`；下次 `rpc()` 经 `initAgent()` 自动重推 agent.so、拉起 uitest、重建 fport）。
   链条设计完整——但 `Device.rpc()` 永不 reject，`RPCError` 永远抛不出，**这条链在"无响应"故障模式下不可达**。修复目标就是把它接通。

### 2.4 已核实、不要重复做的事

- **caps 已流通**：`UiDriver.connect(caps)` 会读取 `caps.rpcTimeout` / `caps.hdcExecTimeout` 赋给 Device 实例（`t.rpcTimeout = i.rpcTimeout`）。客户端传 `appium:rpcTimeout: 300000` 有效——问题不是没接上，是接上了也不工作；
- `Device` 不在 hypium-driver 的 index 导出里，但 package.json **无 `exports` 字段** → `require('hypium-driver/build/lib/device')` 可行；`RPCError` 在 `hypium-driver/build/lib/exceptions`；`UiDriver` 实例的 `.device` 属性即 Device 实例；
- `Device.resetRpc()` 全包仅一个调用方（`RpcClient.resetUiTestRpc()`，由 `callUiTestRpc` 的 catch 触发）。

## 3. 实现设计（推荐）

新增 `lib/hypium-rpc-guard.js`（或 .ts），在 `lib/driver.ts` 模块顶部 import 接线，对 `Device.prototype.rpc` 做一次性包装（幂等，防多实例重复 patch）：

```js
const { Device } = require('hypium-driver/build/lib/device');
const { RPCError } = require('hypium-driver/build/lib/exceptions');

const DEFAULT_RPC_TIMEOUT_MS = 300000;

export function applyHypiumRpcGuard(log) {
  if (Device.__rpcGuardApplied) return;
  Object.defineProperty(Device, '__rpcGuardApplied', { value: true });
  const origRpc = Device.prototype.rpc;
  Device.prototype.rpc = function (...args) {
    const timeoutMs = this.rpcTimeout || DEFAULT_RPC_TIMEOUT_MS;
    let timer;
    return Promise.race([
      origRpc.apply(this, args),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          log.warn(`uitest RPC no response in ${timeoutMs}ms, rejecting (channel dead)`);
          // 用 RPCError 让 hypium-driver 既有恢复链接管：
          // callUiTestRpc catch → resetUiTestRpc() → resetRpc()（killall uitest + 断socket + 清fport）
          // 如不放心可在此再主动 this.resetRpc().catch(()=>{})（重复 reset 无害，但建议加防抖）
          reject(new RPCError(`uitest RPC timed out after ${timeoutMs}ms (no response)`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  };
}
```

要点：

- **必须用 `RPCError` reject**（上层 catch 只认它）；恢复交给既有链，patch 保持最小；
- `Promise.race` 对落败 promise 的 rejection 会被视为已处理，无 unhandled rejection 问题；`finally` 清 timer 防泄漏；
- 并发场景：hilog 等可能并发调 `rpc()`，各自带 timer；首个超时触发 reset 后，其余 in-flight 请求会随 socket 关闭走 'error' 或自己的 timer 失败，可接受；
- **注意最坏耗时**：`callUiTestRpc` 失败后有 1 次重试，最坏 2 × rpcTimeout。客户端（agent）读超时 600s，若 rpcTimeout=300s 正好在临界值打架——建议部署侧把 `appium:rpcTimeout` 调到 120–180s，或在驱动里提供独立的守卫超时上限；
- `lib/constraints.ts` 补声明 `rpcTimeout`（isNumber, presence:false），顺带 `hdcExecTimeout` / `implicitWaitTime`，让 caps 校验正式化；
- `package.json` 把 `hypium-driver` 从 `^6.0.7201` **锁成精确版本**（guard 深度 require 其 build 内部路径，hypium-driver 升级时需复核 `device.js` 是否变化）。

## 4. 构建、部署、验证

### 4.1 构建与部署

- 构建：`npm run build`（tsc -b；源码 lib/ 为 TS+JS 混排、checkJs 已开，产物 build/，入口 ./build/index.js）；`npm run dev` 为 watch；
- 部署（测试机 10.0.0.10，ssh 别名 `10`，用户 apple；源码在 `/Users/apple/tools/appium-harmonyos-driver`，node v20.19.0）：构建后确认 Appium 实际加载路径（`~/.appium/node_modules/appium-harmonyos-driver` 还是源码目录本地安装），必要时 `appium driver install --source=local ...` / `appium driver update` 重装，并重启各 appium 实例（端口 200xx）。注意该机 SSH 时断时续，连不上先 ping；
- **仓库现状**：git HEAD `025ddf9`（= 上游最后提交 2025-12-24），工作区有 3 个未提交补丁（`javaclient/pom.xml`、`lib/commands/context/context.js`、`lib/commands/find.js`）——先单独 commit 存档，再动新改动；改仓库后以 git commit 为准，别再堆 zip 快照（目录里已有 20260423/20260427 两个 zip）。

### 4.2 验证

1. **单测**（repo 已有 mocha 配置 .mocharc.js，尚无 JS 测试）：mock 一个永不 resolve 的 `rpc`，断言限时 reject 且类型是 RPCError；resetRpc 调用与否；
2. **端到端确定性复现**：正常建会话后冻结设备端 uitest：
   `hdc -t <sn> shell kill -STOP $(hdc -t <sn> shell pidof uitest)`
   → 发一条 click → 预期 rpcTimeout 内命令返回错误（Appium 500），日志出现 `reset uitest rpc`；resetRpc 里 `killall -9 uitest` 会强杀被 STOP 的进程并重拉，下一条命令应自动恢复；
3. 回归正常用例（截图 / OCR / 点击 / 查找 / webview），确认 timer 不影响进程退出；
4. 观察日志：`[Device] [INFO] reset uitest rpc`、`send request failed`、驱动侧新增的超时 warn。

## 5. 边界

- 设备端 `hypiumApiHelper` **为什么**假死归华为（开发者工单另走，附了完整日志时间线）；
- 本仓库职责是"超时必失败、失败可自愈"，把整夜挂死降级为单命令失败；
- 可选：修完后给 zhihu 上游提个 PR 留档。

## 6. 附录：关键日志证据原文（已去除 ANSI 颜色码）

卡死瞬间（`agent.log.2026-10-27.96.gz`，20:12:28）：

```
2026-10-27 20:12:28.735 [bf2f6610][HarmonyDriver@06fc] Calling AppiumDriver.execute() with args: ["mobile: clickGesture", ...]
2026-10-27 20:12:28.735 [bf2f6610][HarmonyDriver@06fc] Executing native command 'mobile: clickGesture'
2026-10-27 20:12:28.735 [RpcClient] ##### api: [Driver.click], this: [Driver#0], params: [348,1336]
2026-10-27 20:12:28.735 [Device] [DEBUG] send request: {"module":"com.ohos.devicetest.hypiumApiHelper", ...   ← 此后再无该实例任何 Device 日志
```

客户端 600s 超时后 Appium 才补记响应（状态码为 `-`，即从未真正响应，`agent.log.2026-10-27.97.gz`）：

```
2026-10-27 20:22:28.730 ERROR [Thread-29] 执行异常
org.openqa.selenium.TimeoutException: java.util.concurrent.TimeoutException
  at org.openqa.selenium.remote.http.jdk.JdkHttpClient.execute(JdkHttpClient.java:422)
  ...
  Command: [bf2f6610-bfc9-4412-b618-ebf6b5410691, executeScript {args=[{x=348, y=1336}], script=mobile: clickGesture}]
2026-10-27 20:23:27.586 [HTTP] <-- GET /session/bf2f6610-bfc9-4412-b618-ebf6b5410691/orientation  - - ms - -
```

整夜循环（每个保活周期一条，共 59 次；`agent.log.2026-10-27.97.gz` ~ `2026-10-28.35.gz`）：

```
2026-10-27 20:23:27.576 WARN [pool-2-thread-1] com.migu.core.appium.AppiumSessionGuard : [sessionGuard][23RVB24918009192] 会话保活失败: java.util.concurrent.TimeoutException
```

证据文件索引（`/Users/apple/Desktop/agent-jar/log/`）：
- `agent.log.2026-10-27.96.gz` — 20:12 卡死现场
- `agent.log.2026-10-27.97.gz` — 第一批客户端超时堆栈
- `agent.log.2026-10-28.0.gz` ~ `35.gz` — 整夜循环（至 06:59，07:00 后仍持续到 08:55+）
