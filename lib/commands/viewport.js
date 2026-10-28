import { fs, tempDir } from '@appium/support';

const commands = {};

function isValidXmlName(name) {
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name);
}

function sanitizeXmlName(name) {
  const raw = String(name ?? '');
  const replaced = raw.replace(/[^A-Za-z0-9_.:-]/g, '_');
  if (isValidXmlName(replaced)) {
    return replaced;
  }
  const prefixed = `node_${replaced}`;
  return isValidXmlName(prefixed) ? prefixed : 'node';
}

function escapeXmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildAttributesString(attributes) {
  if (!attributes || typeof attributes !== 'object') {
    return '';
  }
  const parts = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === '' || value === null || value === undefined) {
      continue;
    }
    const attrName = isValidXmlName(key) ? key : sanitizeXmlName(`attr_${key}`);
    parts.push(`${attrName}="${escapeXmlAttr(value)}"`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function appendNodeXml(node, out) {
  const attributes = node?.attributes ?? {};
  const rawTag = attributes.type || 'node';
  const tagName = sanitizeXmlName(rawTag);
  const attrs = buildAttributesString(attributes);
  const children = Array.isArray(node?.children) ? node.children : [];

  if (!children.length) {
    out.push(`<${tagName}${attrs}/>`);
    return;
  }

  out.push(`<${tagName}${attrs}>`);
  for (const child of children) {
    appendNodeXml(child, out);
  }
  out.push(`</${tagName}>`);
}

async function toXMLLayoutSafe(layoutJsonPath) {
  const raw = await fs.readFile(layoutJsonPath, 'utf8');
  try {
    const layout = JSON.parse(raw);
    const out = ['<hierarchy>'];
    appendNodeXml(layout, out);
    out.push('</hierarchy>');
    return out.join('');
  } catch (e) {
    return raw;
  }
}

/**
 * @this {HarmonyDriver & typeof commands}
 * @returns {Promise<string>} `xml content`
 */
commands.getPageSource = async function () {
  const localPath = await tempDir.path({ prefix: 'appium', suffix: '.tmp' });
  try {
    await this.driver.dumpLayout(localPath);
    if (!await fs.exists(localPath)) {
      throw new Error(`pull layout file failed! the local path '${localPath}' does not exist`);
    }
    this.log.info('get layout file content');
    return await toXMLLayoutSafe(localPath);
  } finally {
    if (await fs.exists(localPath)) {
      await fs.unlink(localPath);
    }
  }
};

/**
 * @this {HarmonyDriver & typeof commands}
 */
commands.getWindowRect = async function () {
  return this.getDisplaySize();
};

/**
 * @this {HarmonyDriver & typeof commands}
 */
commands.getWindowSize = async function () {
  return this.getDisplaySize();
};

export { commands };
export default commands;

/**
 * @typedef {import('../driver').HarmonyDriver } HarmonyDriver
 */
