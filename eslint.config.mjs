import iobrokerEslintConfig from "@iobroker/eslint-config";

export default [
  ...iobrokerEslintConfig,
  {
    ignores: ["test/**", ".github/**"],
  },
];
