import _ from 'lodash';
import { errors } from 'appium/driver';
import { BY, byExpression, MatchPattern, UiComponent } from 'hypium-driver';

const commands = {};

function parseSelectorWithMatchPattern(rawSelector) {
  const selector = _.toString(rawSelector);

  const regexpLike = /^\/([\s\S]*)\/([iI])?$/.exec(selector);
  if (regexpLike) {
    return {
      selector: regexpLike[1],
      matchPattern: regexpLike[2] ? MatchPattern.REGEXP_ICASE : MatchPattern.REGEXP,
    };
  }

  const prefixMatch = /^(eq|contains|starts|ends|re|rei):([\s\S]*)$/i.exec(selector);
  if (!prefixMatch) {
    return {selector};
  }

  const [, prefix, value] = prefixMatch;
  switch (prefix.toLowerCase()) {
    case 'eq':
      return {selector: value, matchPattern: MatchPattern.EQUALS};
    case 'contains':
      return {selector: value, matchPattern: MatchPattern.CONTAINS};
    case 'starts':
      return {selector: value, matchPattern: MatchPattern.STARTS_WITH};
    case 'ends':
      return {selector: value, matchPattern: MatchPattern.ENDS_WITH};
    case 're':
      return {selector: value, matchPattern: MatchPattern.REGEXP};
    case 'rei':
      return {selector: value, matchPattern: MatchPattern.REGEXP_ICASE};
    default:
      return {selector: value};
  }
}

/**
 * @this {HarmonyDriver}
 * @param {string} strategy
 * @param {string} selector
 * @param {boolean} mult
 * @param {string?} context
 * @returns {Promise<any>}
 */
commands.findElOrEls = async function (strategy, selector, mult, context) {
  const isXpathStrategy = strategy === 'xpath';
  let by;
  switch (strategy) {
    case 'id':
      {
        const parsed = parseSelectorWithMatchPattern(selector);
        by = _.isNumber(parsed.matchPattern) ? BY.id(parsed.selector, parsed.matchPattern) : BY.id(parsed.selector);
      }
      break;
    case 'key':
      {
        const parsed = parseSelectorWithMatchPattern(selector);
        by = _.isNumber(parsed.matchPattern)
          ? BY.key(parsed.selector, parsed.matchPattern)
          : BY.key(parsed.selector);
      }
      break;
    case 'text':
      {
        const parsed = parseSelectorWithMatchPattern(selector);
        by = _.isNumber(parsed.matchPattern)
          ? BY.text(parsed.selector, parsed.matchPattern)
          : BY.text(parsed.selector);
      }
      break;
    case 'type':
      {
        const parsed = parseSelectorWithMatchPattern(selector);
        by = _.isNumber(parsed.matchPattern)
          ? BY.type(parsed.selector, parsed.matchPattern)
          : BY.type(parsed.selector);
      }
      break;
    case 'xpath':
      by = BY.xpath(selector);
      break;
    case 'HypiumBy':
      by = byExpression(selector);
      break;
    default:
      break;
  }
  if (!by) {
    throw new Error('Must provide a selector when finding elements');
  }

  /**
   * @param {UiComponent} comp
   * @returns {Promise<string>}
   */
  const getComponentRef = async (comp) => {
    const ref = await comp.getRemoteRef();
    if (!ref) {
      this.log.error(`Get component reference error!`);
    }
    this.componentCache.set(ref, comp);
    // replace the component reference charactor '#' with charactor '_' when using in RESTful url
    // Example: Component#4 --> Component_4
    return ref.replace('#', '_');
  };

  let elementId;
  try {
    if (mult) {
      const elements = [];
      const components = await this.driver.findComponents(isXpathStrategy ? selector : by);
      for (const comp of components) {
        if (isXpathStrategy) {
          elementId = _.uniqueId();
          this.componentCache.set(elementId, comp);
        } else {
          elementId = await getComponentRef(comp);
        }
        elements.push({ 'ELEMENT': elementId });
      }
      return elements;
    } else {
      let component;
      if (isXpathStrategy) {
        component = await this.driver.findComponentByXpath(selector);
        if (!component) {
          throw new Error('find component failed!');
        }
        elementId = _.uniqueId();
        this.componentCache.set(elementId, component);
      } else {
        component = this.driver.findComponent(by);
        elementId = await getComponentRef(component);
      }
      return { 'ELEMENT': elementId };
    }
  } catch (err) {
    this.log.error(err);
    if (mult && err instanceof errors.NoSuchElementError) {
      return [];
    }
    throw new errors.NoSuchElementError(err);
  }
};

export { commands };
export default commands;

/**
 * @typedef {import('../driver').HarmonyDriver } HarmonyDriver
 */
