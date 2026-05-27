import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Only measure source code we own; exclude generated, test, and
      // top-level entry-point files (the dispatcher is shell-tested
      // via subprocess and won't be instrumented by v8 anyway).
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // dispatcher; covered by subprocess test only
        '**/*.d.ts',
      ],
      // No threshold enforcement yet — start by measuring. Add
      // thresholds later once the team has a target.
    },
  },
});
