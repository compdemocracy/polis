// Standalone recordings: self-contained job-view jest config (no NODE_PATH, works with or without alpha node_modules).
const path = require('path');
const server = path.resolve(__dirname, '../server/node_modules');
const here = (m) => require.resolve(m, { paths: [__dirname] });
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'jsdom', collectCoverage: false,
  testMatch: ['**/src/data/__tests__/jobViews.recordings.test.jsx'],
  moduleNameMapper: {
    '\\.(css|less)$': '<rootDir>/jest.styleMock.cjs',
    '^react$': '<rootDir>/node_modules/react', '^react/(.*)$': '<rootDir>/node_modules/react/$1',
    '^react-dom$': '<rootDir>/node_modules/react-dom', '^react-dom/(.*)$': '<rootDir>/node_modules/react-dom/$1',
  },
  transform: {
    '^.+\\.tsx?$': [require.resolve('ts-jest', { paths: [server] }), { tsconfig: { target: 'ES2020', module: 'commonjs', jsx: 'react-jsx', esModuleInterop: true }, diagnostics: false }],
    '^.+\\.jsx?$': [here('babel-jest'), { configFile: false, babelrc: false, presets: [here('@babel/preset-env'), [here('@babel/preset-react'), { runtime: 'automatic' }]] }],
  },
};
