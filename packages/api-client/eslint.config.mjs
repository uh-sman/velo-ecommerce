import velo from "@velo/config/eslint/base";

export default [...velo, { ignores: ["node_modules/**", "src/schema.d.ts"] }];
