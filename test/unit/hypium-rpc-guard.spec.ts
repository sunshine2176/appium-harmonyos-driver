import assert from 'node:assert';
import { Device } from 'hypium-driver/build/lib/device';
import { RPCError } from 'hypium-driver/build/lib/exceptions';
import { applyHypiumRpcGuard } from '../../lib/hypium-rpc-guard';

/**
 * hypium RPC 守卫单测。
 *
 * 直接 mock `Device.prototype.rpc` 为可控行为（在 patch 之前替换，守卫包装的
 * 即我们的 mock），再用 `Object.create(Device.prototype)` 构造免于私有字段的
 * 实例。不依赖 appium/support（守卫的 logger 由调用方注入）。
 */

type MockDevice = Device & {
  __rpcGuardLastResetAt?: number;
  rpcTimeout: number;
  resetRpc: () => Promise<void>;
};

type RpcBehavior = 'never' | 'fast' | 'reject';

describe('hypium rpc guard', function () {
  let warnings: string[];
  let rpcBehavior: RpcBehavior;
  let rpcCalls: string[];
  let resetCalls: number;

  before(function () {
    warnings = [];
    rpcCalls = [];
    resetCalls = 0;

    // 在 patch 前替换原始 rpc 为可控 mock
    Device.prototype.rpc = function (this: unknown, msg: string): Promise<string> {
      rpcCalls.push(msg);
      if (rpcBehavior === 'fast') {
        return Promise.resolve(`pong:${msg}`);
      }
      if (rpcBehavior === 'reject') {
        return Promise.reject(new RPCError('mock rpc failure'));
      }
      // 模拟设备端 uitest 假死：永不响应
      return new Promise<string>(() => {});
    };
    applyHypiumRpcGuard({ warn: (m: string) => warnings.push(m) });
  });

  beforeEach(function () {
    warnings = [];
    rpcCalls = [];
    resetCalls = 0;
    rpcBehavior = 'never';
  });

  function makeDevice(rpcTimeout: number): MockDevice {
    const dev = Object.create(Device.prototype) as MockDevice;
    dev.rpcTimeout = rpcTimeout;
    dev.resetRpc = async () => {
      resetCalls += 1;
    };
    return dev;
  }

  it('passes through a timely rpc response', async function () {
    rpcBehavior = 'fast';
    const dev = makeDevice(5000);
    assert.strictEqual(await dev.rpc('hello'), 'pong:hello');
    assert.deepStrictEqual(rpcCalls, ['hello']);
    assert.strictEqual(resetCalls, 0);
    assert.deepStrictEqual(warnings, []);
  });

  it('passes through an rpc rejection unchanged', async function () {
    rpcBehavior = 'reject';
    const dev = makeDevice(5000);
    await assert.rejects(
      dev.rpc('hello'),
      (e: unknown) => e instanceof RPCError && /mock rpc failure/.test((e as Error).message)
    );
    assert.strictEqual(resetCalls, 0);
    assert.deepStrictEqual(warnings, []);
  });

  it('rejects with RPCError when the channel never responds', async function () {
    const dev = makeDevice(80);
    const t0 = Date.now();
    await assert.rejects(
      dev.rpc('hello'),
      (e: unknown) => {
        assert.ok(e instanceof RPCError, 'rejection must be RPCError');
        assert.match((e as Error).message, /80ms/);
        return true;
      }
    );
    const elapsed = Date.now() - t0;
    // reject 应发生在 rpcTimeout（80ms）之后、且远早于 mocha 默认 2000ms 用例超时
    assert.ok(elapsed >= 70, `rejected too early (${elapsed}ms)`);
    assert.ok(elapsed < 2000, `rejected too late (${elapsed}ms)`);
    assert.deepStrictEqual(rpcCalls, ['hello']);
    assert.ok(warnings.some((w) => /no response/.test(w)));
  });

  it('triggers resetRpc once (debounced) for concurrent dead calls', async function () {
    const dev = makeDevice(60);
    const p1 = dev.rpc('one');
    const p2 = dev.rpc('two');
    await assert.rejects(p1, (e: unknown) => e instanceof RPCError);
    await assert.rejects(p2, (e: unknown) => e instanceof RPCError);
    assert.strictEqual(resetCalls, 1, 'resetRpc should fire exactly once per debounce window');
  });

  it('re-arms resetRpc after the debounce window', async function () {
    const dev = makeDevice(50);
    await assert.rejects(dev.rpc('first'), (e: unknown) => e instanceof RPCError);
    assert.strictEqual(resetCalls, 1);
    // 抹掉防抖标记，模拟防抖窗口已过
    delete dev.__rpcGuardLastResetAt;
    await assert.rejects(dev.rpc('second'), (e: unknown) => e instanceof RPCError);
    assert.strictEqual(resetCalls, 2);
  });

  it('is idempotent: applying twice does not double-wrap', function () {
    const wrapped = Device.prototype.rpc;
    applyHypiumRpcGuard({ warn: () => {} });
    assert.strictEqual(Device.prototype.rpc, wrapped);
  });

  it('falls back to the default timeout when rpcTimeout is not positive', function () {
    const dev = makeDevice(0);
    const p = dev.rpc('ping');
    assert.ok(p instanceof Promise);
    // 不真正等待默认 300s 超时；防御性兜底，避免悬挂 rejection
    p.catch(() => {});
  });
});
