import velo from "@velo/config/eslint/next";

export default [...velo, { ignores: [".next/**", "node_modules/**"] }];
