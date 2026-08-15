import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.preview/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
    },
  },
  {
    // INTERFACES.md §1 の境界を、文書ではなくビルドで守る。
    // curriculum/ が純粋であることは「DB も .env も無しに復習間隔を検証できる」
    // という性質そのもので、一度でも漏れると取り戻せない。
    files: ['src/curriculum/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/**', '**/config/**', '**/learning/**'],
              message:
                'curriculum/ は葉。now や requestRetention は引数で受け取ること（INTERFACES.md §1）。',
            },
          ],
        },
      ],
    },
  },
  {
    // repository は永続化だけ。学習理論を持ち込むと repository でなくなる。
    files: ['src/db/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/curriculum/**', '**/learning/**'],
              message:
                'db/ は curriculum/ に依存しない。組み合わせるのは learning/（INTERFACES.md §1）。',
            },
          ],
        },
      ],
    },
  },
  {
    // scripts/ は手で叩く CLI で、標準出力がそのまま UI になる。
    // アプリ本体で console を禁じているのは構造化ログに一本化するためで、
    // 進捗を出すのが仕事の道具にまでその禁を広げる理由は無い。
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
