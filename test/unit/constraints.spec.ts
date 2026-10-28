import assert from 'node:assert';
import { validator } from '@appium/base-driver/build/lib/basedriver/validation.js';
import HARMONY_DRIVER_CONSTRAINTS from '../../lib/constraints';

/**
 * caps 声明回归测试。
 *
 * Appium 3.x 的 presence 校验器对任意 presence 键（含 false）都会对值执行
 * lodash isEmpty；isEmpty(数字) 恒为 true，因此数字 caps 一旦声明 presence
 * 就会在会话创建时报 "'xxx' must not be empty or blank"（线上实测踩坑）。
 * 数字 caps 必须只写 isNumber —— 无 presence 键即表示可选。
 */

describe('harmony driver constraints', function () {
  // 只提取数字 caps 子集，避免 platformName 必填约束的干扰
  const numericCapsConstraints = {
    rpcTimeout: HARMONY_DRIVER_CONSTRAINTS.rpcTimeout,
    hdcExecTimeout: HARMONY_DRIVER_CONSTRAINTS.hdcExecTimeout,
    implicitWaitTime: HARMONY_DRIVER_CONSTRAINTS.implicitWaitTime,
  };

  it('accepts numeric hypium caps (rpcTimeout etc.) with values', function () {
    const caps = {
      rpcTimeout: 30000,
      hdcExecTimeout: 15000,
      implicitWaitTime: 5000,
    };
    assert.strictEqual(
      validator.validate(caps, numericCapsConstraints),
      null,
      'numeric caps must pass validation'
    );
  });

  it('treats numeric hypium caps as optional', function () {
    // 一个都不传也不报错
    assert.strictEqual(validator.validate({}, numericCapsConstraints), null);
  });

  it('rejects non-numeric rpcTimeout', function () {
    const result = validator.validate({ rpcTimeout: 'thirty-seconds' }, numericCapsConstraints);
    assert.ok(result, 'string rpcTimeout must be rejected');
    assert.ok(result.rpcTimeout.some((m: string) => /type/.test(m)));
  });

  it('guards against the presence-on-numeric-caps regression', function () {
    // 回归锚点：若有人把数字 cap 改回带 presence 键的写法，此用例立即失败
    for (const capName of ['rpcTimeout', 'hdcExecTimeout', 'implicitWaitTime']) {
      assert.strictEqual(
        'presence' in HARMONY_DRIVER_CONSTRAINTS[capName as keyof typeof HARMONY_DRIVER_CONSTRAINTS],
        false,
        `${capName} must not declare a presence constraint (Appium presence validator + numeric value = false "empty" positive)`
      );
    }
  });
});
