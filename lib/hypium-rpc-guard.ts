import { Device } from 'hypium-driver/build/lib/device';
import { RPCError } from 'hypium-driver/build/lib/exceptions';

/**
 * hypium-driver `Device.rpc()` 超时守卫。
 *
 * 背景：设备端 uitest 守护进程假死时（线上 2026-10-27 整夜故障，BLK-AL00），
 * `rpc()` 的 socket 既不回 `data` 也不触发 `error`；其 `timeout` 处理器只做
 * `socket.end()`、从不 settle Promise，且连接复用路径上该事件实测不触发。
 * 结果是单条命令的 Promise 永久 pending，Appium 会话按序执行，后续所有命令
 * 排队挂死，会话整夜无法自愈。
 *
 * 本守卫对 `Device.prototype.rpc` 做一次性幂等包装：
 * - 超时未收到任何响应时以 `RPCError` reject —— `RpcClient.callUiTestRpc()`
 *   的 catch 只认 `RPCError`，会自动走 `resetUiTestRpc()` → `Device.resetRpc()`
 *   （killall uitest + 断开 socket + 清理 fport + initFlag=false），下次
 *   `rpc()` 经 `initAgent()` 重推 agent.so、拉起 uitest、重建转发，通道自愈；
 * - 同时主动触发一次 `resetRpc()`（带防抖），覆盖不经 `callUiTestRpc` 的
 *   直接调用方（如 hilog 通道）——它们没有上层恢复链；
 * - 正常响应与错误原样透传，`finally` 清理 timer，`unref` 保证进程可退出。
 *
 * 注意：依赖 hypium-driver@6.0.7210 的内部模块路径（该包无 `exports` 限制，
 * 深层 require 可行）。升级 hypium-driver 时必须复核 `build/lib/device.js`
 * 的 `rpc`/`resetRpc`/`rpcTimeout` 是否仍然存在且语义不变。
 */

const DEFAULT_RPC_TIMEOUT_MS = 300000;
const RESET_DEBOUNCE_MS = 5000;

export interface RpcGuardLogger {
  warn(message: string): unknown;
}

export function applyHypiumRpcGuard(logger: RpcGuardLogger): void {
  const deviceCtor = Device as unknown as { __rpcGuardApplied?: boolean };
  if (deviceCtor.__rpcGuardApplied) {
    return;
  }
  const origRpc = Device.prototype.rpc;
  if (typeof origRpc !== 'function') {
    throw new Error(
      'hypium-driver Device.prototype.rpc is not a function; hypium RPC guard cannot be applied'
    );
  }

  Device.prototype.rpc = function (this: Device, msg: string): Promise<string> {
    const timeoutMs = this.rpcTimeout > 0 ? this.rpcTimeout : DEFAULT_RPC_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      origRpc.call(this, msg),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const self = this as Device & { __rpcGuardLastResetAt?: number };
          logger.warn(
            `uitest RPC received no response within ${timeoutMs}ms; ` +
              `rejecting the command and resetting the uitest rpc channel`
          );
          // 双保险：主动重置一次（防抖）。resetRpc 内部各步均走带超时的
          // hdc 命令，即使失败也不影响本次已发生的 reject。
          const now = Date.now();
          if (
            !self.__rpcGuardLastResetAt ||
            now - self.__rpcGuardLastResetAt > RESET_DEBOUNCE_MS
          ) {
            self.__rpcGuardLastResetAt = now;
            self.resetRpc().catch((e: unknown) => {
              logger.warn(`uitest RPC guard: device resetRpc() failed: ${e}`);
            });
          }
          reject(
            new RPCError(`uitest RPC timed out after ${timeoutMs}ms without any response`)
          );
        }, timeoutMs);
        timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
  };

  Object.defineProperty(deviceCtor, '__rpcGuardApplied', { value: true });
}
