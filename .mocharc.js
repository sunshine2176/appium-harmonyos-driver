module.exports = {
  require: ['ts-node/register'],
  spec: 'test/unit/**/*.spec.ts',
  forbidOnly: Boolean(process.env.CI)
};
