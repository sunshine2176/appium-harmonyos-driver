import { type Constraints } from '@appium/types';

const HARMONY_DRIVER_CONSTRAINTS = {
  app: {
    presence: false,
    isString: true
  },
  getDeviceLogs: {
    isBoolean: true,
  },
  getDeviceLogsToPath: {
    isString: true,
  },
  skipHilogCapture: {
    isBoolean: true,
  },
  // hypium-driver 透传 caps（UiDriver.connect 会读取并赋给 Device 实例）。
  // rpcTimeout 即 uitest RPC 守卫的限时；建议 120000–180000，需小于 Appium
  // 客户端的读超时（agent 侧 600s），否则命令失败前客户端先超时。
  rpcTimeout: {
    presence: false,
    isNumber: true,
  },
  hdcExecTimeout: {
    presence: false,
    isNumber: true,
  },
  implicitWaitTime: {
    presence: false,
    isNumber: true,
  },
  platformName: {
    isString: true,
    inclusionCaseInsensitive: ['Harmony', 'HarmonyOS'],
    presence: true,
  },
  deviceName: {
    isString: true,
  },
  appActivity: {
    isString: true,
  },
  appPackage: {
    isString: true,
  },
  chromedriverPort: {
    isNumber: true,
  },
  chromedriverPorts: {
    isArray: true,
  },
  chromedriverArgs: {
    isObject: true,
  },
  chromedriverExecutable: {
    isString: true,
  },
  chromedriverExecutableDir: {
    isString: true,
  },
  chromedriverChromeMappingFile: {
    isString: true,
  },
  chromedriverUseSystemExecutable: {
    isBoolean: true,
  },
  chromedriverDisableBuildCheck: {
    isBoolean: true,
  },
  chromeLoggingPrefs: {
    isObject: true,
  },
  autoWebviewTimeout: {
    isNumber: true,
  },
  waitForWebviewMs: {
    isNumber: true,
  },
  recreateChromeDriverSessions: {
    isBoolean: false,
  },
} as const satisfies Constraints;

export default HARMONY_DRIVER_CONSTRAINTS;
export type HarmonyDriverConstraints = typeof HARMONY_DRIVER_CONSTRAINTS;