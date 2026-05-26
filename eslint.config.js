import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'fetch() is only allowed inside src/http/client.ts. Use the HttpClient abstraction.',
        },
      ],
    },
  },
  {
    files: [
      'src/http/client.ts',
      'src/servicenow/auth/oauth-client-credentials-provider.ts',
      'src/servicenow/auth/index.ts',
    ],
    rules: { 'no-restricted-globals': 'off' },
  },
  prettier,
);
